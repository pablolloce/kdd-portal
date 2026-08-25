# KDD Portal — contexto del proyecto para Claude

Extensión de VS Code «KDD Portal»: hub del área de **Tesorería de un banco**
para los equipos de sus aplicaciones tecnológicas. Estado actual: **v0.7.0,
100 % MOCK** — todo funciona con datos simulados para validar el estilo
visual; el backend real de Google Apps Script está escrito en `backend/`
pero la extensión aún no lo llama. Idioma del proyecto: **español**
(UI, comentarios, commits).

## Cómo se trabaja en este proyecto

- **Mock primero**: cada funcionalidad se implementa simulada (datos y
  latencias en `media/main.js` → `MockBackend`) y se valida visualmente
  antes de conectar nada real. No romper el modo mock.
- **Entrega**: al cambiar la extensión, subir la versión en `package.json`
  (la insignia del panel la muestra: «MODO DEMO · v0.X.Y» — así el usuario
  verifica qué build tiene instalada), compilar y empaquetar:
  `npm run compile && npx @vscode/vsce package --allow-missing-repository`.
- **Verificación**: harness headless en `test/` (Playwright + Chromium)
  que carga el HTML real del webview y comprueba todo el flujo. Ejecutarlo
  tras cada cambio de UI y revisar las capturas que genera. Ver
  `test/README.md`.
- El usuario instala la extensión por VSIX (sin npm en su máquina: su red
  corporativa intercepta TLS y `npm install` le falla).

## Mapa del código

```
src/extension.ts    Activación, comando kddPortal.open, vista de la barra de
                    actividad (viewsWelcome), auth mock, WebviewPanel y TODO
                    el HTML del webview (función getWebviewContent).
media/main.js       Lógica del webview (vanilla JS): MockBackend, capa api(),
                    navegación, renders. Sin frameworks.
media/main.css      Estilos con variables --vscode-* (se adapta a cualquier
                    tema). Regla global [hidden]{display:none !important}.
media/logo.svg      Logo «N» (cinta plegada) + icon.png 256px (manifest).
backend/*.gs        Apps Script real (un solo proyecto): router, config,
                    auth (login real, action=auth), chat, formaciones, kb,
                    tra. Ver cabecera de router.gs.
backend/instrucciones-kb-copilot.md  Prompt ad-hoc del chat de KB.
test/               Harness Playwright (build-test-html.mjs + test-webview.mjs).
```

## Estructura de la UI (decisiones de producto, no cambiar sin pedirlo)

- **Menú inicial** con 3 pestañas:
  1. **Equipos**: tarjetas de los 4 equipos → clic para entrar.
  2. **Calendario de formaciones**: mes completo del ÁREA (todas las
     formaciones de todos los equipos, chips con color por equipo, detalle
     del día, alta de formación a nombre del equipo del usuario).
  3. **Proyectos y personas**: réplica del informe TRA de Looker Studio
     (ver abajo).
- **Pantalla de equipo** (botón «← Menú» para volver):
  - **Knowledge Base es la PRIMERA pestaña** (y la activa por defecto);
    el **chat es la segunda** y al pulsarla salta un **modal de aviso**
    (una vez por equipo y sesión) que empuja a usar antes la KB — botón
    primario «Consultar la KB primero».
  - Formaciones del panel derecho: SOLO las de ese equipo.
- **Equipo del usuario**: lo indica el backend (`getUserInfo`, hoja
  "Usuarios"); se entra por defecto… no: se arranca en el MENÚ. Su equipo
  luce insignia «Tu equipo». María Dev (mock) → front-office.
- **Espacios de equipos ajenos**: banner amarillo en el chat (pide
  paciencia y usar su KB antes; las respuestas mock tardan 9–16 s frente a
  3–5 s en el propio) y KB «reducida» (banner, contador «4 de 11 docs»,
  etiqueta REDUCIDA y advertencia al pie de cada respuesta).
- **KB estilo Copilot**: respuestas con streaming, mini-markdown seguro,
  chips de fuentes clicables (→ notificación VS Code) y preguntas
  sugeridas por equipo.

## Pestaña «Proyectos y personas» (informe TRA)

Réplica del Looker Studio del usuario. Origen real: Google Sheets
`1gFNF-N5IXBwjTaUpH27BzhZ0fj-b1plkzkps1e68Vb0`, hoja `PORTAL`
(gid 1774358263), actualizado a diario. Columnas: `id, name, team,
sda_project_id, jira_issue_id, non_sda_project, time, description,
geography`. **`time` está en MINUTOS** (la UI divide entre 60; el total
real da 27.687,25 h). Sin SDATOOL → usar `non_sda_project` como proyecto
(ej. «Soporte usuarios»).

- KPI «Total de imputación» + donut top-4 SDATOOL + Otros (canvas, sin
  librerías) + tablas Personas y Proyectos.
- Filtros: Nombre, Equipo, Proyecto SDA, Feature JIRA + búsqueda libre +
  «Reestablecer»; clic en fila de tabla también filtra (toggle).
- **Información COMPLEMENTARIA**: sus equipos/personas NO son los 4 equipos
  del portal y no todo el área aparece — hay nota visible y no debe
  mezclarse con el modelo de equipos del portal.
- Botón «Abrir en Looker Studio ↗» (vscode.env.openExternal; el login de
  Google no funciona dentro de un webview, no intentar iframe).
