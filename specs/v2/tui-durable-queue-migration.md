# Queue durable V1-capable en TUI

Estado: implementación y validación focalizada terminadas; pendiente rollout manual  
Última actualización: 2026-09-13  
Propietario: OpenCode TUI / compatibilidad V1

> **Regla de compactación:** antes de crear o actualizar cualquier resumen de
> compactación de sesión, leer este documento,
> `specs/v2/v1-durable-queue-migration.md` y `specs/v2/todo.md`. El resumen
> debe declarar que se leyeron los tres documentos, conservar el estado, las
> notas, los bloqueos, las validaciones y el siguiente corte de este plan.
>
> **Referencia obligatoria:** `Engram #600 — Plan persistente V2 a V1 Queue`.

## Objetivo

Dar al TUI acceso a la Queue durable existente sin convertir un servidor V1 en
V2 ni cambiar el comportamiento de clientes legacy. En una sesión ocupada, un
prompt normal del TUI se admite en `session_input` cuando el servidor es V2 o
V1-capable; el TUI puede inspeccionar las entradas pendientes y recuperarlas
tras reconexión.

## Decisiones de este corte

| Decisión | Resolución |
| --- | --- |
| Activación | Un prompt normal hacia una sesión ocupada usa Queue durable sólo si el servidor es V2 o anuncia `durableSessionInput: 1`. Una sesión idle conserva el envío normal actual. |
| Compatibilidad | V1 sin capability conserva `sdk.client.session.prompt(...)` sin cambios. |
| V1-capable | La admisión usa `POST /api/session/:sessionID/prompt`, `delivery: "queue"` y `resume: false`. |
| V2 nativo | Usa el mismo inbox durable; no requiere capability V1. |
| Identidad | El TUI genera un `messageID` antes de enviar y lo retiene para reintentos idempotentes. |
| UI | La lista durable es de sólo lectura y reutiliza el binding existente `session_queued_prompts`; editar, cancelar, reordenar o promover manualmente siguen fuera de alcance. |
| Legacy interno | Shell, slash commands y los `promptAsync` de mover/warp workspace siguen usando sus rutas actuales. |
| Detección | El detector queda en TUI para evitar tocar los cambios concurrentes de App/SDK; debe probar el mismo contrato de health que App. |

## Diagnóstico inicial

- [x] **Mapear el envío actual.**  
  **Nota:** `packages/tui/src/component/prompt/index.tsx` llama al SDK legacy
  `session.prompt(...)`; no adjunta `delivery`, `resume` ni un ID durable.
- [x] **Confirmar contrato disponible.**  
  **Nota:** `@opencode-ai/sdk/v2` ya expone `v2.session.prompt(...)` y
  `v2.session.pendingInputs(...)`; no se debe regenerar el contrato para este
  corte.
- [x] **Confirmar ausencia de estado/UI durable.**  
  **Nota:** `Sync` sólo consulta `experimentalBackgroundSubagents`; el binding
  `session_queued_prompts` existe en keybinds, pero todavía no tiene handler.

## Fase 1 — Perfil de servidor y transporte

- [x] **Añadir detector de perfil TUI.**  
  **Nota:** `context/server-profile.ts` detecta `/global/health` antes de
  `/api/health`, conserva V1-capable como V1 y sólo acepta
  `durableSessionInput: 1`; las pruebas cubren V1-capable, capability malformada
  y V2 nativo.
- [x] **Crear frontera `DurableSessionInput`.**  
  **Nota:** `session-input/durable.ts` concentra serialización, admisión Queue
  (`delivery: "queue"`, `resume: false`) y lectura de pendientes; `SDK` crea y
  cachea el cliente V2 por workspace, conservando directory, fetch y headers.
- [x] **Preservar fallback legacy.**  
  **Nota:** el submit sólo usa Queue en una sesión existente ocupada cuando el
  perfil la soporta; V1 sin capability conserva la llamada legacy actual. La
  verificación de endpoint exacto queda incluida en la validación manual de
  rollout porque el fixture no renderiza el composer completo.

## Fase 2 — Serialización y submit idempotente

