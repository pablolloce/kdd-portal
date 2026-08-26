/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KDD Portal · FORMACIONES — Sheets + Calendar + aviso al grupo
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Las formaciones son GLOBALES del área: una única hoja "Formaciones" con
 *  la columna "Equipo" (equipo organizador). El calendario usado es el del
 *  equipo organizador si lo define en la hoja Config; si no, el del área
 *  (CONFIG.CALENDAR_ID). El aviso de nueva formación se envía al Google
 *  Group del equipo organizador.
 *
 *  Columnas de "Formaciones":
 *   A: ID | B: Titulo | C: FechaISO | D: Descripcion
 *   E: EventoCalendarId | F: Creador | G: CreadoEl | H: Equipo
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Devuelve TODAS las formaciones futuras del área con el equipo
 * organizador, el nº de asistentes y si `userEmail` ya está apuntado.
 * El filtrado por equipo (pantalla de equipo) se hace en la extensión;
 * el calendario del menú las muestra todas.
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
        teamId: String(row[7] || ''),
        asistentes: lista.length,
        apuntado: userEmail ? lista.indexOf(userEmail) !== -1 : false
      };
    })
    .sort(function (a, b) { return new Date(a.fecha) - new Date(b.fecha); });
}

/**
 * Crea una formación:
 *  1. Evento en el calendario (del equipo organizador o del área).
 *  2. Fila en la hoja "Formaciones" (+ creador como primer asistente).
 *  3. Correo de aviso al Google Group del equipo organizador.
 */
function createFormacion_(body) {
  if (!body.titulo || !body.fecha) {
    throw new Error('Faltan título o fecha');
  }
  var team = getTeamConfig_(body.team);

  var inicio = new Date(body.fecha);
  var fin = new Date(inicio.getTime() + CONFIG.DEFAULT_DURATION_MIN * 60000);
  var id = Utilities.getUuid();

  // 1) Evento en Calendar — OPCIONAL: si el equipo/área no tiene
  // calendario configurado (vacío o placeholder), la formación se
  // registra igualmente solo en Sheets. El MOTIVO de no crear evento se
  // devuelve como aviso: en silencio parecía un fallo del portal.
  var evento = null;
  var motivoSinEvento = '';
  if (!esCalendarValido_(team.calendarId)) {
    motivoSinEvento =
      'no hay calendario configurado (columna CalendarId de la hoja Config ' +
      'del equipo, o CONFIG.CALENDAR_ID del área en config.gs)';
  } else {
    var calendar = CalendarApp.getCalendarById(team.calendarId);
    if (!calendar) {
      motivoSinEvento =
        'la cuenta que ejecuta la Web App no ve el calendario «' +
        team.calendarId + '» (¿compartido con permiso «Hacer cambios en eventos»?)';
    } else {
      evento = calendar.createEvent(body.titulo, inicio, fin, {
        description:
          (body.descripcion || '') +
          '\n\nCreado desde KDD Portal por ' + body.name
      });
    }
  }

  // 2) Registro en Sheets.
  getSheet_(CONFIG.SHEET_FORMACIONES).appendRow([
    id, body.titulo, inicio.toISOString(), body.descripcion || '',
    evento ? evento.getId() : '', body.name, new Date().toISOString(), body.team
  ]);

  // El creador queda apuntado automáticamente.
  if (evento) evento.addGuest(body.email);
  getSheet_(CONFIG.SHEET_ASISTENTES)
    .appendRow([id, body.email, new Date().toISOString()]);

  // 3) Aviso al grupo del equipo organizador.
  MailApp.sendEmail({
    to: team.groupEmail,
    subject: '[KDDPortal] Nueva formación: ' + body.titulo,
    body:
      'Se ha publicado una nueva formación:\n\n' +
      '  📚 ' + body.titulo + '\n' +
      '  🗓️ ' + fechaLargaES_(inicio) + '\n\n' +
      (body.descripcion || '') + '\n\n' +
      'Apúntate desde el panel KDD Portal de VS Code.',
    name: 'KDD Portal'
  });

  return {
    id: id,
    titulo: body.titulo,
    fecha: inicio.toISOString(),
    descripcion: body.descripcion || '',
    creador: body.name,
    teamId: body.team,
    asistentes: 1,
    apuntado: true,
    aviso: evento
      ? ''
      : 'Registrada SIN evento de calendario: ' + motivoSinEvento
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

  var teamId = String(row[7] || '');
  var asistentes = getAsistentesIndex_()[String(body.id)] || [];

  // Evita inscripciones duplicadas.
  if (asistentes.indexOf(body.email) === -1) {
    // Invitado al evento solo si la formación tiene evento y calendario.
    if (row[4]) {
      var calendarId = teamId
        ? getTeamConfig_(teamId).calendarId
        : CONFIG.CALENDAR_ID;
      if (esCalendarValido_(calendarId)) {
        var calendar = CalendarApp.getCalendarById(calendarId);
        var evento = calendar ? calendar.getEventById(row[4]) : null;
        if (evento) evento.addGuest(body.email);
      }
    }

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
    teamId: teamId,
    asistentes: asistentes.length,
    apuntado: true
  };
}

/** true si el id de calendario está configurado de verdad (no placeholder). */
function esCalendarValido_(calendarId) {
  return Boolean(calendarId) && String(calendarId).indexOf('PEGA_') === -1;
}

/**
 * Fecha larga EN ESPAÑOL («martes 26 de agosto, 20:00»).
 * Utilities.formatDate con EEEE/MMMM pinta los nombres en el locale del
 * script (inglés: «Tuesday 25 de August»), así que los nombres se ponen
 * a mano; los números sí salen de formatDate para respetar la zona
 * horaria del proyecto.
 */
function fechaLargaES_(fecha) {
  var tz = Session.getScriptTimeZone();
  var dias = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  var meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var diaSemana = dias[Number(Utilities.formatDate(fecha, tz, 'u')) - 1] || '';
  var dia = Number(Utilities.formatDate(fecha, tz, 'd'));
  var mes = meses[Number(Utilities.formatDate(fecha, tz, 'M')) - 1] || '';
  var hora = Utilities.formatDate(fecha, tz, 'HH:mm');
  return (diaSemana ? diaSemana + ' ' : '') + dia + ' de ' + mes + ', ' + hora;
}

/** Índice { formacionId: [email, …] } a partir de la hoja "Asistentes". */
function getAsistentesIndex_() {
  var rows = getSheet_(CONFIG.SHEET_ASISTENTES).getDataRange().getValues().slice(1);
  var index = {};
  rows.forEach(function (row) {
    if (!row[0]) return;
    var id = String(row[0]);
    (index[id] = index[id] || []).push(String(row[1]));
  });
  return index;
}
