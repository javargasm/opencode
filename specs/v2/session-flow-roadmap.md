# Session Flow Roadmap

Estado: activo  
Última actualización: 2026-09-12  
Propietario: OpenCode Session V2

Este documento es el registro vivo del programa de flujo de sesiones. Se debe
actualizar en cada fase, junto con las decisiones, cambios de alcance,
validaciones y trabajo pendiente. No sustituye las especificaciones de
contratos; enlaza y resume las decisiones de producto que cruzan Core, Server,
App y TUI.

## Objetivo de producto

Hacer que una sesión larga sea predecible, retomable y visible: el usuario
puede declarar su objetivo, inspeccionar y ordenar el trabajo pendiente,
entender cuándo una sesión está bloqueada y retomar el flujo sin duplicar una
acción ya admitida.

La fuente de verdad para entradas pendientes es el inbox durable V2
`session_input`. La UI no debe crear otra cola con semántica distinta.

## Decisiones de alcance

| Decisión                                                    | Estado             | Motivo                                                                                                                             |
| ----------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Usar `SessionInput` V2 como cola canónica                   | Aceptada           | Ya preserva admisión idempotente, `steer`/`queue`, FIFO y recuperación del inbox.                                                  |
| No crear una tercera cola de follow-ups en App              | Aceptada           | La cola local actual es una compatibilidad de UI y diverge de la semántica durable.                                                |
| Introducir un objetivo estructurado por sesión              | Aceptada           | Los TODOs y el texto `## Objective` de compaction no representan una meta durable, consultable ni sincronizada.                    |
| Introducir secciones editables para sesiones                | Aceptada           | `parentID`, workspace, proyecto y archivado no sustituyen agrupaciones arbitrarias y ordenadas.                                    |
| Computer Use y grabación/replay                             | Fuera de alcance   | El usuario no los necesita; el coste de privacidad y permisos no compensa el valor actual.                                         |
| Remote control                                              | Fuera de alcance   | El usuario no lo necesita; no se ampliará el perímetro de dispositivos o red.                                                      |
| Control del Chrome principal del usuario mediante extensión | Backlog priorizado | Es útil para el usuario, pero se diseñará como una integración Chrome explícita y acotada, no como Computer Use ni remote control. |

## Bridge de compatibilidad V1

El corte de Queue durable para V1 está planificado, todavía no implementado.
Su contrato, fases, migración segura de `followup.v1`, validaciones y rollback
se mantienen en [Plan: bridge de Queue durable V2 para V1](./v1-durable-queue-migration.md).
Antes de modificar esta ruta se debe leer ese plan y el TODO asociado; el
primer corte excluye `SessionGoal` y acciones mutables de Queue. Toda
compactación debe citar `Engram #600 — Plan persistente V2 a V1 Queue`.

## Estado actual comprobado

### Cola de prompts

El core V2 ya implementa la semántica durable necesaria:

- `packages/schema/src/session-input.ts` define la admisión con entregas
  `steer`, `queue` y `legacy`.
- `packages/core/src/session/input.ts` admite entradas de forma idempotente y
  promueve una cola FIFO cuando la sesión quedaría inactiva.
- `packages/core/src/session/sql.ts` persiste `session_input` con secuencias de
  admisión y promoción.
- `packages/core/src/session/runner/llm.ts` consume el inbox en los límites
  seguros entre turnos.
- `packages/core/test/session-prompt.test.ts` y
  `packages/core/test/session-runner.test.ts` cubren admisión, FIFO y casos de
  interrupción.

Para servidores V2, la App consulta el inbox directamente desde
`packages/app/src/pages/session.tsx` mediante
`client.v2.session.pendingInputs`; no mantiene una segunda cola local ni
reenvía borradores para ese protocolo. Los servidores V1 conservan
temporalmente `followup.v1` como compatibilidad de UI, pero no es una fuente
canónica ni ofrece las garantías de admisión, recuperación e idempotencia de
`session_input`. El selector de comportamiento de follow-up en Ajustes >
General conserva explícitamente `queue` o `steer` y la sesión muestra el modo
`Queue` mientras está activo. Cuando una sesión raíz V2 está ocupada y el
ajuste es `queue`, el compositor admite el prompt con `delivery: "queue"`
antes de limpiar el borrador. Los comandos slash reconocidos y la ruta shell
conservan sus rutas de compatibilidad.

El dock muestra únicamente las entradas pendientes durables y su entrega
`Ahora`/`Después`; no puede enviarlas, editarlas, cancelarlas ni reordenarlas.
La App invalida sus queries al reconectar y ante los eventos V2 de admisión,
promoción/materialización legacy y actualización de objetivo.

### Objetivos y TODOs

