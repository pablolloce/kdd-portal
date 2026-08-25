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
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * MODO DE FUNCIONAMIENTO — se controla desde los AJUSTES de VS Code
 * (Preferencias → Configuración → «KDD Portal»), sin recompilar:
 *
 *   kddPortal.modoMock      true (por defecto) → datos simulados.
 *   kddPortal.appsScriptUrl URL /exec del despliegue de Apps Script.
 *   kddPortal.emailUsuario  identidad enviada al backend en modo real
 *                           (la hoja "Usuarios" la traduce a equipo).
 *   kddPortal.nombreUsuario nombre visible (opcional).
 *
 * Pasos de despliegue del backend: backend/DESPLIEGUE.md.
 *
 * NOTA (identidad): se optó por email en ajustes confiando en el dominio
 * (VS Code no trae proveedor de auth de Google; si algún día se instala
 * uno, cambiar getUserSession a vscode.authentication.getSession).
 * NOTA (Knowledge Base): la pestaña KB seguirá simulada también en modo
 * real hasta el hito Copilot (vscode.lm + KB local sincronizada desde
 * Drive con getKbIndex/getKbFile).
 */
interface PortalConfig {
  mockMode: boolean;
  appsScriptUrl: string;
  emailUsuario: string;
  nombreUsuario: string;
  tokenAcceso: string;
  rutaKb: string;
  modeloCopilot: string;
}

function getPortalConfig(): PortalConfig {
  const cfg = vscode.workspace.getConfiguration('kddPortal');
  return {
    mockMode: cfg.get<boolean>('modoMock', true),
    appsScriptUrl: (cfg.get<string>('appsScriptUrl') ?? '').trim(),
    emailUsuario: (cfg.get<string>('emailUsuario') ?? '').trim(),
    nombreUsuario: (cfg.get<string>('nombreUsuario') ?? '').trim(),
    tokenAcceso: (cfg.get<string>('tokenAcceso') ?? '').trim(),
    rutaKb: (cfg.get<string>('rutaKb') ?? '').trim(),
    modeloCopilot: (cfg.get<string>('modeloCopilot') ?? '').trim()
  };
}

/**
 * Informe de Looker Studio del directorio de proyectos/personas del área.
 * Se abre en el navegador desde la pestaña «Proyectos y personas» (dentro
 * de un webview de VS Code el login de Google no funciona, así que el
 * embed por iframe solo valdría si el informe permitiera acceso público).
 */
const LOOKER_STUDIO_URL =
  'https://lookerstudio.google.com/reporting/502b7e84-019a-47c5-a670-39b6bc7b0b84/page/0o8qF';

interface UserInfo {
  name: string;
  email: string;
}

/**
 * Sesión real obtenida vía login (action=auth, ver backend/auth.gs): el
 * webview no tiene cookies de Google, así que con la Web App restringida
 * al dominio necesita este token para superar la puerta de acceso — se
 * consigue abriendo action=auth en el navegador del SISTEMA (que sí lleva
 * la sesión), nunca desde el propio panel. Se guarda cifrado en
 * context.secrets, nunca en un ajuste de VS Code.
 */
interface StoredSession {
  token: string;
  email: string;
  /**
   * Token OAuth REAL de Google (ScriptApp.getOAuthToken() en el backend —
   * la identidad de quien despliega, no la de quien llama). TRADE-OFF
   * DELIBERADO mientras no haya Client ID propio en Cloud Console: es una
   * credencial personal compartida, no un cliente OAuth de la app — ver
   * el aviso en DESPLIEGUE.md 6ter. Caduca en ~1h; sin refresco automático
   * todavía (toca volver a pulsar «Conectar»).
   */
  sharedBearerToken?: string;
}

interface ApiCallMessage {
  reqId: string;
  action: string;
  team?: string;
  email?: string;
  name?: string;
  payload?: Record<string, unknown> | null;
}

const SESSION_SECRET_KEY = 'kddPortal.sesion';
const LOGIN_TIMEOUT_MS = 60000;

let currentPanel: vscode.WebviewPanel | undefined;

/** Nonce del login en curso (anti-CSRF/replay) y su timeout de 60 s. */
let pendingLoginState: string | undefined;
let pendingLoginTimer: ReturnType<typeof setTimeout> | undefined;

async function getStoredSession(
  context: vscode.ExtensionContext
): Promise<StoredSession | undefined> {
  const raw = await context.secrets.get(SESSION_SECRET_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return undefined;
  }
}

async function storeSession(
  context: vscode.ExtensionContext,
  session: StoredSession
): Promise<void> {
  await context.secrets.store(SESSION_SECRET_KEY, JSON.stringify(session));
}

