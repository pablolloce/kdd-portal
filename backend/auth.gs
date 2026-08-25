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
  return authLandingPage_({ state: state, ok: true, sessionToken: token, email: email });
}

/** Página HTML mínima y autocontenida que redirige a VS Code con el resultado. */
function authLandingPage_(payload) {
  var target =
    'vscode://' + AUTH_EXTENSION_ID + '/auth?data=' +
    encodeURIComponent(Utilities.base64Encode(JSON.stringify(payload)));
  var ok = payload.ok === true;

  var html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>KDD Portal</title><style>',
    'body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#1e1e1e;',
    'color:#ddd;display:flex;align-items:center;justify-content:center;',
    'min-height:100vh;margin:0}',
    '.card{max-width:420px;padding:32px;text-align:center}',
    '.icon{font-size:40px;margin-bottom:12px}',
    'h1{font-size:18px;margin:0 0 8px}',
    'p{font-size:13px;line-height:1.5;color:#aaa;word-break:break-word}',
    'a.btn{display:inline-block;margin-top:18px;padding:10px 22px;border-radius:6px;',
    'background:#0e639c;color:#fff;text-decoration:none;font-size:13px}',
    '</style></head><body><div class="card">',
    '<div class="icon">' + (ok ? '✅' : '⚠️') + '</div>',
    '<h1>' + escapeHtml_(ok ? 'Conectado a KDD Portal' : 'No se pudo conectar') + '</h1>',
    '<p>' + escapeHtml_(ok
      ? 'Identidad verificada como ' + payload.email + '. Vuelve a VS Code (se abre solo; si no, pulsa el botón).'
      : String(payload.error || 'Error desconocido.') + ' Vuelve a VS Code para verlo (se abre solo; si no, pulsa el botón).') + '</p>',
    // Redirige SIEMPRE, también si ok es false: la extensión necesita el
    // motivo exacto del rechazo (payload.error) para mostrarlo, no solo un
    // timeout genérico a los 60s.
    '<a class="btn" href="' + target + '">Volver a VS Code</a>',
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