`SessionTodo` y `TodoTable` son una lista de tareas del agente. Son útiles para
progreso, pero no son el objetivo de la sesión. Compaction conserva un bloque
textual `## Objective`; tampoco es un contrato durable. La Fase 1 añadirá un
modelo `SessionGoal` distinto, con una relación uno-a-uno opcional con la
sesión.

El corte inicial de `SessionGoal` no añade presupuesto: sin una unidad,
consumidor o efecto de ejecución definido, sería sólo un campo ambiguo. El
objetivo se conserva como estado de producto durable, aparece en historial y
eventos, pero no se convierte en mensaje de transcript ni en contexto del
modelo. Las escrituras distintas son last-write-wins; un reintento secuencial
idéntico no emite otro evento ni modifica `updatedAt`.

### Organización de sesiones

Las sesiones ya tienen proyecto, workspace, `parentID` y archivado. No existe
una tabla ni API para secciones arbitrarias, ordenables y visibles al usuario.

## Fase 1 — Flujo canónico de sesión

### Resultado esperado

Un usuario puede:

1. establecer o actualizar el objetivo de una sesión;
2. enviar trabajo para ahora (`steer`) o después (`queue`);
3. ver el trabajo durable pendiente, su orden y su estado;
4. cancelar o reordenar trabajo pendiente sin enviar un prompt duplicado;
5. agrupar sesiones raíz en secciones persistentes;
6. retomar una sesión después de una interrupción sin que entradas admitidas se
   pierdan ni se reejecuten silenciosamente.

### Corte 1A — Contrato y núcleo durable

- [x] Definir `SessionGoal` en Schema como dato serializable actual, separado de
      `SessionTodo`.
- [x] Definir estados cerrados de objetivo: inicialmente `active`, `paused`,
      `blocked` y `complete`.
- [x] Incluir campos mínimos: `sessionID`, `objective`, `status`, `updatedAt` y
      un `reason` opcional para bloqueo o cierre. Presupuestos y métricas se
      evaluarán sólo cuando tengan consumidor concreto.
- [x] Añadir evento durable, proyección SQL, servicio Core y lectura/escritura
      idempotente para el objetivo.
- [x] Exponer la operación mediante el contrato HttpApi actual y SDK generado;
      no añadir otra ruta legacy.
- [x] Exponer una lectura de entradas `session_input` pendientes para clientes
      V2. La respuesta debe distinguir `steer` de `queue`, conservar
      `admittedSeq` y no presentar una entrada promovida como pendiente. Se expuso
      como `GET /api/session/:sessionID/input`; es sólo lectura y no altera la
      promoción del Runner, FIFO ni la cola legacy de App.
- [ ] Diseñar cancelación y reordenamiento como una extensión explícita del
      inbox V2; no simularlos borrando mensajes de historial.

### Corte 1B — App y TUI canónicas

- [x] Reemplazar el almacenamiento `followup` de App por consultas y mutaciones
      del inbox V2.
- [x] Mostrar un panel compacto de `Objetivo`, `Ahora`, `Después` y
      `Bloqueado`; todos los textos visibles se añadirán mediante i18n.
- [x] Mostrar la cola desde datos durables, no sólo desde estado local.
- [ ] Añadir acciones de editar/reordenar/cancelar únicamente cuando el
      contrato core las haga atómicas y recuperables. La App no simula estas
      acciones mientras el contrato no exista.
- [ ] Alinear la experiencia TUI con la misma API y semántica; no implementar
      un modelo TUI independiente.

### Corte 1C — Secciones de sesión

- [ ] Añadir modelo de sección persistente y membresía ordenada de sesiones.
- [ ] Permitir crear, renombrar, reordenar, mover y retirar sesiones de una
      sección.
- [ ] Mantener las secciones independientes de subagentes, `parentID`, proyecto
      y archivado.
- [ ] Exponerlas mediante la API actual antes de construir controles de UI.

## Invariantes de Fase 1

1. Una entrada V2 con el mismo `messageID`, sesión, prompt y entrega se
   reconcilia de forma idempotente; un conflicto debe fallar.
2. `queue` sólo promueve una entrada cuando la sesión quedaría inactiva;
   `steer` se promueve en un límite seguro del turno actual.
3. Los datos pendientes sobreviven una interrupción del proceso; la recuperación
   no asume que trabajo ambiguo del proveedor sea seguro de reintentar.
4. Una pregunta o permiso pendiente no puede hacerse invisible por una acción
   de cola posterior.
5. El objetivo nunca sustituye instrucciones de sistema, permisos ni reglas de
   proyecto; es estado de producto y contexto explícito de sesión.
6. Las secciones no alteran permisos, directorio, worktree ni identidad de una
   sesión.
7. App y TUI leen la misma fuente durable para objetivos, cola y secciones.

## Validación requerida

Antes de cambiar código de sesión o timeline, registrar una línea base de los
benchmarks de App indicados en `packages/app/e2e/performance/README.md`. Tras
cada corte que cambie App o timeline, comparar el resultado y conservar los
artefactos de diagnóstico relevantes.

