// ════════════════════════════════════════════════════════════════════════════
//  KDD Portal — Extensión de VS Code (área de Tesorería)
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
 *
 * NOTA (Knowledge Base): en modo real, la pestaña «Knowledge Base» usará la
 * Language Model API de VS Code (vscode.lm.selectChatModels con vendor
 * 'copilot') pasando como contexto los documentos de la ruta local del equipo
 * (KB_BASE_PATH en media/main.js). En modo mock las respuestas se simulan.
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

// ─────────────────────────────────────────────────────────── Activación ──

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('kddPortal.open', async () => {
      const user = await getUserSession();
      if (!user) {
        void vscode.window.showErrorMessage(
          'KDD Portal: no se pudo obtener la sesión de usuario.'
        );
        return;
      }
      openPortalPanel(context, user);
    })
  );

  // Vista del contenedor de la barra de actividad (icono de la izquierda).
  // El árbol se registra vacío para que se muestre el contenido de
  // "viewsWelcome" del package.json, con el botón «Abrir KDD Portal».
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kddPortal.home', {
      getTreeItem: (element: vscode.TreeItem) => element,
      getChildren: () => []
    })
  );
}

export function deactivate(): void {
  // Nada que limpiar: el panel se libera en su propio onDidDispose.
}

// ─────────────────────────────────────────────────────── Autenticación ──

/**
 * Devuelve la identidad del usuario.
 * En modo mock devuelve un usuario ficticio al instante; en modo real usa la
 * API nativa de autenticación de VS Code.
 */
