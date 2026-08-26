/**
 * ════════════════════════════════════════════════════════════════════════════════════
 *  KDD Portal · CONFIGURACIÓN — hojas "Config" y "Usuarios"
 * ════════════════════════════════════════════════════════════════════════════════════
 *
 *  La hoja "Config" es la base de datos de aplicativos/equipos del área:
 *  qué Google Group usa cada equipo para el chat, qué carpeta de Drive
 *  contiene su Knowledge Base y (opcional) su calendario propio.
 *
 *    Config:   TeamId | Nombre | GroupEmail | KbDriveFolderId | CalendarId
 *    Usuarios: Email  | Equipo
 *
 *  La hoja "Usuarios" resuelve a qué equipo pertenece cada persona
 *  (action=getUserInfo): con ello la extensión decide qué KB completa
 *  mostrar y cuáles son ajenas (reducidas).
 * ════════════════════════════════════════════════════════════════════════════════════
 */

var CONFIG = {
  /** ID del spreadsheet que actúa de base de datos del área. */
  SPREADSHEET_ID: 'PEGA_AQUI_EL_ID_DEL_SPREADSHEET',

  /** Calendario compartido del ÁREA (fallback si un equipo no define el suyo). */
  CALENDAR_ID: 'PEGA_AQUI_EL_ID_DEL_CALENDARIO',

  /** Prefijo de asunto para distinguir los correos del chat. */
  CHAT_SUBJECT: '[KDDPortal Chat]',

  /** Máximo de mensajes a devolver en getChat. */
  MAX_CHAT_MESSAGES: 50,

  /** Segundos de caché para lecturas repetitivas (polling del chat). */
  CHAT_CACHE_SECONDS: 15,

  /** Duración por defecto de una formación (minutos). */
  DEFAULT_DURATION_MIN: 60,

  /** Límite de tamaño al exportar un documento de la KB (caracteres). */
  KB_MAX_CHARS: 200000,

  /** Horas de validez de una sesión creada por el login (action=auth). */
  SESSION_HOURS: 24,

  SHEET_FORMACIONES: 'Formaciones',
  SHEET_ASISTENTES: 'Asistentes',
  SHEET_USUARIOS: 'Usuarios',
  SHEET_CONFIG: 'Config',
  SHEET_SESIONES: 'Sesiones'
};

// ─────────────────────────────────── Config de equipos ──────

/**
 * Lee la hoja "Config" y devuelve { teamId: {teamId, nombre, groupEmail,
 * kbFolderId, calendarId} }. Cacheado 5 minutos para no releer la hoja en
 * cada polling.
 */
function getTeamsConfig_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('teamsCfgV2');
  if (cached) {
    return JSON.parse(cached);
  }

  var rows = getSheet_(CONFIG.SHEET_CONFIG).getDataRange().getValues().slice(1);
  var teams = {};
  rows.forEach(function (row) {
    var teamId = String(row[0] || '').trim();
    // Ignora filas sin TeamId y las de texto libre (p.ej. la fila de
    // instrucciones de la plantilla): un TeamId real nunca lleva
    // espacios (ver "sin espacios" en DESPLIEGUE.md), así que cualquier
    // frase con espacios no es un equipo y no debe llegar a la extensión.
    if (!teamId || /\s/.test(teamId)) return;
    teams[teamId] = {
      teamId: teamId,
      nombre: String(row[1] || ''),
      groupEmail: String(row[2] || '').trim(),
      kbFolderId: String(row[3] || '').trim(),
      calendarId: String(row[4] || '').trim() || CONFIG.CALENDAR_ID,
      icono: String(row[5] || '').trim() // columna F opcional: emoji del equipo
    };
  });

  cache.put('teamsCfgV2', JSON.stringify(teams), 300);
  return teams;
}

/**
 * Lista de equipos para la extensión (action=getTeams): la hoja Config es
 * la única fuente de verdad — añadir un equipo = añadir una fila, sin
 * tocar código. Incluye el nº de miembros (hoja Usuarios) y si tiene KB.
 */
