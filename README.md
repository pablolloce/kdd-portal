# KDD Portal · Área de Tesorería — Extensión de VS Code (versión DEMO)

Hub para los equipos de las aplicaciones tecnológicas del área de Tesorería
de un banco: **chat por equipo** (Google Grupos), **formaciones del área**
(Google Calendar + Sheets) y **Knowledge Base** por equipo (Copilot + ruta
local), renderizado en un Webview que se integra con el tema del editor.

> 🧪 **Estado actual: MODO MOCK.** Toda la interfaz funciona con datos
> simulados (usuario ficticio, compañeros que responden solos, formaciones de
> ejemplo) para poder **probar el estilo visual** sin cuentas reales de Google
> ni URLs reales de Apps Script. Nada sale de tu máquina.

---

## 🚀 Probar la demo

Requisitos: VS Code 1.85+. Node/npm solo hacen falta para **recompilar** el
TypeScript; la extensión no tiene dependencias en tiempo de ejecución.

**Vía rápida (sin npm)** — si la carpeta `out/` ya existe (el ZIP de la demo
la incluye compilada):

1. Abre esta carpeta en VS Code.
2. Pulsa **F5** con la configuración
   **«Ejecutar extensión (precompilada, sin npm)»**.
3. En la ventana nueva, ábrelo de cualquiera de las dos formas:
   - Clic en el icono **KDD Portal** (la «N» de colores) de la barra de
     actividad de la izquierda → botón **«Abrir KDD Portal»**.
   - `Ctrl+Shift+P` → **«KDD Portal: Abrir KDD Portal»**.

**Vía completa (con npm)** — para modificar el código de `src/`:

```bash
npm install
```

y lanza con **«Ejecutar extensión (compilando antes)»** (compila con la tarea
`npm: compile` en cada F5).

### Qué puedes probar

| Zona | Qué hace la demo |
|---|---|
| 👥 Selector de equipos | Desplegable con los equipos de las aplicaciones de Tesorería: 💱 Front Office (Murex), 💧 Liquidez y Pagos, 📊 Riesgos y Límites, 🧾 Back Office y Conciliación. El backend indica **tu equipo** (María Dev → Front Office) y arrancas en él. |
| 💬 Chat | Un Google Group simulado por equipo: historial, *polling* cada 3 s, compañeros ficticios que escriben solos (con «está escribiendo…»). En el chat de **otro equipo** aparece un aviso de paciencia (pregunta solo si su KB no resolvió tu duda) y las respuestas tardan más. |
| 📚 Knowledge Base | Pestaña con chat estilo Copilot: responde con *streaming* citando documentos de la ruta local del equipo (`kb/<equipo>/…`). La KB de tu equipo es completa; la de **otros equipos** es una **versión reducida** con aviso de posibles errores y advertencia en cada respuesta. |
| 🎓 Formaciones | Listado **global del área** (todos los equipos), cada tarjeta con el equipo organizador. Filtro «Todas / De <equipo>» para ver las que ha montado el equipo seleccionado. **Apuntarse** simula Calendar + Sheets; **＋ Nueva** crea la formación a nombre del equipo activo y avisa en su chat. |
| 🎨 Tema | Todo usa variables CSS de VS Code (`--vscode-*`): cambia de tema claro/oscuro y el panel se adapta. |

---

## 📁 Estructura

```
├── src/extension.ts      → Activación, autenticación (mock), WebviewPanel y HTML
├── media/main.css        → Estilos (variables CSS nativas de VS Code)
├── media/main.js         → Lógica del webview + MockBackend
├── media/logo.svg        → Logo (cabecera, barra de actividad) + icon.png
└── backend/              → Backend real de Google Apps Script (un proyecto)
    ├── router.gs               → doGet/doPost (tabla de acciones)
    ├── config.gs               → CONFIG + hojas "Config" y "Usuarios" + setup()
    ├── chat.gs                 → chat ↔ correo del Google Group por equipo
    ├── formaciones.gs          → Sheets + Calendar + aviso al grupo
    ├── kb.gs                   → índice/descarga de la KB desde Drive
    ├── instrucciones-kb-copilot.md → prompt ad-hoc del chat de KB (Copilot)
    └── appsscript.json         → Manifest de GAS con los scopes OAuth
```

---

## 🔌 Pasar del modo demo al modo real

1. **Backend:** crea un proyecto en [script.google.com](https://script.google.com),
   pega `backend/backend.gs` y `backend/appsscript.json`, rellena `CONFIG`
   (IDs de Spreadsheet/Calendar y email del Google Group), ejecuta `setup()`
   una vez y despliega como **Aplicación web**.
2. **URL:** copia la URL `/exec` del despliegue en la constante
   `APPS_SCRIPT_URL` de `media/main.js`.
3. **Modo:** pon `MOCK_MODE = false` en `src/extension.ts` **y** en
   `media/main.js`.
4. **Autenticación:** la extensión llamará a
   `vscode.authentication.getSession('google', …)`; hace falta un proveedor de
   autenticación de Google instalado en VS Code (los integrados son solo
   GitHub y Microsoft).
5. **Knowledge Base:** la pestaña KB no pasa por Apps Script: usará la
   Language Model API de VS Code (`vscode.lm.selectChatModels` con vendor
   `copilot`) leyendo como contexto los documentos de la carpeta local de cada
   equipo (`KB_BASE_PATH` en `media/main.js`). Requiere tener GitHub Copilot
   instalado y sesión iniciada.

### Scopes OAuth usados

| Dónde | Scope | Para qué |
|---|---|---|
| Extensión (`getSession`) | `openid`, `email`, `profile` | Identidad del usuario (nombre + email) |
| Apps Script | `…/auth/spreadsheets` | Leer/escribir las hojas Formaciones y Asistentes |
| Apps Script | `…/auth/calendar` | Crear eventos e invitados |
| Apps Script | `https://mail.google.com/` | Leer los hilos del Google Group (GmailApp) |
| Apps Script | `…/auth/script.send_mail` | Enviar correos al grupo (MailApp) |

---

## 🧱 Arquitectura (modo real)

```
VS Code (Webview, JS vanilla)
   │  fetch GET/POST  (POST como text/plain para evitar preflight CORS)
   ▼
Google Apps Script Web App  (doGet / doPost + parámetro `action`)
   ├── GmailApp / MailApp  → Google Group  (chat del equipo)
   ├── CalendarApp         → Calendario compartido (formaciones, RSVP)
   └── SpreadsheetApp      → Sheets «Formaciones» y «Asistentes» (BD)
```
