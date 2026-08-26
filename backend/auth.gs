/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KDD Portal · SESIONES — login real (action=auth) para despliegues
 *  restringidos al dominio ("Cualquier usuario de tu dominio")
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  El webview de VS Code hace fetch SIN sesión de Google, así que con la
 *  Web App desplegada como «Cualquier usuario de tu dominio» esas llamadas
 *  chocan con la pantalla de login de Google (ver DESPLIEGUE.md, 5bis). Esto
 *  resuelve el PRIMER contacto: la extensión abre action=auth en el
 *  NAVEGADOR REAL del usuario (vscode.env.openExternal) — ese sí lleva la
 *  sesión de Google — y aquí, dentro del script, Session.getActiveUser()
 *  identifica a la persona de forma fiable (lo pone Google, no se puede
 *  falsificar desde el cliente). Se crea una sesión propia (token
 *  aleatorio, sin relación con OAuth de Google) y la página redirige a
 *  vscode://<extensionId>/auth?data=... para devolver el control a VS Code.
 *
 *  Las llamadas siguientes del webview mandan ese token y el backend
 *  resuelve el email real con emailDeSesion_(token) en vez de fiarse del
 *  parámetro "email" que manda el cliente (ver resolveEmail_, usado desde
 *  doGet/doPost en router.gs). Sin sessionToken, todo se comporta EXACTAMENTE
 *  como antes (compatible hacia atrás).
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Extension ID (publisher.name de package.json) para construir el vscode://. */
var AUTH_EXTENSION_ID = 'kdd-demo.kdd-portal';

// ────────────────────────────────────────────────────── Sesiones (hoja) ──

/** Sesiones activas (no caducadas): { token: {email, caduca} }. Cache 5 min. */
function getSessionsCache_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('sesionesV1');
  if (cached) {
    return JSON.parse(cached);
  }

  var rows = getSheet_(CONFIG.SHEET_SESIONES).getDataRange().getValues().slice(1);
  var ahora = Date.now();
  var sesiones = {};
  rows.forEach(function (row) {
    var token = String(row[0] || '').trim();
    var caduca = row[3] ? new Date(row[3]).getTime() : 0;
    if (!token || !caduca || caduca < ahora) return;
    sesiones[token] = { email: String(row[1] || '').trim(), caduca: caduca };
  });

  cache.put('sesionesV1', JSON.stringify(sesiones), 300);
  return sesiones;
}

/** Email verificado de un token de sesión, o '' si no existe/ha caducado. */
function emailDeSesion_(token) {
  token = String(token || '').trim();
  if (!token) return '';
  var sesion = getSessionsCache_()[token];
  return sesion ? sesion.email : '';
}

/**
 * Email a usar en esta petición: el verificado por sesión si hay
 * sessionToken válido; si no, el que manda el cliente (compatibilidad
 * hacia atrás con instalaciones que aún no han hecho login).
 */
function resolveEmail_(p) {
  return emailDeSesion_(p.sessionToken) || String(p.email || '').trim();
}

/** Crea una sesión nueva para el email dado y devuelve su token. */
function crearSesion_(email) {
  var hoja = getSheet_(CONFIG.SHEET_SESIONES);
  limpiarSesionesCaducadas_(hoja);

  var token = Utilities.getUuid();
  var ahora = new Date();
  var caduca = new Date(ahora.getTime() + CONFIG.SESSION_HOURS * 3600 * 1000);
  hoja.appendRow([token, email, ahora.toISOString(), caduca.toISOString()]);

  // Invalida la caché ya: si no, la sesión recién creada podría no verse
  // como válida hasta que caduquen los 5 min de getSessionsCache_.
  CacheService.getScriptCache().remove('sesionesV1');
  return token;
}

/** Borra filas de sesión caducadas. Se llama en cada login (barato: 1/persona/día). */
function limpiarSesionesCaducadas_(hoja) {
  var datos = hoja.getDataRange().getValues();
  var ahora = Date.now();
  for (var i = datos.length - 1; i >= 1; i--) {
    var caduca = datos[i][3] ? new Date(datos[i][3]).getTime() : 0;
    if (!caduca || caduca < ahora) hoja.deleteRow(i + 1);
  }
}

