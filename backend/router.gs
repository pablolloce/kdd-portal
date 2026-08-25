/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KDD Portal · Backend Apps Script — ROUTER de la Web App
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Proyecto único de Apps Script con módulos separados:
 *    - router.gs       → doGet/doPost (este archivo)
 *    - config.gs       → CONFIG + hojas "Config" y "Usuarios" + setup()
 *    - auth.gs         → login real (action=auth) para despliegues
 *                        restringidos al dominio + hoja "Sesiones"
 *    - chat.gs         → chat ↔ correo del Google Group de cada equipo
 *    - formaciones.gs  → Sheets + Calendar + aviso al grupo
 *    - kb.gs           → índice y descarga de la Knowledge Base desde Drive
 *    - tra.gs          → informe TRA de imputaciones (origen del Looker)
 *
 *  CÓMO DESPLEGAR
 *  ──────────────
 *  1. script.google.com → proyecto nuevo → pega estos 7 archivos.
 *  2. Manifest: copia backend/appsscript.json (Configuración → mostrarlo).
 *  3. Rellena CONFIG en config.gs (spreadsheet, calendario del área).
 *  4. Ejecuta setup() una vez: crea las hojas Config / Usuarios /
 *     Formaciones / Asistentes / Sesiones con cabeceras y filas de ejemplo.
 *  5. Rellena la hoja "Config" (un equipo por fila: grupo, carpeta de KB…)
 *     y la hoja "Usuarios" (email → equipo).
 *  6. Implementar → Aplicación web → copia la URL /exec en APPS_SCRIPT_URL
 *     de media/main.js (extensión) y pon MOCK_MODE = false.
 *
 *  CORS: las Web Apps responden CORS abierto en peticiones "simples"; el
 *  cliente envía los POST como text/plain (sin preflight, que Apps Script
 *  no soporta) con el JSON en el body.
 *
 *  ACCESO POR DOMINIO Y LOGIN: ver DESPLIEGUE.md 5bis/6ter y auth.gs — el
 *  webview no tiene sesión de Google, así que con la Web App restringida
 *  al dominio, la extensión pasa primero por action=auth (navegador real
 *  del usuario) antes de poder llamar al resto de acciones con éxito.
 *  Un sessionToken válido NO basta para superar esa puerta por sí solo
 *  (Google la exige a nivel de transporte, antes de que este código se
 *  ejecute): action=auth también entrega un sharedBearerToken real
 *  (ScriptApp.getOAuthToken(), la identidad de quien despliega, no de
 *  quien llama) que el lado Node.js de la extensión manda como
 *  Authorization: Bearer en cada llamada — ES UN TRADE-OFF DELIBERADO
 *  (credencial personal compartida, no un cliente OAuth propio; caduca
 *  en ~1h, refrescable con action=refreshSharedToken) mientras no haya
 *  Client ID de Cloud Console disponible. Ver el aviso completo en
 *  DESPLIEGUE.md 6ter.
 *
 *  ACCIONES
 *  ────────
 *   GET  ?action=ping
 *   GET  ?action=auth&state=…                 → HTML (login, ver auth.gs)
 *   GET  ?action=refreshSharedToken            → { sharedBearerToken }
 *   GET  ?action=getUserInfo&email=…          → { team }
 *   GET  ?action=getTeams                     → { teams[] } (hoja Config)
 *   GET  ?action=getChat&team=…               → { messages[] }
 *   GET  ?action=getFormaciones&email=…       → { formaciones[] } (globales)
 *   GET  ?action=getTra                       → { rows[] } (informe TRA)
 *   GET  ?action=getKbIndex&team=…            → { files[] }  (KB en Drive)
 *   GET  ?action=getKbFile&team=…&fileId=…    → { file: {name,path,content} }
 *   POST {action:'sendMessage', team, name, email, text}
 *   POST {action:'createFormacion', team, name, email, titulo, fecha, descripcion}
 *   POST {action:'rsvp', email, id}
 *
 *  Todas las acciones (salvo auth) aceptan opcionalmente `sessionToken`
 *  (del login): si es válido, su email verificado sustituye al parámetro
 *  `email` — ver resolveEmail_ en auth.gs.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Token compartido OPCIONAL. Si defines la propiedad de script
 * TOKEN_ACCESO (Configuración del proyecto → Propiedades del script),
 * toda petición debe traer ese valor (parámetro `token` en GET, campo
 * `token` en el body de los POST; la extensión lo envía desde el ajuste
 * kddPortal.tokenAcceso). Recomendado si la Web App se despliega con
 * acceso «Cualquier persona»: la URL + token actúan de credencial.
 * Sin la propiedad definida, no se exige token (compatible hacia atrás).
 */
