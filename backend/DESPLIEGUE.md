# Guía de despliegue — pasar KDD Portal de mock a real

Checklist completo para conectar la extensión con Google. Al terminar,
en VS Code solo hay que rellenar **dos ajustes** (no hace falta
recompilar nada): `kddPortal.appsScriptUrl` y `kddPortal.emailUsuario`,
desactivar `kddPortal.modoMock` y pulsar **«Conectar»** una vez dentro
del panel (login real, ver 6ter — necesario si la Web App está
desplegada con acceso por dominio, el caso recomendado).

---

## 1. Qué necesitamos en Google (resumen)

| Pieza | Cuántas | Para qué |
|---|---|---|
| **Spreadsheet «KDD Portal»** | 1 (nuevo) | Base de datos del portal: hojas `Config`, `Usuarios`, `Formaciones`, `Asistentes` (las crea `setup()`). |
| **Spreadsheet del informe TRA** | 1 (ya existe) | `1gFNF-N5IXBwjTaUpH27BzhZ0fj-b1plkzkps1e68Vb0`, hoja `PORTAL`. Solo lectura; `tra.gs` ya apunta a él. |
| **Proyecto de Apps Script** | 1 (nuevo) | Los 7 archivos de `backend/` desplegados como Web App. |
| **Google Groups** | 1 por equipo (4) | El «chat» de cada equipo (pueden ser groups ya existentes). |
| **Carpetas de Drive (KB)** | 1 por equipo (4) | Los documentos de la Knowledge Base de cada equipo. |
| **Calendario compartido** | 1 del área (opcional: 1 por equipo) | Los eventos de las formaciones. |

## 2. Spreadsheet «KDD Portal» (la BD del portal)

**Vía rápida (recomendada): importar la plantilla.** En
`backend/plantilla/kdd-portal-sheets.xlsx` está el spreadsheet ya
montado (4 hojas + hoja LEEME con instrucciones y celdas a rellenar en
amarillo). En Google Sheets: crear hoja de cálculo vacía → Archivo →
Importar → Subir → «Reemplazar hoja de cálculo». Con esta vía **no hace
falta ejecutar `setup()`** para las 4 hojas — ya existen — pero la
plantilla no trae la hoja `Sesiones` (se añadió después, para el login
del punto 6ter): ejecuta `setup()` una vez de todos modos, es aditivo y
no toca las hojas que ya existen. Copia el ID del spreadsheet (entre
`/d/` y `/edit` en la URL).

**Vía manual:** crea un Sheets vacío y deja que `setup()` (paso 3) cree
las hojas. En ambos casos, las dos hojas a rellenar a mano:

   **`Config`** — un equipo por fila (el corazón de la configuración).
   **Desde v0.9.0 la extensión lee los equipos de esta hoja**: añadir un
   equipo = añadir una fila, sin tocar código.

   | TeamId | Nombre | GroupEmail | KbDriveFolderId | CalendarId | Icono |
   |---|---|---|---|---|---|
   | `mi-equipo` | Mi Equipo (App) | grupo del equipo | ID carpeta Drive KB | vacío = usa el del área | emoji opcional |

   - `TeamId`: identificador corto sin espacios (minúsculas y guiones).
   - `CalendarId` vacío o placeholder → la formación se registra sin
     evento de calendario (no falla).
   - `Icono` (columna F, opcional): un emoji para las tarjetas del menú.

   **`Usuarios`** — quién pertenece a qué equipo (decide qué KB completa
   ve cada persona):

   | Email | Equipo |
   |---|---|
   | tu.email@tudominio.com | front-office |

   **`Formaciones`** y **`Asistentes`**: las rellena la aplicación, no
   tocarlas (solo mirar).

## 3. Proyecto de Apps Script (uno solo)