// ─────────────────────────────────────────────────────────── Activación ──

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('kddPortal.open', async () => {
      const user = await getUserSession();
      if (!user) {
        return; // getUserSession ya avisó del motivo.
      }
      await openPortalPanel(context, user);
    })
  );

  // Recibe la redirección vscode://<publisher>.<name>/auth?data=... que
  // backend/auth.gs abre al terminar el login (ver beginLogin/6ter en
  // DESPLIEGUE.md). Llega desde el navegador del SISTEMA, nunca del panel.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        void handleAuthCallback(context, uri);
      }
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

  // Si cambian los ajustes de KDD Portal con el panel abierto, se recarga
  // el webview para aplicar el nuevo modo/URL (se pierde el estado en
  // pantalla, aceptable al ser un cambio de configuración).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('kddPortal') && currentPanel) {
        const user = await getUserSession();
        if (user) {
          const session = await getStoredSession(context);
          currentPanel.webview.html = getWebviewContent(
            currentPanel.webview,
            context.extensionUri,
            user,
            String(
              (context.extension.packageJSON as { version?: string }).version ?? ''
            ),
            session
          );
        }
      }
    })
  );
}

export function deactivate(): void {
  // Nada que limpiar: el panel se libera en su propio onDidDispose.
}

// ─────────────────────────────────────────────────────── Autenticación ──

/**
 * Devuelve la identidad del usuario según el modo configurado.
 * Mock → usuaria ficticia; real → email de los ajustes (obligatorio),
 * cuyo equipo resuelve el backend (getUserInfo, hoja "Usuarios").
 */
async function getUserSession(): Promise<UserInfo | undefined> {
  const config = getPortalConfig();

  if (config.mockMode) {
    return { name: 'María Dev', email: 'maria.dev@banco.demo' };
  }

  if (!config.emailUsuario || !config.appsScriptUrl) {
    const abrir = 'Abrir ajustes';
    const falta = !config.appsScriptUrl
      ? 'kddPortal.appsScriptUrl'
      : 'kddPortal.emailUsuario';
    const eleccion = await vscode.window.showErrorMessage(
      `KDD Portal: falta configurar «${falta}» para el modo real ` +
        '(o reactiva kddPortal.modoMock).',
      abrir
    );
    if (eleccion === abrir) {
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'kddPortal'
      );
    }
    return undefined;
  }

  // Nombre visible: el configurado o uno legible derivado del email
  // ("maria.dev@banco.com" → "Maria Dev").
  const nombre =
    config.nombreUsuario ||
    config.emailUsuario
      .split('@')[0]
      .split(/[._-]+/)
      .filter(Boolean)
      .map((parte) => parte.charAt(0).toUpperCase() + parte.slice(1))
      .join(' ');

  return { name: nombre, email: config.emailUsuario };
}

/**
 * Login real (backend/auth.gs, action=auth): abre action=auth en el
 * navegador del SISTEMA (no en el webview, que no tiene sesión de Google)
 * para superar la puerta de acceso de una Web App restringida al dominio.
 * El resultado vuelve por registerUriHandler → handleAuthCallback.
 */
async function beginLogin(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel
): Promise<void> {
  const cfg = getPortalConfig();
  if (!cfg.appsScriptUrl) {
    void vscode.window.showErrorMessage(
      'KDD Portal: falta configurar kddPortal.appsScriptUrl antes de conectar.'
    );
    return;
  }

  const state = crypto.randomUUID();
  pendingLoginState = state;
  if (pendingLoginTimer) {
    clearTimeout(pendingLoginTimer);
  }
  pendingLoginTimer = setTimeout(() => {
    if (pendingLoginState !== state) {
      return; // ya se resolvió (o lo sustituyó un login más reciente).
    }
    pendingLoginState = undefined;
    void panel.webview.postMessage({
      type: 'loginError',
      error:
        'No se recibió respuesta en 60 s. ¿Cerraste la pestaña del navegador o ' +
        'bloqueó la redirección a VS Code? Pulsa «Conectar» para reintentar.'
    });
  }, LOGIN_TIMEOUT_MS);

  const url = new URL(cfg.appsScriptUrl);
  url.searchParams.set('action', 'auth');
  url.searchParams.set('state', state);
  if (cfg.tokenAcceso) {
    url.searchParams.set('token', cfg.tokenAcceso);
  }
  await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
}