- El mock usa nombres INVENTADOS a propósito (no meter los nombres reales
  del Excel en el repo); equipos/SDATOOLs/features sí son reales.

## Restricciones técnicas aprendidas (no re-descubrir)

- **CSP del webview sin `unsafe-inline`**: prohibidos los estilos inline
  (`style="…"`). Anchuras dinámicas → clases (`w-0…w-100`); gráficos →
  canvas; colores de tema en JS → `getComputedStyle` de las variables.
- `[hidden]` debe ganar a cualquier `display` de clase (regla global ya
  presente en main.css).
- vsce: los iconos del manifest deben ser PNG; SVG vale para la barra de
  actividad. Empaquetar con `--allow-missing-repository`.
- La extensión no tiene dependencias de runtime: `out/` precompilado
  permite F5 sin npm (launch «precompilada»).
- Escribir `̀-ͯ` escapado en regex de main.js (los caracteres
  combinantes literales se corrompen al editar).

## Modo real (v0.8.0: conmutable por ajustes, backend por desplegar)

- La extensión YA se conmuta sin recompilar, vía ajustes de VS Code:
  `kddPortal.modoMock` (default true), `kddPortal.appsScriptUrl`,
  `kddPortal.emailUsuario` (identidad mostrada ANTES de conectar y
  obligatoria para abrir el panel; VS Code no trae proveedor de auth de
  Google, así que no se usa `vscode.authentication`) y
  `kddPortal.nombreUsuario`. Insignia: «MODO DEMO»/«CONECTADO» +
  versión. Polling del chat: 3 s mock / 20 s real (cuotas GmailApp).
- **Checklist completo de despliegue en `backend/DESPLIEGUE.md`**
  (spreadsheet del portal + setup(), hoja Config/Usuarios/Sesiones, Web
  App, groups, carpetas KB de Drive, calendario, verificación con
  ?action=).
- **Login real (v0.10.0/v0.11.0, `backend/auth.gs` + botón «Conectar»)**:
  la Web App normalmente se despliega restringida al dominio («Cualquier
  usuario de tu dominio») — algunos Workspace corporativos ni siquiera
  ofrecen «Cualquier persona» como opción (el caso real de despliegue de
  este proyecto). El botón «Conectar» de la barra superior abre
  `action=auth` en el **navegador del sistema** (`vscode.env.openExternal`,
  no el panel); ese navegador SÍ lleva la sesión de Google, así que dentro
  del script `Session.getActiveUser().getEmail()` identifica a la persona
  de forma fiable. Se crea un token propio (hoja `Sesiones`,
  `CONFIG.SESSION_HOURS` = 24h) y una página redirige a
  `vscode://kdd-demo.kdd-portal/auth?data=…` (`registerUriHandler` en
  extension.ts, anti-replay con `state`).
  **Probado y confirmado que un `sessionToken` propio, por sí solo, NO
  basta** para las llamadas posteriores: la puerta de acceso por dominio
  la impone Google a nivel de transporte, antes de que el código de Apps
  Script llegue a ejecutarse — ni el `sessionToken` ni ningún parámetro
  propio la satisfacen, solo cookies de navegador real o un token OAuth
  real de Google. Por eso `action=auth` TAMBIÉN devuelve
  `ScriptApp.getOAuthToken()` (token real, pero de quien despliega el
  script, no de quien llama) como `sharedBearerToken`; el webview ya NO
  llama a Apps Script directamente (CSP `connect-src` es `'none'`) — se
  lo pide a la extensión por `postMessage` (`apiCall`/`apiResult`), y
  `callBackendReal` en extension.ts hace el `fetch` desde Node.js (sin
  CORS, así se puede mandar `Authorization: Bearer` sin que Apps Script
  necesite soportar *preflight*). `resolveEmail_` en el backend sigue
  siendo quien identifica a la persona real por su `sessionToken` — el
  Bearer solo abre la puerta de transporte, no decide identidad.
  **TRADE-OFF DELIBERADO, no un descuido**: es la credencial OAuth
  personal de quien despliega, compartida entre todos los que usen la
  extensión — se eligió así porque no hay acceso a Google Cloud Console
  para crear un cliente OAuth propio de la app. Caduca en ~1h sin
  refresco automático todavía (hay que volver a pulsar «Conectar»). Si
  esto pasa a usarlo más gente, migrar a un Client ID de OAuth propio
  (ámbito `openid email profile`, sin permisos de Drive/Sheets/Gmail:
  Apps Script sigue haciendo ese trabajo con su propia identidad) es la
  vía correcta — ver el aviso completo en `backend/DESPLIEGUE.md` 6ter.
- **Hito pendiente (KB-Copilot)**: la pestaña KB responde con el mock
  incluso en modo real. Falta: sincronizar la KB Drive→local
  (`getKbIndex`/`getKbFile` ya existen en el backend) y responder con
  `vscode.lm` (vendor 'copilot') usando
  `backend/instrucciones-kb-copilot.md`; sin Copilot, degradar a mock
  con aviso. Los contadores kbDocs de TEAMS pasarán a salir del índice
  real.

## Historia del repositorio

Los 12 primeros commits se desarrollaron en una sesión de Claude Code sin
permiso de escritura y llegaron a GitHub vía `git bundle` empujado por el
usuario desde su máquina (Windows, Git Bash). Desde entonces **`main` es
la rama por defecto (y única) del remoto**: trabajar y pushear
directamente sobre ella salvo que el usuario pida otra cosa.
