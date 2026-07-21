/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Team Hub — Backend en Google Apps Script (Web App)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  ⚠️  NOTA: la extensión de VS Code funciona ahora en MODO MOCK y no llama
 *  a este backend. Este archivo queda listo para cuando se active el modo
 *  real (MOCK_MODE = false en media/main.js + URL del despliegue).
 *
 *  CÓMO DESPLEGAR
 *  ──────────────
 *  1. Crea un proyecto en https://script.google.com y pega este archivo.
 *  2. Copia backend/appsscript.json en el manifest del proyecto
 *     (Configuración del proyecto → mostrar "appsscript.json").
 *  3. Rellena las constantes de CONFIG (abajo).
 *  4. Ejecuta una vez setup() para crear las hojas con cabeceras.
 *  5. Implementar → Nueva implementación → Aplicación web:
 *       - Ejecutar como: tú (el propietario)
 *       - Acceso: según tu caso (dominio o "Cualquiera")
 *  6. Copia la URL /exec en APPS_SCRIPT_URL de media/main.js.
 *
 *  PERMISOS OAUTH (scopes) — ver también appsscript.json:
 *  ──────────────────────────────────────────────────────
 *   - https://www.googleapis.com/auth/spreadsheets      → leer/escribir Sheets
 *   - https://www.googleapis.com/auth/calendar          → crear eventos/invitados
 *   - https://mail.google.com/                          → GmailApp (leer hilos del grupo)
 *   - https://www.googleapis.com/auth/script.send_mail  → MailApp (enviar correos)
 *
 *  CORS
 *  ────
 *  ContentService no permite añadir cabeceras arbitrarias, pero las Web Apps
 *  de Apps Script ya responden con CORS abierto en peticiones "simples".
 *  Por eso el cliente envía los POST con Content-Type: text/plain (sin
 *  preflight OPTIONS, que Apps Script no soporta) y el JSON va en el body.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ───────────────────────────────────────────────────────────── CONFIG ──────

/*
 * NOTA MULTI-EQUIPO: la extensión envía en cada petición un parámetro
 * `team` (id del equipo activo). Para soportar varios equipos en real,
 * convierte GROUP_EMAIL y CALENDAR_ID en mapas { teamId: valor } y
 * resuélvelos con ese parámetro; las hojas pueden compartirse añadiendo
 * una columna "Equipo".
 */
var CONFIG = {
  /** ID del spreadsheet que actúa de base de datos. */
  SPREADSHEET_ID: 'PEGA_AQUI_EL_ID_DEL_SPREADSHEET',

  /** ID del calendario compartido del equipo (o 'primary'). */
  CALENDAR_ID: 'PEGA_AQUI_EL_ID_DEL_CALENDARIO',

  /** Dirección del Google Group que hace de "chat" del equipo. */
  GROUP_EMAIL: 'equipo@googlegroups.com',

  /** Prefijo de asunto para distinguir los correos del chat. */
  CHAT_SUBJECT: '[TeamHub Chat]',

  /** Máximo de hilos/mensajes a devolver en getChat. */
  MAX_CHAT_MESSAGES: 50,

  /** Duración por defecto de una formación (minutos). */
  DEFAULT_DURATION_MIN: 60,

  SHEET_FORMACIONES: 'Formaciones',
  SHEET_ASISTENTES: 'Asistentes'
};

// ─────────────────────────────────────────────────────────── ROUTING ───────