1. [script.google.com](https://script.google.com) → «Nuevo proyecto».
2. Crea un archivo por cada `.gs` de `backend/` y pega su contenido:
   - `router.gs` — doGet/doPost y tabla de acciones
   - `config.gs` — CONFIG + hojas Config/Usuarios + `setup()`
   - `auth.gs` — login real (`action=auth`) + hoja Sesiones (ver 6ter)
   - `chat.gs` — chat ↔ correo del Google Group (caché 15 s)
   - `formaciones.gs` — Sheets + Calendar + aviso al grupo
   - `kb.gs` — índice/descarga de la KB desde Drive
   - `tra.gs` — informe TRA (ya apunta al Sheets real)
3. Configuración del proyecto → activa «Mostrar el archivo de manifiesto
   appsscript.json» y pega el contenido de `backend/appsscript.json`
   (define los scopes OAuth: Sheets, Calendar, Gmail, Drive readonly).
4. En `config.gs` rellena `CONFIG.SPREADSHEET_ID` (paso 2) y
   `CONFIG.CALENDAR_ID` (ID del calendario del área; en Google Calendar:
   configuración del calendario → «ID de calendario»).
5. Ejecuta una vez la función **`setup()`** desde el editor (botón
   ▶ Ejecutar). La primera vez pedirá autorizar todos los permisos —
   acéptalos con la cuenta que vaya a «ejecutar» la Web App. `setup()`
   crea las 5 hojas (incluida `Sesiones`) con cabeceras y filas de
   ejemplo; es aditiva, no toca las que ya existan.
6. Rellena las hojas `Config` y `Usuarios` (paso 2).
7. **Implementar → Nueva implementación → Aplicación web**:
   - «Ejecutar como»: **tú** (la cuenta propietaria — sus permisos de
     Gmail/Drive/Calendar son los que usará el backend).
   - «Quién tiene acceso»: **Cualquier usuario de tu dominio**. El
     manifiesto de `backend/appsscript.json` ya trae `"access": "DOMAIN"`
     para que la implementación se proponga así por defecto. Si tu
     Workspace SÍ permite «Cualquier persona» y prefieres esa vía más
     simple, también funciona (ver 5bis) — pero no hace falta: el login
     del punto 6ter hace que el acceso por dominio funcione igual de
     bien, sin depender de que el admin habilite el acceso público.
   - Copia la **URL que termina en `/exec`**.

> Cada vez que cambies el código del proyecto: Implementar → Gestionar
> implementaciones → editar → «Nueva versión». La URL /exec no cambia.

## 4. Groups, Drive y Calendar

- **Groups**: un grupo por equipo (o reutilizar los existentes). La
  cuenta que ejecuta la Web App debe **ser miembro** (para leer los
  hilos con GmailApp) y **poder publicar** (para enviar). Apunta cada
  email de grupo en la hoja `Config`.
- **Drive (KB)**: una carpeta por equipo con la documentación (Google
  Docs, .md, .txt; subcarpetas permitidas). La cuenta ejecutora necesita
  al menos lectura. El **ID de carpeta** (lo que sigue a `/folders/` en
  la URL) va en `Config.KbDriveFolderId`.
- **Calendar**: un calendario compartido del área (o por equipo, columna
  `CalendarId`). La cuenta ejecutora necesita permiso «Hacer cambios en
  eventos».
- **Informe TRA**: la cuenta ejecutora necesita lectura del spreadsheet
  del informe.

## 5. Verificación del backend (antes de tocar VS Code)

Abre en el navegador (con tu sesión de Google):

```
<URL/exec>?action=ping                         → {"ok":true,"pong":"…"}
<URL/exec>?action=getUserInfo&email=TU_EMAIL   → {"ok":true,"team":"tu-team-id"}
<URL/exec>?action=getTeams                     → {"ok":true,"teams":[…]}
<URL/exec>?action=getFormaciones               → {"ok":true,"formaciones":[]}
<URL/exec>?action=getChat&team=front-office    → {"ok":true,"messages":[…]}
<URL/exec>?action=getKbIndex&team=front-office → {"ok":true,"files":[…]}
<URL/exec>?action=getTra                       → {"ok":true,"rows":[…]}
```

Si algo devuelve `{"ok":false,…}`, el campo `error` dice qué falta
(hoja sin crear, equipo sin configurar, permiso sin conceder…).

## 5bis. Acceso de la Web App: dominio vs «Cualquier persona» (+token)

**El detalle más importante del despliegue.** El webview de VS Code hace
`fetch` SIN tus cookies de Google (es un navegador aislado). Por tanto:

- Despliegue con acceso **«Cualquier usuario de tu dominio»** (URL tipo
  `script.google.com/a/macros/tudominio.com/...`): el navegador con tu
  sesión lo ve bien, pero un `fetch` anónimo del webview recibiría la
  página de login en vez de JSON. **Es el caso recomendado** — el login
  real del punto 6ter resuelve justo esto: la extensión abre `action=auth`
  en tu navegador de verdad (no en el webview) para el primer contacto, y
  a partir de ahí manda un token propio en cada llamada.
- Despliegue con acceso **«Cualquier persona»**: también funciona (el
  login es opcional en ese caso, pero no molesta tenerlo activo).
  Muchos Workspace corporativos no ofrecen esta opción en absoluto — no
  hace falta pedirla si usas el login.

**Prueba decisiva (30 s):** abre `<URL/exec>?action=ping` en una ventana
de **incógnito**. ¿JSON `{"ok":true,…}`? → confirma que el despliegue
responde. ¿Pantalla de login de Google? → normal con acceso por dominio
y sin sesión — es justo la situación que resuelve el login del webview
en un navegador CON sesión (punto 6ter), no algo que haya que arreglar
aquí.

**Activar el token compartido** (recomendado siempre, imprescindible si
despliegas con «Cualquier persona»):

1. En Apps Script: ⚙️ Configuración del proyecto → «Propiedades del
   script» → Añadir: propiedad `TOKEN_ACCESO`, valor una cadena larga
   aleatoria (p. ej. 30+ caracteres).
2. En VS Code: pega el mismo valor en el ajuste `kddPortal.tokenAcceso`.
3. Al verificar por navegador, añade `&token=EL_VALOR` a las URLs de
   prueba (incluido `action=auth`). Sin token válido el backend responde
   `{"ok":false,"error":"Token de acceso inválido o ausente"}` (y
   `action=auth` muestra una página de error equivalente en vez de JSON).

## 6. Conectar la extensión (sin recompilar)

En VS Code: `Ctrl+,` → busca **KDD Portal**:

1. `kddPortal.appsScriptUrl` → la URL `/exec`.
2. `kddPortal.emailUsuario` → tu email corporativo (debe estar en la
   hoja `Usuarios`).
3. `kddPortal.nombreUsuario` → opcional.
4. Desmarca `kddPortal.modoMock`.

Reabre el panel: la insignia pasará de «MODO DEMO · vX» a
**«CONECTADO · vX»**. El polling del chat baja a 20 s en real (cuotas
de GmailApp).

## 6bis. Arranque con UN solo equipo

Para el piloto basta con configurar `front-office` (o el equipo que
elijas, respetando su TeamId):

- Hoja `Config`: solo su fila con GroupEmail y KbDriveFolderId; deja las
  otras tres filas con TeamId/Nombre y el resto vacío.
- Hoja `Usuarios`: las personas del piloto, todas con ese equipo.
- Solo hace falta 1 Google Group y 1 carpeta de Drive.
- En la extensión seguirán viéndose los 4 equipos: en modo real, el chat
  de los no configurados mostrará «Sin conexión» (su KB sigue simulada).
  Es el comportamiento esperado del despliegue por fases; al incorporar
  cada equipo, basta con completar su fila en `Config`.

## 6ter. Conectar tu sesión (login real, v0.10.0)

Con la Web App desplegada como «Cualquier usuario de tu dominio» (5bis),
`kddPortal.emailUsuario` sigue siendo obligatorio para abrir el panel
(es la identidad que se muestra mientras no hay sesión), pero **las
llamadas al backend necesitan además una sesión verificada** — si no,
verás el mismo error de siempre («Failed to fetch» / «Error conectando
con el backend»).

1. Abre el panel con el modo real ya configurado (paso 6). Verás un
   botón **«Conectar»** en la barra superior.
2. Al pulsarlo se abre tu navegador del sistema (NO el panel) en
   `<URL/exec>?action=auth`. Como es tu navegador real, con tu sesión de
   Google ya iniciada, esta vez sí supera la puerta de acceso del
   dominio.
3. Dentro de Apps Script, `Session.getActiveUser().getEmail()` identifica
   tu cuenta de forma fiable (lo pone Google, no se puede falsificar
   desde el cliente) y la contrasta con la hoja `Usuarios`. Si todo
   cuadra, crea una fila en la hoja `Sesiones` (token aleatorio, válido
   `CONFIG.SESSION_HOURS` horas — 24 por defecto) y la página redirige
   de vuelta a VS Code (`vscode://kdd-demo.kdd-portal/auth?data=…`).
4. VS Code recibe ese enlace, guarda el token de sesión de forma
   cifrada (`context.secrets`, no en un ajuste) y el botón pasa a
   «✓ Conectado». A partir de aquí, todas las llamadas del webview
   llevan ese token y el backend resuelve tu email real con él —
   `kddPortal.emailUsuario` deja de usarse para las llamadas (sigue
   marcando qué se muestra ANTES de conectar).
5. La sesión caduca a las 24h: el botón «Conectar» reaparece y hay que
   repetir el paso 2 (no hace falta tocar ajustes ni reabrir el panel).

Si el navegador no vuelve solo a VS Code (algunos SO piden confirmar
«¿Abrir Visual Studio Code?» la primera vez), la página de resultado
también tiene un botón «Volver a VS Code» para pulsar a mano.

## 7. Knowledge Base real (v0.9.0): Drive → local + Copilot

En modo real la pestaña KB ya funciona de verdad:

1. **Sincronización**: al entrar en un equipo (o con «⟳ Sincronizar»),
   la extensión descarga su carpeta de Drive vía el backend
   (`getKbIndex`/`getKbFile`) a la carpeta local del ajuste
   `kddPortal.rutaKb` (vacío = almacén interno), una subcarpeta por
   equipo. Descarga incremental por fecha; los Google Docs se exportan
   a markdown.
2. **Respuestas con Copilot**: cada pregunta elige los documentos
   locales más relevantes y responde con `vscode.lm` en streaming.
   Modelo elegible con `kddPortal.modeloCopilot` (p. ej. `gpt-4o`,
   `claude`; vacío = primero disponible). Requiere la extensión
   **GitHub Copilot** con sesión iniciada (la primera llamada pide
   consentimiento).
3. Clic en una fuente citada → abre el documento local en el editor.
4. Si algo falla (sin Copilot, KB vacía, backend inaccesible) la
   respuesta muestra el motivo exacto.