/** Procesa la redirección vscode://…/auth?data=… al terminar el login. */
async function handleAuthCallback(
  context: vscode.ExtensionContext,
  uri: vscode.Uri
): Promise<void> {
  if (uri.path !== '/auth') {
    return;
  }
  const dataParam = new URLSearchParams(uri.query).get('data');
  if (!dataParam) {
    return;
  }

  let payload: {
    state?: string;
    ok?: boolean;
    sessionToken?: string;
    email?: string;
    error?: string;
    sharedBearerToken?: string;
  };
  try {
    payload = JSON.parse(Buffer.from(dataParam, 'base64').toString('utf-8'));
  } catch {
    return;
  }

  if (pendingLoginTimer) {
    clearTimeout(pendingLoginTimer);
    pendingLoginTimer = undefined;
  }
  const estadoEsperado = pendingLoginState;
  pendingLoginState = undefined;

  // Anti-CSRF/replay: ignora cualquier callback que no case con un login
  // que de verdad iniciamos (p. ej. un reintento tardío tras timeout).
  if (!estadoEsperado || payload.state !== estadoEsperado) {
    void vscode.window.showWarningMessage(
      'KDD Portal: respuesta de login ignorada (no coincide con ningún intento en curso).'
    );
    return;
  }

  const post = (m: unknown) => {
    if (currentPanel) {
      void currentPanel.webview.postMessage(m);
    }
  };

  if (payload.ok && payload.sessionToken && payload.email) {
    await storeSession(context, {
      token: payload.sessionToken,
      email: payload.email,
      sharedBearerToken: payload.sharedBearerToken
    });
    void vscode.window.showInformationMessage(`KDD Portal: conectado como ${payload.email}.`);
    post({ type: 'loginOk', email: payload.email });

    // Chequeo inmediato del token compartido (tokeninfo): si no lleva el
    // scope de identidad, la puerta del dominio va a rechazarlo — mejor
    // decirlo ahora, con la causa, que dejar que falle el primer getTeams.
    if (payload.sharedBearerToken) {
      const sonda = await probarTokenCompartido(payload.sharedBearerToken);
      if ('error' in sonda) {
        void vscode.window.showWarningMessage(
          `KDD Portal: el token compartido no valida contra Google (${sonda.error}). ` +
            'Las llamadas al backend probablemente fallarán.'
        );
      } else if (!sonda.email) {
        void vscode.window.showWarningMessage(
          'KDD Portal: el token compartido NO lleva el scope de identidad ' +
            '(userinfo.email), así que la puerta de acceso por dominio lo va a ' +
            'rechazar. Falta re-autorizar el proyecto de Apps Script: repega ' +
            'backend/appsscript.json, ejecuta setup() y publica Nueva versión ' +
            '(DESPLIEGUE.md 6ter). Scopes actuales del token: ' +
            sonda.scopes.map((s) => s.split('/').pop()).join(', ')
        );
      } else {
        // Resumen SIEMPRE visible del token recién acuñado: con esto la
        // siguiente prueba es concluyente (qué identidad y scopes lleva,
        // cuánto le queda) sin adivinar en qué estado quedó el despliegue.
        void vscode.window.showInformationMessage(
          `KDD Portal: token compartido de ${sonda.email} · ` +
            `caduca en ~${sonda.caducaEnMin} min · scopes: ` +
            sonda.scopes.map((s) => s.split('/').pop()).join(', ')
        );
      }
    } else {
      void vscode.window.showWarningMessage(
        'KDD Portal: el backend no devolvió el token compartido — ¿está la ' +
          'última versión de backend/auth.gs desplegada (Nueva versión)?'
      );
    }
  } else {
    const motivo = payload.error || 'error desconocido';
    void vscode.window.showErrorMessage(`KDD Portal: no se pudo conectar (${motivo}).`);
    post({ type: 'loginError', error: motivo });
  }
}

// ────────────────────────────────────────── Llamadas reales (proxy Node) ──
//  El webview ya no llama a Apps Script directamente: se lo pide a la
//  extensión (postMessage), que hace el fetch desde Node.js. Dos motivos:
//  no hay CORS en Node (así se puede mandar Authorization: Bearer, algo
//  que el navegador del webview bloquearía con preflight — Apps Script no
//  lo soporta) y así el sharedBearerToken nunca sale de la extensión.

/** Atiende un 'apiCall' del webview: hace el fetch real y responde 'apiResult'. */
async function handleApiCall(
  context: vscode.ExtensionContext,
  message: ApiCallMessage,
  post: (m: unknown) => void
): Promise<void> {
  try {
    const data = await callBackendReal(context, message);
    post({ type: 'apiResult', reqId: message.reqId, data });
  } catch (err) {
    post({
      type: 'apiResult',
      reqId: message.reqId,
      data: { ok: false, error: err instanceof Error ? err.message : String(err) }
    });
  }
}