function getTeams_() {
  var teams = getTeamsConfig_();
  var usuarios = getSheet_(CONFIG.SHEET_USUARIOS).getDataRange().getValues().slice(1);
  var miembros = {};
  usuarios.forEach(function (row) {
    if (!row[0]) return;
    var equipo = String(row[1] || '').trim();
    miembros[equipo] = (miembros[equipo] || 0) + 1;
  });

  return Object.keys(teams).map(function (id) {
    var t = teams[id];
    var hasKb = Boolean(t.kbFolderId) && t.kbFolderId.indexOf('PEGA_') === -1;
    return {
      teamId: t.teamId,
      nombre: t.nombre,
      grupo: t.groupEmail,
      icono: t.icono,
      miembros: miembros[id] || 0,
      hasKb: hasKb,
      // Id de la carpeta de Drive de la KB: la extensión lo usa para el
      // botón «Drive ↗» (abrir la carpeta en el navegador). El id no da
      // acceso por sí solo — los permisos los sigue mandando Drive.
      kbFolder: hasKb ? t.kbFolderId : ''
    };
  });
}

/** Config de un equipo concreto; lanza error si no está dado de alta. */
function getTeamConfig_(teamId) {
  var team = getTeamsConfig_()[String(teamId || '').trim()];
  if (!team) {
    throw new Error('Equipo no configurado en la hoja Config: ' + teamId);
  }
  return team;
}

// ───────────────────────────────────────── Usuarios ──────

/**
 * Devuelve el id de equipo del usuario según la hoja "Usuarios".
 * Es lo que permite a la extensión saber qué Knowledge Base completa
 * mostrar y cuáles son ajenas (reducidas).
 */
function getUserTeam_(email) {
  if (!email) return '';
  var rows = getSheet_(CONFIG.SHEET_USUARIOS).getDataRange().getValues().slice(1);
  var normalizado = String(email).trim().toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === normalizado) {
      return String(rows[i][1] || '');
    }
  }
  return '';
}

// ─────────────────────────────────────── Sheets helpers ──────

function getSheet_(name) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Falta la hoja "' + name + '". Ejecuta setup().');
  return sheet;
}

/**
 * Ejecutar UNA VEZ a mano desde el editor: crea las hojas con cabeceras y
 * filas de ejemplo (los 4 equipos del área) si no existen.
 */
function setup() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  if (!ss.getSheetByName(CONFIG.SHEET_CONFIG)) {
    var cfg = ss.insertSheet(CONFIG.SHEET_CONFIG);
    cfg.appendRow(['TeamId', 'Nombre', 'GroupEmail', 'KbDriveFolderId', 'CalendarId']);
    cfg.appendRow(['front-office', 'Front Office (Murex)', 'fo-murex@tudominio.com', 'ID_CARPETA_DRIVE_FO', '']);
    cfg.appendRow(['liquidez', 'Liquidez y Pagos', 'liquidez-pagos@tudominio.com', 'ID_CARPETA_DRIVE_LIQ', '']);
    cfg.appendRow(['riesgos', 'Riesgos y Límites', 'riesgos-limites@tudominio.com', 'ID_CARPETA_DRIVE_RIE', '']);
    cfg.appendRow(['back-office', 'Back Office y Conciliación', 'bo-conciliacion@tudominio.com', 'ID_CARPETA_DRIVE_BO', '']);
  }
  if (!ss.getSheetByName(CONFIG.SHEET_USUARIOS)) {
    var usu = ss.insertSheet(CONFIG.SHEET_USUARIOS);
    usu.appendRow(['Email', 'Equipo']);
    usu.appendRow(['maria.dev@tudominio.com', 'front-office']);
  }
  if (!ss.getSheetByName(CONFIG.SHEET_FORMACIONES)) {
    ss.insertSheet(CONFIG.SHEET_FORMACIONES).appendRow([
      'ID', 'Titulo', 'FechaISO', 'Descripcion',
      'EventoCalendarId', 'Creador', 'CreadoEl', 'Equipo'
    ]);
  }
  if (!ss.getSheetByName(CONFIG.SHEET_ASISTENTES)) {
    ss.insertSheet(CONFIG.SHEET_ASISTENTES).appendRow([
      'FormacionID', 'Email', 'FechaInscripcion'
    ]);
  }
  if (!ss.getSheetByName(CONFIG.SHEET_SESIONES)) {
    // La rellena crearSesion_ (login vía action=auth); no tocarla a mano.
    ss.insertSheet(CONFIG.SHEET_SESIONES).appendRow([
      'Token', 'Email', 'CreadoEl', 'CaducaEl'
    ]);
  }
  // El informe TRA (proyectos y personas) vive en su propio spreadsheet:
  // ver TRA_CONFIG en tra.gs. No necesita hojas aquí.
}