function checkToken_(provided) {
  var esperado =
    PropertiesService.getScriptProperties().getProperty('TOKEN_ACCESO');
  if (esperado && String(provided || '') !== esperado) {
    throw new Error('Token de acceso inválido o ausente');
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  // action=auth se abre en el navegador REAL del usuario (no en el webview,
  // que no tiene sesión de Google) y siempre debe devolver una página HTML,
  // incluso si falla: se gestiona aparte, antes del catch-all que responde
  // JSON. Ver auth.gs.
  if ((p.action || '') === 'auth') {
    return handleAuthLogin_(p);
  }
  try {
    checkToken_(p.token);
    // Prioriza el email verificado por sesión (login real) sobre el que
    // manda el cliente; sin sessionToken, se comporta como siempre.
    p.email = resolveEmail_(p);
    switch (p.action || '') {
      case 'ping':
        return jsonOut_({ ok: true, pong: new Date().toISOString() });
      case 'refreshSharedToken':
        // Llegar hasta aquí ya exigía un Bearer válido (o cookies de
        // navegador) para superar la puerta de acceso por dominio, así
        // que no hace falta comprobar nada más: solo se pide una copia
        // fresca del mismo token compartido antes de que caduque (~1h).
        return jsonOut_({ ok: true, sharedBearerToken: ScriptApp.getOAuthToken() });
      case 'getUserInfo':
        return jsonOut_({ ok: true, team: getUserTeam_(p.email) });
      case 'getTeams':
        return jsonOut_({ ok: true, teams: getTeams_() });
      case 'getChat':
        return jsonOut_({ ok: true, messages: getChat_(requireTeam_(p.team)) });
      case 'getFormaciones':
        return jsonOut_({ ok: true, formaciones: getFormaciones_(p.email) });
      case 'getTra':
        return jsonOut_(Object.assign({ ok: true }, getTra_()));
      case 'getKbIndex':
        return jsonOut_({ ok: true, files: getKbIndex_(requireTeam_(p.team)) });
      case 'getKbFile':
        return jsonOut_({ ok: true, file: getKbFile_(requireTeam_(p.team), p.fileId) });
      default:
        return jsonOut_({ ok: false, error: 'Acción GET desconocida: ' + (p.action || '(vacía)') });
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    checkToken_(body.token);
    body.email = resolveEmail_(body);
    switch (body.action || '') {
      case 'sendMessage':
        sendChatMessage_(requireTeam_(body.team), body.name, body.email, body.text);
        return jsonOut_({ ok: true });
      case 'createFormacion':
        return jsonOut_({ ok: true, formacion: createFormacion_(body) });
      case 'rsvp':
        return jsonOut_({ ok: true, formacion: rsvpFormacion_(body) });
      default:
        return jsonOut_({ ok: false, error: 'Acción POST desconocida: ' + (body.action || '(vacía)') });
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/** Respuesta JSON estándar (ContentService). */
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Valida que el equipo existe en la hoja Config y devuelve su id. */
function requireTeam_(teamId) {
  getTeamConfig_(teamId); // lanza error si no existe
  return teamId;
}