/**
 * GET → acciones de lectura.
 *   ?action=getChat
 *   ?action=getFormaciones&email=usuario@dominio.com
 */
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || '';
    var email = (e && e.parameter && e.parameter.email) || '';

    switch (action) {
      case 'getChat':
        return jsonOut_({ ok: true, messages: getChat_() });
      case 'getFormaciones':
        return jsonOut_({ ok: true, formaciones: getFormaciones_(email) });
      case 'ping':
        return jsonOut_({ ok: true, pong: new Date().toISOString() });
      default:
        return jsonOut_({ ok: false, error: 'Acción GET desconocida: ' + action });
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/**
 * POST → acciones de escritura. El body llega como JSON en texto plano:
 *   { action: 'sendMessage', email, name, text }
 *   { action: 'createFormacion', email, name, titulo, fecha, descripcion }
 *   { action: 'rsvp', email, name, id }
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action || '';

    switch (action) {
      case 'sendMessage':
        sendChatMessage_(body.name, body.email, body.text);
        return jsonOut_({ ok: true });
      case 'createFormacion':
        return jsonOut_({ ok: true, formacion: createFormacion_(body) });
      case 'rsvp':
        return jsonOut_({ ok: true, formacion: rsvpFormacion_(body) });
      default:
        return jsonOut_({ ok: false, error: 'Acción POST desconocida: ' + action });
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

// ─────────────────────────────────────────── CHAT (Google Grupos/Gmail) ────

/**
 * Lee los últimos correos del Google Group cuyo asunto empieza por
 * CONFIG.CHAT_SUBJECT y los devuelve como mensajes de chat.
 */
function getChat_() {
  var query = 'to:"' + CONFIG.GROUP_EMAIL + '" subject:"' + CONFIG.CHAT_SUBJECT + '"';
  var threads = GmailApp.search(query, 0, 20);
  var out = [];

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var from = msg.getFrom(); // "Nombre <correo@dominio.com>"
      var match = from.match(/^\s*"?([^"<]*)"?\s*<(.+)>\s*$/);
      var name = match ? match[1].trim() : from;
      var email = match ? match[2].trim() : from;

      out.push({
        id: msg.getId(),
        sender: name || email,
        email: email,
        text: cleanBody_(msg.getPlainBody()),
        date: msg.getDate().getTime()
      });
    });
  });

  out.sort(function (a, b) { return a.date - b.date; });
  return out.slice(-CONFIG.MAX_CHAT_MESSAGES);
}

/** Envía un mensaje del usuario al buzón del Google Group. */
function sendChatMessage_(name, email, text) {
  if (!text) throw new Error('Mensaje vacío');
  MailApp.sendEmail({
    to: CONFIG.GROUP_EMAIL,
    subject: CONFIG.CHAT_SUBJECT + ' ' + name,
    body: text + '\n\n— ' + name + ' <' + email + '> vía Team Hub',
    name: 'Team Hub · ' + name
  });
}

/** Limpia firmas/citas típicas del cuerpo de un correo. */
function cleanBody_(body) {
  var text = (body || '').split(/\n--\s*\n/)[0]; // corta la firma "-- "
  text = text.split(/\nEl .+ escribió:\n/)[0];    // corta la cita en respuestas
  text = text.replace(/\n>+.*$/gm, '');           // quita líneas citadas "> "
  text = text.replace(/— .+ vía Team Hub\s*$/, '');
  return text.trim().slice(0, 2000);
}

// ─────────────────────────────── FORMACIONES (Calendar + Sheets) ───────────

/**
 * Devuelve las formaciones futuras registradas en la hoja "Formaciones",
 * con el nº de asistentes y si `userEmail` ya está apuntado.
 *
 * Columnas de "Formaciones":
 *   A: ID | B: Titulo | C: FechaISO | D: Descripcion
 *   E: EventoCalendarId | F: Creador | G: CreadoEl
 */
function getFormaciones_(userEmail) {
  var sheet = getSheet_(CONFIG.SHEET_FORMACIONES);
  var rows = sheet.getDataRange().getValues().slice(1); // sin cabecera
  var asistentes = getAsistentesIndex_();
  var ayer = Date.now() - 24 * 60 * 60 * 1000;

  return rows
    .filter(function (row) {
      return row[0] && new Date(row[2]).getTime() > ayer;
    })
    .map(function (row) {
      var id = String(row[0]);
      var lista = asistentes[id] || [];
      return {
        id: id,
        titulo: row[1],
        fecha: new Date(row[2]).toISOString(),
        descripcion: row[3],
        creador: row[5],
        asistentes: lista.length,
        apuntado: userEmail ? lista.indexOf(userEmail) !== -1 : false
      };
    })
    .sort(function (a, b) { return new Date(a.fecha) - new Date(b.fecha); });
}

/**
 * Crea una formación:
 *  1. Fila en la hoja "Formaciones".
 *  2. Evento en el calendario compartido.
 *  3. Correo de aviso al Google Group.
 */