// ────────────────────────────────────────────────────── action=auth ──────

/**
 * action=auth: se abre en el navegador REAL del usuario (no en el webview).
 * Identifica a quien llama vía Session.getActiveUser() y devuelve una
 * página HTML que redirige de vuelta a VS Code con el resultado.
 */
function handleAuthLogin_(p) {
  var state = String(p.state || '');
  try {
    checkToken_(p.token);
  } catch (err) {
    return authLandingPage_({ state: state, ok: false, error: String(err) });
  }

  var email = '';
  try {
    email = String(Session.getActiveUser().getEmail() || '').trim();
  } catch (err) {
    return authLandingPage_({
      state: state,
      ok: false,
      error: 'No se pudo obtener tu identidad de Google: ' + err
    });
  }
  if (!email) {
    return authLandingPage_({
      state: state,
      ok: false,
      error: 'Google no ha identificado ninguna cuenta en esta pestaña. ' +
        'Inicia sesión con tu cuenta corporativa e inténtalo de nuevo.'
    });
  }
  if (!getUserTeam_(email)) {
    return authLandingPage_({
      state: state,
      ok: false,
      error: 'Tu cuenta (' + email + ') no está en la hoja Usuarios del portal.'
    });
  }

  var token = crearSesion_(email);

  // Token OAuth REAL (de quien ejecuta el script, no de quien llama) para
  // que las llamadas normales del webview superen la puerta de acceso por
  // dominio: se manda como Authorization: Bearer desde el lado Node.js de
  // la extensión (sin CORS). sessionToken sigue siendo quien de verdad
  // identifica a la persona (resolveEmail_) — este token solo abre la
  // puerta de transporte. Caduca en ~1h (lo gestiona Apps Script); ver
  // action=refreshSharedToken y el aviso de DESPLIEGUE.md sobre este
  // trade-off (credencial personal compartida, no un cliente OAuth propio).
  var sharedBearerToken = '';
  try {
    sharedBearerToken = ScriptApp.getOAuthToken();
  } catch (err) {
    Logger.log('No se pudo obtener ScriptApp.getOAuthToken(): ' + err);
  }

  return authLandingPage_({
    state: state,
    ok: true,
    sessionToken: token,
    email: email,
    sharedBearerToken: sharedBearerToken
  });
}

/**
 * Página de resultado del login, con la identidad visual del portal: el
 * logo «N» de cinta plegada (el mismo media/logo.svg de la extensión,
 * embebido inline) y su paleta de degradados rosa→violeta→azul.
 * Redirige SIEMPRE a VS Code, también en error: la extensión necesita el
 * motivo exacto del rechazo (payload.error), no un timeout genérico.
 */