La validación posterior del Corte 1B se completó el 2026-09-12 con
`OPENCODE_PERFORMANCE_TRACE_DIR=/tmp/opencode-phase1-1b bunx playwright test --config e2e/performance/playwright.config.ts timeline/session-tab-switch-benchmark.spec.ts`:
2/2 escenarios pasaron. Las medianas de estabilidad fueron 48.5 ms en frío y
14.8 ms en caliente para el cambio de pestaña base; para V2 fueron 51.9/22 ms
con el panel de revisión cerrado y 48.7/22.9 ms con él abierto. No hubo muestras
en blanco, de destino incorrecto ni de host de revisión reemplazado. Las trazas
de diagnóstico locales se conservaron en `/tmp/opencode-phase1-1b`.

Cada corte debe incluir, como mínimo:

- pruebas unitarias de esquema y servicio;
- pruebas de persistencia/proyección y reintento idempotente;
- pruebas de integración HTTP/SDK cuando cambie el contrato público;
- pruebas de UI para los estados pendiente, bloqueado, vacío y recuperación;
- `typecheck` y pruebas focalizadas de los paquetes cambiados;
- `git diff --check`.

Validación de los cortes de inbox y objetivo (2026-09-12): las pruebas
focalizadas de Core, las suites completas de Schema y Client, los manifiestos
públicos de `opencode`, los typechecks de Schema/Core/Protocol/Server/Client y
las migraciones verificadas pasaron. Los clientes generados son estables tras
regenerar. Se corrigió además la expectativa desactualizada de
`session.legacy_prompt.materialized` en el test de manifiesto legacy.

No se realizará recuperación automática de intentos de proveedor ambiguos como
parte de esta fase; esa política ya está explícitamente diferida en
`specs/v2/session.md`.

## Track futuro priorizado — Integración Chrome del usuario

### Estado comprobado

El `HEAD` actual no contiene una extensión Chrome, Native Messaging, APIs
`chrome.*`, un cliente CDP para Chrome externo ni un MCP que controle el
navegador del usuario. `packages/opencode/src/mcp/browser.ts` abre URLs de
OAuth en el navegador predeterminado; no adjunta pestañas ni perfiles. El
Chromium de Electron y su puerto de depuración de desarrollo pertenecen a
OpenCode, no al Chrome principal del usuario.

Existen referencias locales divergentes de un browser embebido en Electron que
son útiles como inspiración para contratos tipados, ciclos de vida y
revalidación de permisos, pero no se deben integrar mediante un cherry-pick
masivo: no controlan Chrome externo y contienen proxy/túnel/red que queda fuera
del alcance de esta integración.

### Decisión de arquitectura

El control del Chrome principal del usuario se tratará como una integración
first-party e independiente, provisionalmente denominada `opencode.chrome`:

```text
Plugin OpenCode -> Desktop -> Native Messaging host local firmado
  -> extensión Chrome MV3 -> content script de la pestaña adjunta
```

No se usará CDP remoto, `--remote-debugging-port`, un WebSocket expuesto a la
red ni un MCP genérico como frontera de seguridad. El host nativo sólo aceptará
el ID de la extensión distribuida y el navegador conservará su propia red y
perfil.

### MVP propuesto

1. El usuario instala la extensión y pulsa **Conectar esta pestaña**.
2. La extensión concede acceso sólo a esa pestaña y origen mediante `activeTab`
   o permisos de host explícitos; no solicita `<all_urls>`, cookies ni inventario
   global de pestañas.
3. OpenCode recibe un identificador opaco de pestaña/documento/generación y un
   snapshot semántico del frame principal: URL, título y DOM/accesibilidad
   acotados.
4. Las primeras operaciones son `browser.observe`, `browser.navigate` y
   `browser.interact`, con permisos separados por origen, pestaña y acción.
5. Navegar, rellenar o hacer click exige confirmación local de la acción exacta;
   observar no autoriza interacción ni transmisión adicional.
6. Un cambio de origen, cierre de pestaña, reinicio o desconexión revoca el
   grant. No hay reconexión ni reanudación automática.

### Límites no negociables del MVP

- No cookies, contraseñas, almacenamiento de navegador, perfil completo,
  historial, screenshots, vídeo, trazas, heap, tráfico, headers ni cuerpos de
  red.
- No `evaluate` arbitrario, `chrome.debugger`, iframes cross-origin,
  `chrome://`, `file://`, `chrome-extension://`, uploads, downloads, clipboard,
  autenticación ni envío de formularios.
- Todo texto de una página se trata como datos no confiables, nunca como una
  instrucción para el agente.
- El consentimiento muestra origen, título, pestaña, acción solicitada y datos
  que podrían enviarse al modelo/proveedor. Debe existir una acción global de
  desconectar/revocar.