function createFormacion_(body) {
  if (!body.titulo || !body.fecha) {
    throw new Error('Faltan título o fecha');
  }

  var inicio = new Date(body.fecha);
  var fin = new Date(inicio.getTime() + CONFIG.DEFAULT_DURATION_MIN * 60000);
  var id = Utilities.getUuid();

  // 2) Evento en Calendar (antes que la fila, para guardar su ID).
  var calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var evento = calendar.createEvent(body.titulo, inicio, fin, {
    description: (body.descripcion || '') + '\n\nCreado desde Team Hub por ' + body.name
  });

  // 1) Registro en Sheets.
  getSheet_(CONFIG.SHEET_FORMACIONES).appendRow([
    id, body.titulo, inicio.toISOString(), body.descripcion || '',
    evento.getId(), body.name, new Date().toISOString()
  ]);

  // El creador queda apuntado automáticamente.
  evento.addGuest(body.email);
  getSheet_(CONFIG.SHEET_ASISTENTES)
    .appendRow([id, body.email, new Date().toISOString()]);

  // 3) Aviso al grupo.
  MailApp.sendEmail({
    to: CONFIG.GROUP_EMAIL,
    subject: '[TeamHub] Nueva formación: ' + body.titulo,
    body:
      'Se ha publicado una nueva formación:\n\n' +
      '  📚 ' + body.titulo + '\n' +
      '  🗓️ ' + Utilities.formatDate(inicio, Session.getScriptTimeZone(),
        "EEEE d 'de' MMMM, HH:mm") + '\n\n' +
      (body.descripcion || '') + '\n\n' +
      'Apúntate desde el panel Team Hub de VS Code.',
    name: 'Team Hub'
  });

  return {
    id: id,
    titulo: body.titulo,
    fecha: inicio.toISOString(),
    descripcion: body.descripcion || '',
    creador: body.name,
    asistentes: 1,
    apuntado: true
  };
}

/**
 * Inscribe a un usuario en una formación:
 *  1. Lo añade como invitado al evento de Calendar.
 *  2. Registra la asistencia en la hoja "Asistentes".
 */
function rsvpFormacion_(body) {
  var sheet = getSheet_(CONFIG.SHEET_FORMACIONES);
  var rows = sheet.getDataRange().getValues();
  var row = null;

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(body.id)) {
      row = rows[i];
      break;
    }
  }
  if (!row) throw new Error('Formación no encontrada: ' + body.id);

  // Evita inscripciones duplicadas.
  var asistentes = getAsistentesIndex_()[String(body.id)] || [];
  if (asistentes.indexOf(body.email) === -1) {
    var evento = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID)
      .getEventById(row[4]);
    if (evento) evento.addGuest(body.email);

    getSheet_(CONFIG.SHEET_ASISTENTES)
      .appendRow([String(body.id), body.email, new Date().toISOString()]);
    asistentes.push(body.email);
  }

  return {
    id: String(body.id),
    titulo: row[1],
    fecha: new Date(row[2]).toISOString(),
    descripcion: row[3],
    creador: row[5],
    asistentes: asistentes.length,
    apuntado: true
  };
}

// ─────────────────────────────────────────────────────── SHEETS helpers ────

function getSheet_(name) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Falta la hoja "' + name + '". Ejecuta setup().');
  return sheet;
}

/** Índice { formacionId: [email, …] } a partir de la hoja "Asistentes". */
function getAsistentesIndex_() {
  var sheet = getSheet_(CONFIG.SHEET_ASISTENTES);
  var rows = sheet.getDataRange().getValues().slice(1);
  var index = {};
  rows.forEach(function (row) {
    if (!row[0]) return;
    var id = String(row[0]);
    (index[id] = index[id] || []).push(String(row[1]));
  });
  return index;
}

/**
 * Ejecutar UNA VEZ a mano desde el editor de Apps Script: crea las hojas
 * "Formaciones" y "Asistentes" con sus cabeceras si no existen.
 */
function setup() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  if (!ss.getSheetByName(CONFIG.SHEET_FORMACIONES)) {
    ss.insertSheet(CONFIG.SHEET_FORMACIONES).appendRow([
      'ID', 'Titulo', 'FechaISO', 'Descripcion',
      'EventoCalendarId', 'Creador', 'CreadoEl'
    ]);
  }
  if (!ss.getSheetByName(CONFIG.SHEET_ASISTENTES)) {
    ss.insertSheet(CONFIG.SHEET_ASISTENTES).appendRow([
      'FormacionID', 'Email', 'FechaInscripcion'
    ]);
  }
}
