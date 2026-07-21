// ════════════════════════════════════════════════════════════════════════════
//  Team Hub — Extensión de VS Code
//  ─────────────────────────────────────────────────────────────────────────
//  VERSIÓN DEMO (MOCK): todo funciona con datos simulados para poder probar
//  el estilo visual sin cuentas reales de Google ni URLs reales de Apps Script.
//
//  Para pasar al modo real más adelante:
//    1. Cambia MOCK_MODE a false (aquí y en media/main.js).
//    2. Pega la URL de tu despliegue de Apps Script en media/main.js
//       (constante APPS_SCRIPT_URL).
//    3. Despliega backend/backend.gs como Web App en Google Apps Script.
// ════════════════════════════════════════════════════════════════════════════

import * as vscode from 'vscode';

/**
 * MODO MOCK.
 * true  → la identidad del usuario se simula (no se pide login de Google).
 * false → se usará vscode.authentication.getSession con un proveedor 'google'.
 */
const MOCK_MODE = true;

/**
 * Scopes OAuth que la extensión pedirá al proveedor de autenticación cuando
 * MOCK_MODE sea false. No van en package.json: se pasan en tiempo de ejecución
 * a vscode.authentication.getSession().
 *
 *   - openid  → identificador del usuario
 *   - email   → dirección de correo (se envía al backend de Apps Script)
 *   - profile → nombre visible para el chat
 *
 * NOTA: VS Code no trae un proveedor 'google' integrado (solo 'github' y
 * 'microsoft'); hará falta tener instalada una extensión que aporte ese
 * proveedor de autenticación de Google.
 */
const GOOGLE_AUTH_SCOPES = ['openid', 'email', 'profile'];

interface UserInfo {
  name: string;
  email: string;
}

let currentPanel: vscode.WebviewPanel | undefined;

// ─────────────────────────────────────────────────────────────── Activación ──

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('teamHub.open', async () => {
      const user = await getUserSession();
      if (!user) {
        void vscode.window.showErrorMessage(
          'Team Hub: no se pudo obtener la sesión de usuario.'
        );
        return;
      }
      openTeamHubPanel(context, user);
    })
  );
}

export function deactivate(): void {
  // Nada que limpiar: el panel se libera en su propio onDidDispose.
}

// ─────────────────────────────────────────────────────────── Autenticación ──

/**
 * Devuelve la identidad del usuario.
 * En modo mock devuelve un usuario ficticio al instante; en modo real usa la
 * API nativa de autenticación de VS Code.
 */
async function getUserSession(): Promise<UserInfo | undefined> {
  if (MOCK_MODE) {
    // Usuario simulado para la demo visual.
    return { name: 'María Dev', email: 'maria.dev@equipo.demo' };
  }

  // Modo real: pide (o reutiliza) una sesión de Google.
  const session = await vscode.authentication.getSession(
    'google',
    GOOGLE_AUTH_SCOPES,
    { createIfNone: true }
  );
  if (!session) {
    return undefined;
  }
  // account.label suele ser el nombre visible y account.id el email.
  return { name: session.account.label, email: session.account.id };
}

// ──────────────────────────────────────────────────────────────── Webview ──

function openTeamHubPanel(
  context: vscode.ExtensionContext,
  user: UserInfo
): void {
  // Si el panel ya existe, lo traemos al frente en vez de duplicarlo.
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'teamHub',
    'Team Hub',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      // Mantiene el estado del chat al ocultar/mostrar el panel.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    }
  );
  currentPanel = panel;

  panel.webview.html = getWebviewContent(panel.webview, context.extensionUri, user);

  // Mensajes que llegan desde el webview (JS del panel) hacia la extensión.
  panel.webview.onDidReceiveMessage(
    (message: { type: string; level?: string; text?: string }) => {
      if (message.type === 'notify' && message.text) {
        if (message.level === 'error') {
          void vscode.window.showErrorMessage(`Team Hub: ${message.text}`);
        } else {
          void vscode.window.showInformationMessage(`Team Hub: ${message.text}`);
        }
      }
    },
    undefined,
    context.subscriptions
  );

  panel.onDidDispose(() => {
    currentPanel = undefined;
  }, null, context.subscriptions);
}

/**
 * Devuelve el HTML del webview.
 * El CSS y el JS viven en /media para mantener el código organizado; la
 * configuración (usuario + modo mock) se inyecta como JSON con nonce.
 */