- [x] **Convertir partes TUI a `PromptInput` V2.**  
  **Nota:** texto, archivos y agentes se convierten a `PromptInput`; las partes
  de contexto del editor se materializan como texto. La prueba de transporte
  cubre el contrato resultante.
- [x] **Integrar Queue en `Prompt.submit`.**  
  **Nota:** para follow-ups ocupados, el prompt construido se admite antes de
  limpiar el composer y no crea mensaje optimista. El historial y el limpiado
  ocurren únicamente tras el ACK durable.
- [x] **Conservar el ID en errores transitorios.**  
  **Nota:** `queueAdmissions` indexa por sesión + snapshot de input y retiene
  el `messageID` si falla la petición; el siguiente submit reutiliza el mismo
  ID. La prueba verifica que dos admisiones del mismo ID mantienen el contrato
  idempotente.
- [x] **Excluir flujos legacy internos.**  
  **Nota:** shell, slash commands y creación de sesión se evalúan antes de la
  rama Queue; move/warp y `promptAsync` no fueron modificados.

## Fase 3 — Pendientes y experiencia TUI

- [x] **Mantener pendientes por sesión.**  
  **Nota:** `Sync.session_input` se refresca al bootstrap, entrada a sesión,
  admisión, reconnect, dispose de instancia y cambios de `session.status`.
- [x] **Mostrar Queue de sólo lectura.**  
  **Nota:** `session_queued_prompts` abre `DialogQueuedPrompts` en FIFO con
  secuencia y hora; el footer muestra `N queued`. No se añadieron acciones
  mutables.
- [x] **Aislar cambios de workspace/sesión.**  
  **Nota:** las respuestas se descartan si el workspace ya no es actual y el
  store se limpia al cambiarlo; el cliente V2 se cachea por workspace.

## Fase 4 — Pruebas y validación

- [x] **Probar perfil y fallback.**  
  **Nota:** `test/context/server-profile.test.ts` cubre V1-capable, valores
  malformados y V2; falta únicamente la comprobación manual HTTP exacta del
  fallback legacy descrita en rollout.
- [x] **Probar submit durable e idempotencia.**  
  **Nota:** `test/session-input/durable.test.ts` cubre serialización y los
  parámetros Queue con ID estable y `resume: false`.
- [x] **Probar estado/UI de pendientes.**  
  **Nota:** las pruebas cubren orden FIFO y fallback de adjunto del diálogo, y
  `Sync` recarga el inbox al cambiar de workspace sin conservar la respuesta
  anterior. La validación manual mantiene reconnect y navegación real como
  controles de rollout.
- [x] **Ejecutar validación focalizada.**  
  **Nota:** `bun run typecheck` pasó; 30 pruebas focalizadas de perfil,
  transporte, diálogo, carrera de submit y Sync pasaron en `packages/tui`.

## Criterios de aceptación

- Un TUI contra V1-capable o V2 admite un follow-up ocupado en la Queue
  durable con ID estable.
- Un TUI contra V1 antiguo conserva el flujo legacy sin rutas V2.
- La UI refleja pendientes FIFO y se recupera después de reconnect o cambio de
  instancia sin depender de una ventana concreta.
- Un retry después de perder la respuesta HTTP reutiliza el ID y no materializa
  dos mensajes.
- `/prompt_async`, shell, slash commands, `SessionGoal` y acciones mutables de
  Queue no cambian en este corte.

## Fuera de alcance

- Migrar una cola local de TUI: el TUI no mantiene un equivalente de
  `followup.v1` que migrar.
- Editar, cancelar, reordenar o promover manualmente entradas durables.
- Cambiar la semántica de `/prompt_async`.
- Habilitar por defecto `OPENCODE_EXPERIMENTAL_V1_DURABLE_SESSION_INPUT`.

## Validación manual de rollout

1. V1 sin flag/capability: comprobar que se conserva el envío legacy.
2. V1-capable con la flag activa: enviar un follow-up ocupado, abrir la lista,
   reconectar y verificar que se promueve una sola vez.
3. V2 nativo: repetir la admisión y la lectura de pendientes.
4. Cambiar de sesión y workspace mientras hay una petición pendiente; confirmar
   que no se cruzan estados.
