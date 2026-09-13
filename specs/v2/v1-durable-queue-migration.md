# Plan: bridge de Queue durable V2 para V1

Estado: aprobado para implementación
Última actualización: 2026-09-12
Propietario: OpenCode Session V2 / compatibilidad V1

> **Regla de compactación:** antes de crear o actualizar cualquier resumen de
> compactación de sesión, leer este documento y `specs/v2/todo.md`. Conservar
> en el resumen las decisiones, el estado de cada fase, bloqueos y el siguiente
> corte pendiente de este plan. Declarar que ambos documentos se leyeron para
> esa compactación.
>
> **Referencia obligatoria:** `Engram #600 — Plan persistente V2 a V1 Queue`

## Objetivo

Dar a servidores V1-capable la cola durable de V2 sin convertirlos en
servidores V2 ni romper clientes V1 existentes. Una App moderna conectada a
ese servidor debe admitir follow-ups en `session_input`, recuperarlos después
de reinicios y dejar que el servidor los promueva en orden FIFO cuando sea
seguro hacerlo.

El primer corte se limita a Queue. `SessionGoal`, secciones, edición,
cancelación y reordenamiento de entradas quedan fuera de alcance.

## Decisiones aprobadas

| Decisión            | Resolución                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Arquitectura        | Bridge V1-capable sobre los servicios durables V2; no reimplementación independiente de una tercera cola V1.                  |
| Detección           | V1 mantiene su protocolo; anuncia una capability aditiva `durableSessionInput: 1`.                                            |
| Clientes legacy     | `/prompt_async` y sus semánticas actuales permanecen sin cambios en este corte.                                               |
| App moderna         | Usa el transporte durable cuando el servidor V1 anuncia la capability; conserva fallback local sólo para servidores antiguos. |
| Datos `followup.v1` | Migración automática únicamente de entradas verificables; casos ambiguos requieren revisión del usuario.                      |
| Orden de trabajo    | Validar primero el puente `SessionInput` → runner V1; después backend, App, migración y rollout.                              |

## Arquitectura objetivo

```text
Cliente V1 antiguo
  └─ /prompt_async ───────────────► comportamiento legacy sin cambios

App moderna + servidor V1-capable
  ├─ GET /global/health ──────────► capabilities.durableSessionInput = 1
  ├─ POST /api/session/:id/prompt ► SessionInput.admit(..., delivery: "queue")
  ├─ GET  /api/session/:id/input  ► pendientes durables ordenados
  └─ eventos/refetch ─────────────► estado de admisión y promoción

Servidor V1-capable
  └─ bridge V1 ↔ SessionInput V2
       ├─ admisión transaccional e idempotente
       ├─ cola FIFO persistida
       ├─ promoción independiente de la ventana App
       └─ materialización segura hacia el runner V1
```

El health V1 debe recibir un campo opcional de capabilities; no se le añadirá
`pid` ni se intentará que `detectServerProtocol()` lo clasifique como V2. La
forma final debe ser versionable, por ejemplo:

```json
{
  "healthy": true,
  "capabilities": {
    "durableSessionInput": 1
  }
}
```

La App sólo usa las rutas V2 de `SessionInput` cuando esa capability está
presente. La firma exacta debe conservar el contrato generado existente, en
particular la admisión `POST /api/session/:sessionID/prompt` con `id`, `prompt`,
`delivery: "queue"` y `resume`.

## Fases de implementación

### Fase 0 — Spike y contrato de compatibilidad

1. Verificar que el `sessionID` V1 es compatible con `SessionInput` y que ambos
   flujos comparten el almacenamiento o disponen de un mapeo explícito.
2. Probar la ruta `legacy` de `SessionInput` contra un runner V1. Si no cubre
   la materialización necesaria, definir un adaptador pequeño
   `V1DurableQueueBridge` en vez de duplicar el modelo V2.
3. Añadir el schema opcional de capabilities al health V1 y una prueba de que
   clientes V1 antiguos ignoran el campo.
4. Escribir pruebas de integración de admisión, recuperación tras reinicio y
   entrega única antes de cambiar la App.

**Salida:** un servidor V1 de prueba admite una entrada durable y la recupera
después de reiniciar, sin que la App intervenga en su promoción.

### Fase 1 — Backend durable V1

1. Exponer la capability `durableSessionInput` desde el servidor V1.
2. Reutilizar `SessionInput.admit` para que el servidor persista una entrada
   antes de responder éxito.
3. Mantener la idempotencia por `messageID`:
   - mismo ID, sesión, prompt y delivery: devolver la admisión existente;
   - mismo ID con contenido distinto: conflicto explícito.
4. Añadir un bridge de promoción por sesión que:
   - preserve FIFO;
   - no dependa del renderer, navegación ni una ventana concreta;
   - respete permisos, preguntas y límites seguros del runner V1;
   - continúe drenando entradas admitidas tras un reinicio del sidecar.
5. Mantener `/prompt_async` sin redirigirlo a `queue` en esta entrega.
6. Publicar eventos de admisión, promoción y error, o traducirlos al stream
   V1 con refetch de recuperación al reconectar.

**Archivos candidatos:**

- `packages/core/src/session/input.ts`
- `packages/core/src/session/sql.ts`
- `packages/schema/src/session-input.ts`
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- `packages/protocol/src/groups/session.ts`
- `packages/server/src/handlers/session.ts`

