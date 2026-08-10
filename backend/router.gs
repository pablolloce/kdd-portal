/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KDD Portal · Backend Apps Script — ROUTER de la Web App
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Proyecto único de Apps Script con módulos separados:
 *    - router.gs       → doGet/doPost (este archivo)
 *    - config.gs       → CONFIG + hojas "Config" y "Usuarios" + setup()
 *    - chat.gs         → chat ↔ correo del Google Group de cada equipo
 *    - formaciones.gs  → Sheets + Calendar + aviso al grupo
 *    - kb.gs           → índice y descarga de la Knowledge Base desde Drive
 *
 *  CÓMO DESPLEGAR
 *  ──────────────
 *  1. script.google.com → proyecto nuevo → pega estos 5 archivos.
 *  2. Manifest: copia backend/appsscript.json (Configuración → mostrarlo).
 *  3. Rellena CONFIG en config.gs (spreadsheet, calendario del área).
 *  4. Ejecuta setup() una vez: crea las hojas Config / Usuarios /
 *     Formaciones / Asistentes con cabeceras y filas de ejemplo.
 *  5. Rellena la hoja "Config" (un equipo por fila: grupo, carpeta de KB…)
 *     y la hoja "Usuarios" (email → equipo).
 *  6. Implementar → Aplicación web → copia la URL /exec en APPS_SCRIPT_URL
 *     de media/main.js (extensión) y pon MOCK_MODE = false.
 *
 *  CORS: las Web Apps responden CORS abierto en peticiones "simples"; el
 *  cliente envía los POST como text/plain (sin preflight, que Apps Script
 *  no soporta) con el JSON en el body.
 *
 *  ACCIONES
 *  ────────
 *   GET  ?action=ping
 *   GET  ?action=getUserInfo&email=…          → { team }
 *   GET  ?action=getChat&team=…               → { messages[] }
 *   GET  ?action=getFormaciones&email=…       → { formaciones[] } (globales)
 *   GET  ?action=getKbIndex&team=…            → { files[] }  (KB en Drive)
 *   GET  ?action=getKbFile&team=…&fileId=…    → { file: {name,path,content} }
 *   POST {action:'sendMessage', team, name, email, text}
 *   POST {action:'createFormacion', team, name, email, titulo, fecha, descripcion}
 *   POST {action:'rsvp', email, id}
 * ═══════════════════════════════════════════════════════════════════════════
 */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    switch (p.action || '') {
      case 'ping':
        return jsonOut_({ ok: true, pong: new Date().toISOString() });
      case 'getUserInfo':
        return jsonOut_({ ok: true, team: getUserTeam_(p.email) });
      case 'getChat':
        return jsonOut_({ ok: true, messages: getChat_(requireTeam_(p.team)) });
      case 'getFormaciones':
        return jsonOut_({ ok: true, formaciones: getFormaciones_(p.email) });
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