/**
 * Fetch real a Apps Script desde Node.js (sin CORS): adjunta
 * Authorization: Bearer con el sharedBearerToken de la sesión cuando
 * existe — es lo que de verdad supera la puerta de acceso por dominio de
 * Google (un sessionToken propio, viajando en la URL o el body, no basta:
 * la puerta la impone Google al nivel de transporte, antes de que el
 * código de Apps Script llegue a ejecutarse).
 *
 * Redirecciones: fetch normal con redirect:'follow'. La puerta se evalúa
 * en el PRIMER salto (script.google.com); el segundo
 * (script.googleusercontent.com) es una URL firmada de un solo uso que no
 * necesita la cabecera — que fetch la recorte ahí al cruzar de origen es
 * irrelevante. (Se probó seguir la redirección a mano reenviando la
 * cabecera y no cambia nada: si el primer salto rechaza el token, ya no
 * hay contenido firmado que recoger. Es el mismo transporte que usa la
 * extensión de NFQ, verificado en su bundle.)
 */
async function callBackendReal(
  context: vscode.ExtensionContext,
  message: ApiCallMessage
): Promise<unknown> {
  const cfg = getPortalConfig();
  if (!cfg.appsScriptUrl) {
    return { ok: false, error: 'Falta configurar el ajuste kddPortal.appsScriptUrl' };
  }

  const session = await getStoredSession(context);
  const headers: Record<string, string> = {};
  if (session?.sharedBearerToken) {
    headers.Authorization = `Bearer ${session.sharedBearerToken}`;
  }

  const campos: Record<string, string> = {
    action: message.action,
    team: message.team || '',
    email: message.email || cfg.emailUsuario,
    name: message.name || '',
    token: cfg.tokenAcceso,
    sessionToken: session?.token || ''
  };

  if (message.payload) {
    const res = await fetch(cfg.appsScriptUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({}, campos, message.payload)),
      redirect: 'follow'
    });
    return parseJsonODiagnostico(res);
  }

  const url = new URL(cfg.appsScriptUrl);
  for (const [k, v] of Object.entries(campos)) {
    if (v) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), { headers, redirect: 'follow' });
  return parseJsonODiagnostico(res);
}

/**
 * Igual que res.json(), pero si el cuerpo no es JSON (Google devolviendo
 * su propia página en vez de dejar pasar la petición), clasifica el HTML
 * en una causa accionable — el mismo triaje que hace la extensión de NFQ
 * con este mismo patrón de backend.
 */
async function parseJsonODiagnostico(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: false,
      error:
        clasificarHtmlDeGoogle(res.status, res.url, text) +
        ` [HTTP ${res.status} desde ${res.url}. Extracto: ` +
        `${text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}]`
    };
  }
}

/** Triaje del HTML que devuelve Google cuando la petición no llega al script. */
function clasificarHtmlDeGoogle(
  status: number,
  finalUrl: string,
  text: string
): string {
  const u = (text + ' ' + finalUrl).toLowerCase();
  if (
    /accounts\.google\.com|servicelogin|\bsign in\b|iniciar sesi|saml|\/idp\.|idp\./.test(u)
  ) {
    return (
      'Google redirigió al login: no aceptó el token de la cabecera. ' +
      'Si has redesplegado el backend después de conectar, tu token guardado ' +
      'es ANTERIOR al cambio: pulsa «✓ Conectado · renovar» para acuñar uno ' +
      'nuevo. Si ya renovaste y sigue pasando, el token no lleva el scope de ' +
      'identidad (userinfo.email): repega backend/appsscript.json, ejecuta ' +
      'setup() para RE-AUTORIZAR, publica Nueva versión y renueva otra vez.'
    );
  }
  if (/authorization is required|se requiere autorizaci|authorization required/.test(u)) {
    return (
      'Google exige re-autorizar el proyecto: el token no cubre los scopes ' +
      'del manifiesto. Ejecuta setup() desde el editor de Apps Script, acepta ' +
      'los permisos y vuelve a Conectar.'
    );
  }
  if (/you need access|no tienes acceso|unable to open the file|no se puede abrir/.test(u)) {
    return (
      'Esta cuenta no puede EJECUTAR esa implementación (Google lo muestra ' +
      'como acceso denegado). Revisa «Quién tiene acceso» en la implementación.'
    );
  }
  return (
    'Google respondió su propia página en vez de dejar pasar la petición a ' +
    'Apps Script — sesión caducada o deployment mal configurado.'
  );
}

/**
 * Valida el token compartido contra el endpoint público tokeninfo de
 * Google (mismo truco que la extensión de NFQ): confirma que es un token
 * vivo, con qué scopes se acuñó y a qué email pertenece. Es la manera de
 * distinguir «falta re-autorizar el manifiesto» de «la puerta rechaza un
 * token correcto» sin adivinar.
 */