- No background automation, control desde clientes remotos, Computer Use ni
  record/replay.

### Reutilización y dependencias

Se pueden reutilizar la carga de plugins, el modelo de permisos de OpenCode y
los patrones de aislamiento de Electron (`contextIsolation`, preload limitado e
IPC concentrado). El permiso MCP genérico actual no es suficientemente granular
para esta integración; se necesita una capacidad específica que revalide
origen, pestaña, documento y generación justo antes de ejecutar una acción.

Estimación inicial para un MVP sólo macOS: 8–11 persona-semanas, incluyendo
threat model, MV3, host Native Messaging, empaquetado, permisos, UI y pruebas
de ciclo de vida. Windows/Linux requerirán trabajo adicional de instalación,
firma y host nativo.

- conexión explícita mediante extensión instalada por el usuario;
- selección explícita de navegador/pestaña o de un conjunto de orígenes;
- visibilidad de la pestaña y acción solicitada antes de efectos externos;
- permisos por origen y por tipo de acción, con revocación inmediata;
- sin captura continua de pantalla, historial o grabación;
- sin acceso implícito a contraseñas, cookies, almacenamiento del navegador ni
  perfiles completos;
- sin convertir la integración en remote control ni Computer Use.

La decisión de arquitectura, extensión, protocolo local y modelo de permisos
se añadirá aquí después de una auditoría específica del stack de plugins/MCP de
OpenCode.

## Registro de actualizaciones

| Fecha      | Fase/corte                   | Cambio                                                                                                                                                                                                                                                             | Validación                                                                                                                                                                                         |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-12 | Inicio                       | Se creó el roadmap vivo; se fijó `session_input` V2 como cola canónica y se excluyeron Computer Use, grabación y remote control.                                                                                                                                   | Auditoría estática de Core, App, TUI y documentación V2.                                                                                                                                           |
| 2026-09-12 | Validación de línea base     | Se intentó el benchmark de cambio de pestañas antes de cambios de sesión/UI.                                                                                                                                                                                       | Bloqueado: falta el ejecutable `chromium_headless_shell-1217` esperado por Playwright. El instalador agotó el tiempo después de descargar, sin dejar ese ejecutable disponible.                    |
| 2026-09-12 | Chrome del usuario           | Se completó la auditoría y se eligió MV3 + Native Messaging local, con consentimiento granular, como arquitectura futura.                                                                                                                                          | Auditoría estática: no existe integración actual; se registraron límites de seguridad y no-alcance.                                                                                                |
| 2026-09-12 | Corte 1A — snapshot de inbox | Se añadió `SessionInput.Pending`, `SessionInput.listPending`, `SessionV2.pendingInputs` y `GET /api/session/:sessionID/input`; la lectura filtra entradas promovidas y legacy, y conserva el orden `admittedSeq`.                                                  | Core focalizado, Schema y Client completos, typechecks de Schema/Core/Protocol/Server/Client y generación estable.                                                                                 |
| 2026-09-12 | Corte 1A — objetivo durable  | Se añadió `SessionGoal`, evento durable `session.next.goal.updated`, proyección `session_goal`, migración y `GET`/`PUT /api/session/:sessionID/goal`. El objetivo no entra al transcript ni contexto del modelo.                                                   | Migración verificada, pruebas de servicio/historial/no-op, Schema y Client completos, manifiestos de `opencode`, typechecks y generación estable.                                                  |
| 2026-09-12 | Corte 1B — App durable       | La App sustituyó `followup.v1` por queries V2 de inbox/objetivo, admite cola durable antes de limpiar el compositor, muestra el dock de sólo lectura y añadió el panel de objetivo. No se añadieron acciones de edición, promoción, cancelación ni reordenamiento. | Typechecks de App/Protocol/SDK/Client, pruebas focalizadas App/Core/Client, build App, `git diff --check`, generación estable de Client y benchmark App 2/2 (trazas en `/tmp/opencode-phase1-1b`). |
| 2026-09-12 | Desktop V2 packaging          | Dev y Nix Desktop compilan el CLI V2 desde el checkout, lo empaquetan como recurso y arrancan V2 de forma explícita; health expone `pid` para la detección y el servidor permite CORS de `oc://renderer`. V1 queda como escape explícito o compatibilidad remota. | Pasaron typechecks de Protocol, Server, CLI, Desktop, App, Client y SDK; pruebas focalizadas de Desktop/App/Client; smoke del daemon, health/CORS y arranque de un `.app` macOS aislado con `sidecar connection started { version: 'v2' }`. No se reemplazó la app instalada. La evaluación Nix queda pendiente porque `nix` no está instalado; no se alteró el cierre fijo de dependencias porque el CLI usa el mismo cierre ya requerido por `packages/opencode`. |