function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  user: UserInfo
): string {
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'main.css')
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'main.js')
  );
  const nonce = getNonce();

  // Configuración inyectada al webview. El replace evita cerrar la etiqueta
  // <script> si algún dato contuviera '<'.
  const config = JSON.stringify({ user, mockMode: MOCK_MODE }).replace(
    /</g,
    '\\u003c'
  );

  // CSP: solo recursos locales de la extensión + nonce para los scripts.
  // connect-src ya incluye los dominios de Apps Script para cuando se
  // desactive el modo mock (las peticiones fetch reales irán ahí).
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    'connect-src https://script.google.com https://script.googleusercontent.com'
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Team Hub</title>
</head>
<body>
  <div class="app">

    <!-- ══════════════════ Barra superior ══════════════════ -->
    <header class="topbar">
      <div class="brand">
        <span class="brand-logo">◆</span>
        <div class="brand-text">
          <h1>Team Hub</h1>
          <span class="brand-sub" id="userLine">Conectando…</span>
        </div>
      </div>
      <div class="topbar-right">
        <span class="badge-demo" id="badgeDemo" hidden>MODO DEMO</span>
        <span class="avatar avatar-own" id="userAvatar" title=""></span>
      </div>
    </header>

    <div class="demo-banner" id="demoBanner" hidden>
      🧪 Estás viendo datos simulados: el chat, las formaciones y los compañeros
      son ficticios. Nada se envía a Google.
    </div>

    <!-- ══════════════════ Columnas principales ══════════════════ -->
    <main class="columns">

      <!-- ── Chat (Google Grupos) ── -->
      <section class="panel chat-panel" aria-label="Chat del equipo">
        <div class="panel-head">
          <h2><span class="panel-icon">💬</span> Chat del equipo</h2>
          <span class="sync" id="syncStatus">
            <span class="dot"></span><span id="syncText">Sincronizando…</span>
          </span>
        </div>
        <div class="chat-list" id="chatList" aria-live="polite"></div>
        <div class="typing" id="typing" hidden>
          <span class="typing-dots"><i></i><i></i><i></i></span>
          <span id="typingName"></span>&nbsp;está escribiendo…
        </div>
        <form class="chat-input" id="chatForm">
          <textarea id="chatText" rows="1"
            placeholder="Escribe un mensaje para el grupo…  (Enter para enviar)"></textarea>
          <button class="btn primary send" type="submit" title="Enviar al grupo" aria-label="Enviar mensaje">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path fill="currentColor" d="M1.72 1.05a.75.75 0 0 0-.97.97l2.1 5.23L9 8 2.85 8.75l-2.1 5.23a.75.75 0 0 0 .97.97l13.5-6.1a.75.75 0 0 0 0-1.36L1.72 1.05Z"/>
            </svg>
          </button>
        </form>
      </section>

      <!-- ── Formaciones (Calendar + Sheets) ── -->
      <section class="panel form-panel" aria-label="Formaciones">
        <div class="panel-head">
          <h2><span class="panel-icon">🎓</span> Próximas formaciones</h2>
          <button class="btn ghost" id="btnToggleNueva" type="button">＋ Nueva</button>
        </div>

        <form class="form-nueva" id="formNueva" hidden>
          <div class="field">
            <label for="fTitulo">Título</label>
            <input id="fTitulo" type="text" maxlength="80"
              placeholder="Ej. Introducción a Docker">
          </div>
          <div class="field-row">
            <div class="field">
              <label for="fFecha">Fecha</label>
              <input id="fFecha" type="date">
            </div>
            <div class="field">
              <label for="fHora">Hora</label>
              <input id="fHora" type="time" value="10:00">
            </div>
          </div>
          <div class="field">
            <label for="fDesc">Descripción</label>
            <textarea id="fDesc" rows="3"
              placeholder="¿De qué trata la formación?"></textarea>
          </div>
          <div class="form-actions">
            <button class="btn primary" type="submit" id="btnCrear">Crear y notificar al grupo</button>
            <button class="btn secondary" type="button" id="btnCancelarNueva">Cancelar</button>
          </div>
        </form>

        <div class="cards" id="cardsList"></div>
      </section>
    </main>
  </div>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script nonce="${nonce}">window.__TEAM_HUB_CONFIG__ = ${config};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