async function probarTokenCompartido(
  token: string
): Promise<{ email: string; scopes: string[]; caducaEnMin: number } | { error: string }> {
  try {
    const res = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?access_token=' +
        encodeURIComponent(token)
    );
    const info = (await res.json()) as {
      email?: string;
      scope?: string;
      expires_in?: string | number;
      error_description?: string;
      error?: string;
    };
    if (!res.ok) {
      return { error: info.error_description || info.error || `HTTP ${res.status}` };
    }
    return {
      email: String(info.email || ''),
      scopes: String(info.scope || '').split(/\s+/).filter(Boolean),
      caducaEnMin: Math.round(Number(info.expires_in || 0) / 60)
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ──────────────────────────────────────────────────────────── Webview ──

async function openPortalPanel(
  context: vscode.ExtensionContext,
  user: UserInfo
): Promise<void> {
  // Si el panel ya existe, lo traemos al frente en vez de duplicarlo.
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  // Todo lo async ANTES de crear el panel: createWebviewPanel() y la
  // primera asignación de webview.html deben quedar en el mismo tick,
  // igual que antes de este cambio — meter un await de por medio dio
  // "Could not register service worker: InvalidStateError" en pruebas
  // reales (carrera en la inicialización del documento del webview).
  const session = await getStoredSession(context);

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
    version,
    session
  );

  // Mensajes que llegan desde el webview (JS del panel) hacia la extensión.
  panel.webview.onDidReceiveMessage(
    (message: {
      type: string;
      level?: string;
      text?: string;
      path?: string;
      reqId?: string;
      teamId?: string;
      teamNombre?: string;
      question?: string;
      foreign?: boolean;
      action?: string;
      team?: string;
      email?: string;
      name?: string;
      payload?: Record<string, unknown> | null;
    }) => {
      const post = (m: unknown) => void panel.webview.postMessage(m);

      if (message.type === 'notify' && message.text) {
        if (message.level === 'error') {
          void vscode.window.showErrorMessage(`KDD Portal: ${message.text}`);
        } else {
          void vscode.window.showInformationMessage(`KDD Portal: ${message.text}`);
        }
      }
      // Login real (action=auth): abre el navegador del SISTEMA, nunca el
      // panel — ver beginLogin y handleAuthCallback más abajo.
      if (message.type === 'iniciarLogin') {
        void beginLogin(context, panel);
      }
      // Llamada real al backend (modo real): la hace la extensión (Node.js,
      // sin CORS) para poder mandar el token compartido como
      // Authorization: Bearer — ver handleApiCall más abajo.
      if (message.type === 'apiCall' && message.action && message.reqId) {
        void handleApiCall(context, message as ApiCallMessage, post);
      }
      // Clic en una fuente citada por la Knowledge Base: en modo real abre
      // el documento local sincronizado; en demo, una notificación.
      if (message.type === 'openSource' && message.path) {
        const cfg = getPortalConfig();
        if (cfg.mockMode) {
          void vscode.window.showInformationMessage(
            `KDD Portal (demo): aquí se abriría «${message.path}» desde la ruta local de la Knowledge Base.`
          );
        } else {
          const local = path.join(
            kbTeamDir(context, cfg, String(message.teamId ?? '')),
            rutaSegura(String(message.path))
          );
          vscode.workspace.openTextDocument(local).then(
            (doc) => vscode.window.showTextDocument(doc, { preview: true }),
            () =>
              vscode.window.showWarningMessage(
                `KDD Portal: no se encontró «${message.path}» en la KB local (sincroniza primero).`
              )
          );
        }
      }
      // Abre el informe original de Looker Studio en el navegador.
      if (message.type === 'openLooker') {
        void vscode.env.openExternal(vscode.Uri.parse(LOOKER_STUDIO_URL));
      }
      // Sincroniza la KB de Drive del equipo a la carpeta local.
      if (message.type === 'kbSync' && message.teamId) {
        const cfg = getPortalConfig();
        kbSyncTeam(context, cfg, message.teamId)
          .then((r) =>
            post({
              type: 'kbSyncDone',
              reqId: message.reqId,
              teamId: message.teamId,
              docs: r.docs,
              bajados: r.bajados,
              ruta: r.ruta
            })
          )
          .catch((err: unknown) =>
            post({
              type: 'kbSyncError',
              reqId: message.reqId,
              teamId: message.teamId,
              error: err instanceof Error ? err.message : String(err)
            })
          );
      }
      // Pregunta a la KB local con Copilot (streaming hacia el webview).
      if (message.type === 'kbAsk' && message.teamId) {
        const cfg = getPortalConfig();
        void kbAskCopilot(context, cfg, message, post);
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
  version: string,
  session: StoredSession | undefined
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
  const portal = getPortalConfig();
  const config = JSON.stringify({
    user,
    mockMode: portal.mockMode,
    appsScriptUrl: portal.appsScriptUrl,
    token: portal.tokenAcceso,
    rutaKb: portal.rutaKb,
    version,
    // Solo el email, para la UI del botón «Conectar»: el sessionToken y
    // el token OAuth compartido son sensibles y ya no hace falta que
    // salgan de la extensión (el webview ya no llama a Apps Script
    // directamente, se lo pide a la extensión — ver apiReal en main.js).
    sesion: session ? { email: session.email } : null
  }).replace(/</g, '\\u003c');

  // CSP: solo recursos locales de la extensión + nonce para los scripts.
  // connect-src es 'none': el webview ya no hace fetch directo a Apps
  // Script (lo hace la extensión por Node.js, sin CORS — ver
  // callBackendReal), así que no necesita permiso de red saliente.
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`
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
        <button class="btn primary" id="btnConectar" type="button" hidden>Conectar</button>
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
          <button class="tab" id="tabDir" type="button" role="tab"
            aria-selected="false">📇 Proyectos y personas</button>
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

        <!-- Vista: proyectos y personas (réplica del informe TRA de Looker) -->
        <div class="tab-view" id="viewDir" role="tabpanel" hidden>
          <div class="dir-toolbar">
            <div class="dir-search">
              <span class="dir-search-icon">🔎</span>
              <input id="dirSearch" type="text" autocomplete="off"
                placeholder="Buscar persona, equipo, SDATOOL o feature JIRA…">
            </div>
          </div>

          <!-- Filtros de búsqueda (como en el Looker) -->
          <div class="tra-filters">
            <label class="tra-filter">
              <span>Nombre</span>
              <select id="fNombre"></select>
            </label>
            <label class="tra-filter">
              <span>Equipo</span>
              <select id="fEquipo"></select>
            </label>
            <label class="tra-filter">
              <span>Proyecto SDA</span>
              <select id="fSda"></select>
            </label>
            <label class="tra-filter">
              <span>Feature JIRA</span>
              <select id="fJira"></select>
            </label>
            <button class="btn secondary tra-reset" id="btnResetFiltros"
              type="button">Reestablecer filtros</button>
          </div>

          <div class="warn-banner info" id="traNote">
            ℹ️ Información <strong>complementaria</strong> (informe TRA de
            imputaciones): no todos los equipos ni todas las personas del
            área aparecen aquí.
          </div>

          <div class="dir-scroll">
            <div class="tra-dash">
              <div class="tra-card tra-total">
                <span class="tra-card-title">Total de imputación</span>
                <span class="tra-hours-label">horas</span>
                <span class="tra-hours" id="traTotal">—</span>
                <div class="tra-minis">
                  <span id="traPersonas">—</span>
                  <span id="traProyectos">—</span>
                </div>
              </div>
              <div class="tra-card tra-chart">
                <span class="tra-card-title">Proyectos imputados por tiempo</span>
                <div class="tra-chart-body">
                  <canvas id="traDonut" width="170" height="170"></canvas>
                  <div class="tra-legend" id="traLegend"></div>
                </div>
              </div>
            </div>

            <div class="tra-tables">
              <div class="tra-card">
                <span class="tra-card-title">Personas
                  <span class="tra-count" id="cntPersonas"></span></span>
                <div class="tra-table-wrap">
                  <table class="tra-table" id="tblPersonas">
                    <thead><tr><th>Nombre</th><th>Equipo</th>
                      <th class="num">Horas</th></tr></thead>
                    <tbody></tbody>
                  </table>
                </div>
              </div>
              <div class="tra-card">
                <span class="tra-card-title">Proyectos
                  <span class="tra-count" id="cntProyectos"></span></span>
                <div class="tra-table-wrap">
                  <table class="tra-table" id="tblProyectos">
                    <thead><tr><th>SDATOOL</th><th>Feature JIRA</th>
                      <th>Descripción</th><th class="num">Horas</th></tr></thead>
                    <tbody></tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          <div class="dir-foot">
            <span class="dir-foot-note">Fuente (modo real): Google Sheets del
              informe TRA vía Apps Script (se actualiza a diario) · informe
              original en Looker Studio</span>
            <button class="btn ghost" id="btnLooker" type="button">Abrir en Looker Studio ↗</button>
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
              <span id="kbEngine">⚡ Copilot <em>(simulado)</em></span>
              <button class="btn ghost kb-sync" id="btnKbSync" type="button"
                hidden>⟳ Sincronizar</button>
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
            <button class="btn ghost" id="btnNuevaEquipo" type="button"
              hidden>＋ Nueva</button>
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

// ═══════════════════════ KNOWLEDGE BASE REAL (Drive → local + Copilot) ═══
//  Flujo: el webview pide kbSync/kbAsk → la extensión descarga la KB del
//  equipo vía el backend GAS (getKbIndex/getKbFile) a la carpeta local
//  (ajuste kddPortal.rutaKb) y responde con Copilot (vscode.lm) usando los
//  documentos más relevantes como contexto. Prompt completo de referencia:
//  backend/instrucciones-kb-copilot.md.

const PROMPT_KB = `Eres el asistente de la Knowledge Base del equipo {EQUIPO} del área de Tesorería. Tu única fuente de verdad son los documentos adjuntados como contexto, sincronizados desde el Drive del equipo a {RUTA_KB}.

REGLAS:
1. Responde SOLO con información de los documentos del contexto; no inventes procedimientos, horarios, rutas ni sistemas.
2. Cita al final las rutas de los documentos que uses (tal como aparecen en el contexto). No cites documentos no usados.
3. Si la respuesta no está en el contexto, dilo claramente y sugiere revisar el índice o las FAQ; como último recurso, el chat del equipo (recordando tener paciencia).
4. {AVISO}
5. Responde en español, breve y accionable: listas con guiones, \`código\` para comandos y rutas. Sin saludos ni despedidas.
6. Ante ambigüedad, pregunta qué caso aplica en lugar de elegir por tu cuenta.

CONTEXTO (documentos de la KB):
{DOCUMENTOS}

PREGUNTA DEL USUARIO:
{PREGUNTA}`;

/** Carpeta base local de las KB (ajuste kddPortal.rutaKb o almacén interno). */
function kbBaseDir(
  context: vscode.ExtensionContext,
  cfg: PortalConfig
): string {
  return cfg.rutaKb || path.join(context.globalStorageUri.fsPath, 'kb');
}

function kbTeamDir(
  context: vscode.ExtensionContext,
  cfg: PortalConfig,
  teamId: string
): string {
  return path.join(kbBaseDir(context, cfg), rutaSegura(teamId));
}

/** Aplasta separadores/traversal para construir rutas locales seguras. */
function rutaSegura(p: string): string {
  return p
    .split('/')
    .map((s) => s.replace(/[\\:*?"<>|]/g, '_').trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join(path.sep);
}

/** GET al backend GAS con email/token, exigiendo respuesta JSON. */
async function gasGetJson(
  context: vscode.ExtensionContext,
  cfg: PortalConfig,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  if (!cfg.appsScriptUrl) {
    throw new Error('Falta configurar kddPortal.appsScriptUrl');
  }
  const url = new URL(cfg.appsScriptUrl);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  if (cfg.emailUsuario) url.searchParams.set('email', cfg.emailUsuario);
  if (cfg.tokenAcceso) url.searchParams.set('token', cfg.tokenAcceso);

  // Mismo transporte que callBackendReal: el Bearer compartido de la
  // sesión es lo que supera la puerta de acceso por dominio — sin él, la
  // sincronización de la KB rebotaba al login aunque el resto del panel
  // funcionara (este camino se quedó atrás al migrar api() al proxy).
  const session = await getStoredSession(context);
  const headers: Record<string, string> = {};
  if (session?.sharedBearerToken) {
    headers.Authorization = `Bearer ${session.sharedBearerToken}`;
  }
  if (session?.token) {
    url.searchParams.set('sessionToken', session.token);
  }

  const res = await fetch(url.toString(), { headers, redirect: 'follow' });
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(clasificarHtmlDeGoogle(res.status, res.url, text));
  }
}

interface KbIndexEntry {
  id: string;
  path: string;
  updated: number;
  supported: boolean;
}

/** Descarga (incremental) la KB de Drive del equipo a la carpeta local. */
async function kbSyncTeam(
  context: vscode.ExtensionContext,
  cfg: PortalConfig,
  teamId: string
): Promise<{ docs: number; bajados: number; ruta: string }> {
  const idx = await gasGetJson(context, cfg, { action: 'getKbIndex', team: teamId });
  if (!idx.ok) {
    throw new Error(String(idx.error ?? 'getKbIndex falló'));
  }

  const dir = kbTeamDir(context, cfg, teamId);
  await fs.mkdir(dir, { recursive: true });

  const manifestPath = path.join(dir, '.kdd-manifest.json');
  let manifest: Record<string, number> = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    // Primera sincronización.
  }

  const soportados = (idx.files as KbIndexEntry[]).filter((f) => f.supported);
  let bajados = 0;
  for (const f of soportados) {
    if (manifest[f.id] === f.updated) continue;
    const res = await gasGetJson(context, cfg, {
      action: 'getKbFile',
      team: teamId,
      fileId: f.id
    });
    const file = res.file as
      | { supported?: boolean; content?: string }
      | undefined;
    if (!res.ok || !file || !file.supported) continue;

    const rel = rutaSegura(f.path);
    const destino = path.join(
      dir,
      /\.(md|txt)$/i.test(rel) ? rel : rel + '.md'
    );
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.writeFile(destino, String(file.content ?? ''), 'utf8');
    manifest[f.id] = f.updated;
    bajados += 1;
  }

  await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  return { docs: soportados.length, bajados, ruta: dir };
}

interface KbDoc {
  rel: string;
  texto: string;
}

/** Documentos .md/.txt de la KB local del equipo (recursivo, acotado). */
async function kbDocsLocales(dir: string): Promise<KbDoc[]> {
  const out: KbDoc[] = [];
  async function walk(d: string, prefijo: string): Promise<void> {
    let entradas;
    try {
      entradas = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      if (e.name.startsWith('.') || out.length >= 60) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full, prefijo + e.name + '/');
      } else if (/\.(md|txt)$/i.test(e.name)) {
        try {
          const texto = await fs.readFile(full, 'utf8');
          out.push({ rel: prefijo + e.name, texto: texto.slice(0, 100000) });
        } catch {
          // Ilegible: se ignora.
        }
      }
    }
  }
  await walk(dir, '');
  return out;
}

function normaliza(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Puntúa por palabras clave y devuelve los N documentos más relevantes. */
function eligeRelevantes(docs: KbDoc[], pregunta: string, n = 4): KbDoc[] {
  const palabras = normaliza(pregunta)
    .split(/\W+/)
    .filter((w) => w.length > 3);
  const puntuados = docs
    .map((d) => {
      const titulo = normaliza(d.rel);
      const cuerpo = normaliza(d.texto);
      let score = 0;
      for (const w of palabras) {
        if (titulo.includes(w)) score += 6;
        score += Math.min(10, cuerpo.split(w).length - 1);
      }
      return { d, score };
    })
    .sort((a, b) => b.score - a.score);

  const conScore = puntuados.filter((p) => p.score > 0).slice(0, n);
  const elegidos = conScore.length ? conScore : puntuados.slice(0, 2);
  return elegidos.map((p) => p.d);
}

/** Responde una pregunta de la KB con Copilot, en streaming al webview. */
async function kbAskCopilot(
  context: vscode.ExtensionContext,
  cfg: PortalConfig,
  msg: {
    reqId?: string;
    teamId?: string;
    teamNombre?: string;
    question?: string;
    foreign?: boolean;
  },
  post: (m: unknown) => void
): Promise<void> {
  const reqId = msg.reqId;
  const teamId = String(msg.teamId ?? '');
  try {
    const dir = kbTeamDir(context, cfg, teamId);
    let docs = await kbDocsLocales(dir);
    if (!docs.length) {
      // Primera vez: sincroniza y reintenta.
      await kbSyncTeam(context, cfg, teamId);
      docs = await kbDocsLocales(dir);
    }
    if (!docs.length) {
      throw new Error(
        'La KB local está vacía (¿carpeta de Drive sin documentos o sin configurar en la hoja Config?)'
      );
    }

    const relevantes = eligeRelevantes(docs, String(msg.question ?? ''));
    const contexto = relevantes
      .map((d) => `─── DOCUMENTO: ${d.rel} ───\n${d.texto.slice(0, 8000)}`)
      .join('\n\n');

    // Selección del modelo de Copilot (ajuste kddPortal.modeloCopilot).
    const modelos = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!modelos.length) {
      throw new Error(
        'No hay modelos de Copilot disponibles: instala la extensión GitHub Copilot e inicia sesión.'
      );
    }
    const filtro = cfg.modeloCopilot.toLowerCase();
    const modelo = filtro
      ? modelos.find((m) =>
          [m.id, m.family, m.name].some((x) =>
            String(x).toLowerCase().includes(filtro)
          )
        )
      : modelos[0];
    if (!modelo) {
      throw new Error(
        `Ningún modelo de Copilot coincide con «${cfg.modeloCopilot}». ` +
          'Disponibles: ' + modelos.map((m) => m.family).join(', ')
      );
    }

    const prompt = PROMPT_KB.replace('{EQUIPO}', msg.teamNombre || teamId)
      .replace('{RUTA_KB}', dir)
      .replace(
        '{AVISO}',
        msg.foreign
          ? 'ATENCIÓN: el usuario consulta la KB de OTRO equipo (versión reducida). Añade al final una línea avisando de que la información puede estar desactualizada o incompleta y debe confirmarse con el equipo propietario.'
          : 'Es la KB del propio equipo del usuario.'
      )
      .replace('{DOCUMENTOS}', contexto)
      .replace('{PREGUNTA}', String(msg.question ?? ''));

    const peticion = await modelo.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {},
      new vscode.CancellationTokenSource().token
    );
    for await (const trozo of peticion.text) {
      post({ type: 'kbChunk', reqId, text: trozo });
    }
    post({
      type: 'kbDone',
      reqId,
      sources: relevantes.map((d) => d.rel),
      modelo: modelo.family || modelo.id
    });
  } catch (err) {
    post({
      type: 'kbError',
      reqId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
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