**Salida:** una queue V1-capable sobrevive a reinicios, se materializa como
máximo una vez y conserva los clientes legacy.

### Fase 2 — Transporte y UI App

Crear una frontera explícita para evitar condicionales dispersos:

```text
QueueTransport
├─ DurableQueueTransport     // V1-capable o V2
└─ LegacyLocalQueueTransport // V1 remoto sin capability
```

1. Separar protocolo y capabilities en `server-protocol.ts` y
   `server-compat.ts`.
2. Para V1-capable, usar inputs pendientes del servidor y el dock de sólo
   lectura; desactivar el drain basado en `followup.v1`.
3. Limpiar el compositor y ejecutar el flujo normal de `onSubmit` sólo después
   de la confirmación durable de admisión.
4. Invalidar o refrescar entradas pendientes en eventos y reconnect.
5. Mantener el fallback local sólo cuando la capability no exista y no
   presentarlo como una garantía durable.

**Archivos candidatos:**

- `packages/app/src/utils/server-protocol.ts`
- `packages/app/src/utils/server-compat.ts`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/components/prompt-input/submit.ts`
- `packages/app/src/utils/persist.ts`
- `packages/app/src/utils/draft-store.ts`
- `packages/app/src/pages/session/composer/session-followup-dock.tsx`

**Salida:** una App moderna deja de usar la cola local al conectarse a V1-capable
y conserva el fallback para servidores V1 remotos antiguos.

### Fase 3 — Migración segura de `followup.v1`

Un elemento puede migrarse automáticamente sólo si:

- pertenece a la misma instancia y sesión;
- sigue pendiente y no está en un estado de envío ambiguo;
- el prompt valida contra el schema V2;
- sus adjuntos son serializables y siguen siendo accesibles;
- posee o puede derivar un `messageID` estable.

Algoritmo por cada entrada, procesado secuencialmente para preservar FIFO:

1. Guardar localmente un ID durable y `migration: "submitting"`.
2. Enviar la entrada al inbox durable con ese mismo ID.
3. Ante éxito, persistir `migration: "admitted"` y sólo entonces eliminar la
   copia local.
4. Ante caída o timeout, reintentar el mismo ID; el servidor absorbe el retry
   de manera idempotente.
5. Ante serialización fallida, adjunto inválido, sesión perdida, autorización
   fallida o estado de envío incierto, conservar el elemento como
   `needs-review`; nunca reenviar ni borrar silenciosamente.

**Salida:** las entradas verificables se migran sin duplicarse; los casos
ambiguos quedan visibles para recuperación, copia o eliminación manual.

### Fase 4 — Hardening y rollout

1. Corregir antes de exponer la capability el matcher CORS inseguro actual:
   `input.startsWith("oc://renderer")` debe sustituirse por coincidencia exacta
   del origen permitido y una prueba que rechace `oc://renderer.evil`.
2. Añadir feature flag de servidor para anunciar o admitir nuevos inputs V1
   durable.
3. El rollback puede ocultar la capability para nuevas admisiones, pero el
   worker debe continuar drenando entradas ya admitidas; nunca dejar filas
   durable atrapadas.
4. Probar primero Dev, luego Beta y, sólo después de observar estabilidad,
   habilitar por defecto para V1-capable.
5. Registrar métricas sin contenido de prompts: admisiones, promociones,
   conflictos idempotentes, recuperaciones y errores de materialización.

## Matriz de validación obligatoria

- Queue mientras la sesión está ocupada.
- Navegar desde la sesión A a B y entregar la entrada de A sin reabrirla.
- Reiniciar renderer o sidecar después de admitir una entrada.
- Dos ventanas sobre una sesión sin pérdida ni duplicación.
- Retry después de perder una respuesta HTTP usando el mismo `messageID`.
- Permisos o preguntas que impiden una promoción prematura.
- Migración FIFO de texto y adjuntos válidos desde `followup.v1`.
- Elementos ambiguos que quedan en revisión y no se reenvían.
- Cliente V1 antiguo que usa `/prompt_async` sin regresión.
- Reconnect que vuelve a consultar los inputs pendientes.
- CORS que permite sólo el origen renderer exacto y rechaza prefijos maliciosos.

## Criterios de aceptación

- La App moderna no usa `followup.v1` para nuevas entradas Queue contra V1-capable.
- Las entradas sobreviven a reinicio, navegación y ventanas múltiples.
- Una entrada se admite y materializa como máximo una vez.
- Los clientes V1 antiguos continúan funcionando sin cambios.
- La migración automática nunca borra ni reenvía entradas ambiguas.
- `SessionGoal` y acciones mutables de Queue siguen fuera de este corte.
- El matcher CORS se corrige antes de cualquier publicación.

## Fuera de alcance

- Portar `SessionGoal` a V1.
- Editar, cancelar, reordenar o promover manualmente una entrada durable.
- Cambiar la semántica de `/prompt_async`.
- Forzar la instalación del sidecar V2 o modificar `/Applications`.
- Reintentar automáticamente trabajo de proveedor ambiguo tras una caída.

## Referencias

- [Session Flow Roadmap](./session-flow-roadmap.md)
- [TODO V2](./todo.md)
- `packages/core/src/session/input.ts`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/utils/server-compat.ts`
