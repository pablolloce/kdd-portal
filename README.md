# Team Hub — Extensión de VS Code (versión DEMO)

Hub de equipo dentro de VS Code: **chat del equipo** (Google Grupos) y
**formaciones** (Google Calendar + Sheets), renderizado en un Webview que se
integra con el tema del editor.

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
3. En la ventana nueva: `Ctrl+Shift+P` → **«Team Hub: Abrir Team Hub»**.

**Vía completa (con npm)** — para modificar el código de `src/`:

```bash
npm install
```

y lanza con **«Ejecutar extensión (compilando antes)»** (compila con la tarea
`npm: compile` en cada F5).

### Qué puedes probar

| Zona | Qué hace la demo |
|---|---|
| 👥 Selector de equipos | Desplegable en la barra superior (Frontend, Backend, QA & Datos). Cada equipo tiene su propio Google Group simulado, sus miembros, su chat, sus formaciones y su Knowledge Base. |
| 💬 Chat | Historial inicial, *polling* cada 3 s, compañeros ficticios que escriben solos (con indicador «está escribiendo…»), tus mensajes a la derecha con el color de acento del tema. |
| 📚 Knowledge Base | Pestaña con chat estilo Copilot: pregunta (o usa las sugerencias) y responde con *streaming*, citando documentos de la ruta local del equipo (`kb/<equipo>/…`). Clic en una fuente → notificación de VS Code (demo). |
| 🎓 Formaciones | Tarjetas con fecha, hora, creador y nº de asistentes por equipo. Botón **Apuntarse** (simula Calendar + Sheets) y formulario **＋ Nueva** que crea la tarjeta y publica un aviso en el chat. |
| 🎨 Tema | Todo usa variables CSS de VS Code (`--vscode-*`): cambia de tema claro/oscuro y el panel se adapta. |

---

## 📁 Estructura

```
├── src/extension.ts      → Activación, autenticación (mock), WebviewPanel y HTML
├── media/main.css        → Estilos (variables CSS nativas de VS Code)
├── media/main.js         → Lógica del webview + MockBackend (chat, formaciones)
├── backend/backend.gs    → Backend real de Google Apps Script (para el futuro)
└── backend/appsscript.json → Manifest de GAS con los scopes OAuth
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