async function getUserSession(): Promise<UserInfo | undefined> {
  if (MOCK_MODE) {
    // Usuaria simulada para la demo visual (área de Tesorería).
    // Su equipo lo determina el backend (acción getUserInfo, hoja "Usuarios").
    return { name: 'María Dev', email: 'maria.dev@banco.demo' };
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

// ──────────────────────────────────────────────────────────── Webview ──

function openPortalPanel(
  context: vscode.ExtensionContext,
  user: UserInfo
): void {
  // Si el panel ya existe, lo traemos al frente en vez de duplicarlo.
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'kddPortal',
    'KDD Portal',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      // Mantiene el estado (pantalla, chats, KB) al ocultar/mostrar el panel.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    }
  );
  currentPanel = panel;

  // Versión del manifest: se muestra en la insignia del panel para poder
  // comprobar de un vistazo qué versión de la extensión está instalada.
  const version = String(
    (context.extension.packageJSON as { version?: string }).version ?? ''
  );
  panel.webview.html = getWebviewContent(
    panel.webview,
    context.extensionUri,
    user,
    version
  );

  // Mensajes que llegan desde el webview (JS del panel) hacia la extensión.
  panel.webview.onDidReceiveMessage(
    (message: { type: string; level?: string; text?: string; path?: string }) => {
      if (message.type === 'notify' && message.text) {
        if (message.level === 'error') {
          void vscode.window.showErrorMessage(`KDD Portal: ${message.text}`);
        } else {
          void vscode.window.showInformationMessage(`KDD Portal: ${message.text}`);
        }
      }
      // Clic en una fuente citada por la Knowledge Base.
      // En modo real: vscode.workspace.openTextDocument(rutaLocalKB + path).
      if (message.type === 'openSource' && message.path) {
        void vscode.window.showInformationMessage(
          `KDD Portal (demo): aquí se abriría «${message.path}» desde la ruta local de la Knowledge Base.`
        );
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
 * Estructura de pantallas:
 *   - screenHome: menú inicial con pestañas «Equipos» (tarjetas) y
 *     «Calendario de formaciones» (mes completo del área).
 *   - screenTeam: espacio de un equipo con «← Menú», pestañas
 *     Knowledge Base (primera) y Chat (segunda, tras aviso modal), y las
 *     formaciones de ese equipo.
 */
function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  user: UserInfo,
  version: string
): string {
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'main.css')
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'main.js')
  );
  const logoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'logo.svg')
  );
  const nonce = getNonce();

  // Configuración inyectada al webview. El replace evita cerrar la etiqueta
  // <script> si algún dato contuviera '<'.
  const config = JSON.stringify({ user, mockMode: MOCK_MODE, version }).replace(
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
  <title>KDD Portal</title>
</head>
<body>
  <div class="app">

    <!-- ══════════════════ Barra superior ══════════════════ -->
    <header class="topbar">
      <div class="brand">
        <img class="brand-logo" src="${logoUri}" alt="KDD Portal">
        <div class="brand-text">
          <h1>KDD Portal</h1>
          <span class="brand-sub" id="userLine">Conectando…</span>
        </div>
      </div>
      <div class="topbar-right">
        <span class="badge-demo" id="badgeDemo" hidden>MODO DEMO</span>
        <span class="avatar avatar-own" id="userAvatar" title=""></span>
      </div>
    </header>

    <div class="demo-banner" id="demoBanner" hidden>
      🧪 Demo con datos simulados del área de Tesorería: los equipos, el chat,
      las formaciones y la Knowledge Base son ficticios. Nada se envía a
      Google ni a Copilot.
    </div>

    <!-- ══════════════════ PANTALLA: MENÚ INICIAL ══════════════════ -->
    <main class="screen" id="screenHome">
      <section class="panel home-panel">
        <div class="tabs" role="tablist">
          <button class="tab active" id="tabTeams" type="button" role="tab"
            aria-selected="true">🏦 Equipos</button>
          <button class="tab" id="tabCalendar" type="button" role="tab"
            aria-selected="false">🗓️ Calendario de formaciones</button>
        </div>

        <!-- Vista: selección de equipo -->
        <div class="tab-view" id="viewTeams" role="tabpanel">
          <p class="home-hint">
            Elige un equipo para entrar en su espacio: Knowledge Base, chat
            del grupo y sus formaciones.
          </p>
          <div class="teams-grid" id="teamsGrid"></div>
        </div>

        <!-- Vista: calendario completo del área -->
        <div class="tab-view" id="viewCalendar" role="tabpanel" hidden>
          <div class="cal-toolbar">
            <div class="cal-nav">
              <button class="btn ghost cal-btn" id="calPrev" type="button"
                aria-label="Mes anterior">‹</button>
              <button class="btn ghost cal-btn" id="calToday" type="button">Hoy</button>
              <button class="btn ghost cal-btn" id="calNext" type="button"
                aria-label="Mes siguiente">›</button>
            </div>
            <h2 class="cal-title" id="calTitle"></h2>
            <button class="btn ghost" id="btnToggleNueva" type="button">＋ Nueva</button>
          </div>

          <form class="form-nueva" id="formNueva" hidden>
            <p class="form-note" id="formNote"></p>
            <div class="field">
              <label for="fTitulo">Título</label>
              <input id="fTitulo" type="text" maxlength="80"
                placeholder="Ej. Novedades regulatorias de liquidez">
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

          <div class="cal-scroll">
            <div class="cal-weekdays">
              <span>lun</span><span>mar</span><span>mié</span><span>jue</span>
              <span>vie</span><span>sáb</span><span>dom</span>
            </div>
            <div class="cal-grid" id="calGrid"></div>
            <div class="cal-detail" id="calDetail"></div>
          </div>
        </div>
      </section>
    </main>

    <!-- ══════════════════ PANTALLA: EQUIPO ══════════════════ -->
    <main class="screen" id="screenTeam" hidden>
      <div class="team-bar">
        <button class="btn ghost btn-back" id="btnBackMenu" type="button"
          title="Volver al menú de equipos">← Menú</button>
        <span class="team-bar-icon" id="teamBarIcon"></span>
        <div class="team-bar-text">
          <span class="team-bar-name" id="teamBarName"></span>
          <span class="team-bar-group" id="teamBarGroup"></span>
        </div>
        <span class="team-badge" id="teamBarBadge"></span>
      </div>

      <div class="columns">

        <!-- ── Knowledge Base (primera) + Chat (segunda, tras aviso) ── -->
        <section class="panel chat-panel" aria-label="Knowledge Base y chat">
          <div class="tabs" role="tablist">
            <button class="tab active" id="tabKb" type="button" role="tab"
              aria-selected="true">📚 Knowledge Base</button>
            <button class="tab" id="tabChat" type="button" role="tab"
              aria-selected="false">💬 Chat del equipo</button>
          </div>

          <!-- Vista: Knowledge Base (Copilot, simulado) -->
          <div class="tab-view" id="viewKb" role="tabpanel">
            <div class="kb-meta">
              <span id="kbPath">📁 —</span>
              <span id="kbDocs">📄 —</span>
              <span>⚡ GitHub Copilot <em>(simulado)</em></span>
            </div>
            <div class="warn-banner" id="kbWarn" hidden>
              ⚠️ <strong>Knowledge Base reducida:</strong> estás consultando la
              KB de otro equipo. Puede contener errores o información
              desactualizada; para temas críticos confirma con el equipo
              propietario.
            </div>
            <div class="chat-list kb-list" id="kbList" aria-live="polite"></div>
            <div class="kb-suggest" id="kbSuggest"></div>
            <form class="chat-input" id="kbForm">
              <textarea id="kbText" rows="1"
                placeholder="Pregunta a la Knowledge Base…  (Enter para enviar)"></textarea>
              <button class="btn primary send" type="submit" title="Preguntar" aria-label="Preguntar a la Knowledge Base">
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path fill="currentColor" d="M1.72 1.05a.75.75 0 0 0-.97.97l2.1 5.23L9 8 2.85 8.75l-2.1 5.23a.75.75 0 0 0 .97.97l13.5-6.1a.75.75 0 0 0 0-1.36L1.72 1.05Z"/>
                </svg>
              </button>
            </form>
          </div>

          <!-- Vista: chat del equipo (se abre tras el aviso modal) -->
          <div class="tab-view" id="viewChat" role="tabpanel" hidden>
            <div class="panel-head">
              <h2><span class="panel-icon">💬</span> Chat
                <span class="head-sub" id="chatGroupEmail"></span></h2>
              <span class="sync" id="syncStatus">
                <span class="dot"></span><span id="syncText">Sincronizando…</span>
              </span>
            </div>
            <div class="warn-banner" id="chatWarn" hidden>
              ⚠️ Este es el chat de <strong>otro equipo</strong>: ten paciencia
              con las respuestas y pregunta solo si su Knowledge Base no ha
              podido resolver tu duda.
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
          </div>
        </section>

        <!-- ── Formaciones del equipo ── -->
        <section class="panel form-panel" aria-label="Formaciones del equipo">
          <div class="panel-head">
            <h2><span class="panel-icon">🎓</span> Formaciones
              <span class="head-sub" id="formTeamLabel"></span></h2>
          </div>
          <div class="cards" id="cardsList"></div>
        </section>
      </div>
    </main>
  </div>

  <!-- Aviso modal antes de abrir el chat de un equipo -->
  <div class="modal-overlay" id="chatModal" hidden>
    <div class="modal" role="alertdialog" aria-modal="true"
      aria-labelledby="chatModalTitle" aria-describedby="chatModalBody">
      <div class="modal-icon">⚠️</div>
      <h3 class="modal-title" id="chatModalTitle">¿Abrir el chat del equipo?</h3>
      <p class="modal-body" id="chatModalBody"></p>
      <div class="modal-actions">
        <button class="btn primary" id="btnModalKb" type="button">Consultar la KB primero</button>
        <button class="btn warn" id="btnModalOpen" type="button">Abrir el chat de todas formas</button>
      </div>
    </div>
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