function authLandingPage_(payload) {
  var target =
    'vscode://' + AUTH_EXTENSION_ID + '/auth?data=' +
    encodeURIComponent(Utilities.base64Encode(JSON.stringify(payload)));
  var ok = payload.ok === true;

  // media/logo.svg de la extensión, inline (autocontenido, sin fetch).
  var logo =
    '<svg class="logo" viewBox="0 0 486 600" aria-hidden="true">' +
    '<defs>' +
    '<linearGradient id="gL" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#9c3a47"/><stop offset="1" stop-color="#ee7245"/></linearGradient>' +
    '<linearGradient id="gD" gradientUnits="userSpaceOnUse" x1="140" y1="20" x2="420" y2="560">' +
    '<stop offset="0" stop-color="#e03a60"/><stop offset="0.55" stop-color="#8d57c0"/>' +
    '<stop offset="1" stop-color="#5052cc"/></linearGradient>' +
    '<linearGradient id="gR" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#2e7ef5"/><stop offset="1" stop-color="#2b62e0"/></linearGradient>' +
    '</defs>' +
    '<polygon points="5,88 157,2 157,450 5,537" fill="url(#gL)"/>' +
    '<polygon points="5,88 157,2 481,511 329,598" fill="url(#gD)"/>' +
    '<polygon points="329,150 481,63 481,511 329,598" fill="url(#gR)"/>' +
    '</svg>';

  var html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>KDD Portal</title><style>',
    '*{box-sizing:border-box}',
    'body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;',
    'min-height:100vh;display:flex;align-items:center;justify-content:center;',
    'color:#e8e6f0;background:#0d1024;',
    'background-image:radial-gradient(600px 420px at 18% 8%,rgba(224,58,96,.28),transparent 65%),',
    'radial-gradient(640px 460px at 85% 20%,rgba(46,126,245,.25),transparent 65%),',
    'radial-gradient(720px 560px at 50% 110%,rgba(141,87,192,.30),transparent 70%)}',
    '.card{max-width:440px;width:calc(100% - 40px);padding:40px 36px 34px;text-align:center;',
    'background:rgba(19,22,45,.78);border:1px solid rgba(141,87,192,.35);border-radius:16px;',
    'box-shadow:0 24px 70px rgba(0,0,0,.55);backdrop-filter:blur(6px)}',
    '.brandbar{height:4px;border-radius:99px;margin:-40px -36px 30px;',
    'background:linear-gradient(90deg,#e03a60,#8d57c0 45%,#2e7ef5)}',
    '.logo{width:74px;height:auto;display:block;margin:0 auto 6px;',
    'filter:drop-shadow(0 8px 22px rgba(141,87,192,.55))}',
    '.marca{font-size:12px;letter-spacing:.28em;text-transform:uppercase;color:#9aa0c0;margin:0 0 22px}',
    '.estado{width:52px;height:52px;margin:0 auto 16px;border-radius:50%;display:flex;',
    'align-items:center;justify-content:center;font-size:24px;',
    'background:' + (ok
      ? 'linear-gradient(135deg,rgba(46,126,245,.25),rgba(137,209,133,.25));border:1px solid #89d185'
      : 'linear-gradient(135deg,rgba(224,58,96,.3),rgba(238,114,69,.25));border:1px solid #ee7245') + '}',
    'h1{font-size:21px;margin:0 0 10px;font-weight:700;',
    'background:linear-gradient(90deg,#ff7d9c,#b18ae8 45%,#6ea8ff);',
    '-webkit-background-clip:text;background-clip:text;color:transparent}',
    'p{font-size:13.5px;line-height:1.65;color:#b9bdd6;margin:0 0 6px;word-break:break-word}',
    '.correo{color:#fff;font-weight:600}',
    'a.btn{display:inline-block;margin-top:22px;padding:12px 34px;border-radius:10px;',
    'font-size:14px;font-weight:600;color:#fff;text-decoration:none;',
    'background:linear-gradient(90deg,#e03a60,#8d57c0 55%,#2e7ef5);',
    'box-shadow:0 10px 28px rgba(80,82,204,.45)}',
    'a.btn:hover{filter:brightness(1.12)}',
    '.pie{margin-top:22px;font-size:11px;color:#7c81a3}',
    '</style></head><body><div class="card">',
    '<div class="brandbar"></div>',
    logo,
    '<p class="marca">KDD Portal · NFQ</p>',
    '<div class="estado">' + (ok ? '✓' : '!') + '</div>',
    '<h1>' + escapeHtml_(ok ? 'Conectado a KDD Portal' : 'No se pudo conectar') + '</h1>',
    ok
      ? '<p>Identidad verificada como <span class="correo">' + escapeHtml_(payload.email) +
        '</span>.<br>Vuelve a VS Code — se abre solo; si no, pulsa el botón.</p>'
      : '<p>' + escapeHtml_(String(payload.error || 'Error desconocido.')) +
        '<br>Vuelve a VS Code para verlo — se abre solo; si no, pulsa el botón.</p>',
    '<a class="btn" href="' + target + '">Volver a VS Code</a>',
    '<p class="pie">Puedes cerrar esta pestaña cuando VS Code vuelva a estar en primer plano.</p>',
    '</div>',
    '<script>window.location.href=' + JSON.stringify(target) + ';</script>',
    '</body></html>'
  ].join('');

  return HtmlService.createHtmlOutput(html);
}

function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
