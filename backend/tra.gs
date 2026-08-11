/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KDD Portal · TRA — informe de imputaciones (proyectos y personas)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Lee el Google Sheets que alimenta el Looker Studio del área (se
 *  actualiza a diario) y lo sirve a la pestaña «Proyectos y personas».
 *  El spreadsheet es OTRO distinto al de KDD Portal: basta con que la
 *  cuenta que despliega la Web App tenga acceso de lectura.
 *
 *  Hoja PORTAL (columnas por cabecera, el orden da igual):
 *    id | name | team | sda_project_id | jira_issue_id | non_sda_project
 *    | time (MINUTOS) | description | geography
 *
 *  Respuesta: filas compactas [nombre, equipo, sdatool, featureJira,
 *  descripcion, minutos], agregadas por esa clave para reducir tamaño
 *  (la hoja real ronda 3.700 filas → ~2.000 agregadas). La extensión
 *  convierte minutos → horas y calcula totales, donut y tablas.
 *
 *  NOTA: es información COMPLEMENTARIA — no todos los equipos ni todas
 *  las personas del área imputan en este informe.
 * ═══════════════════════════════════════════════════════════════════════════
 */

var TRA_CONFIG = {
  /** Spreadsheet del informe TRA (el del Looker). */
  SPREADSHEET_ID: '1gFNF-N5IXBwjTaUpH27BzhZ0fj-b1plkzkps1e68Vb0',
  /** gid de la hoja (pestaña) con los datos; fallback por nombre. */
  SHEET_GID: 1774358263,
  SHEET_NAME: 'PORTAL',
  /** Caché (solo si el JSON cabe en CacheService: límite 100 KB/clave). */
  CACHE_SECONDS: 600
};

/** Filas agregadas del informe TRA: { rows: [...], updatedAt: iso }. */
function getTra_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('tra');
  if (cached) {
    return JSON.parse(cached);
  }

  var sheet = getTraSheet_();
  var values = sheet.getDataRange().getValues();
  var header = values[0].map(function (h) {
    return String(h).trim().toLowerCase();
  });
  var col = {
    name: header.indexOf('name'),
    team: header.indexOf('team'),
    sda: header.indexOf('sda_project_id'),
    jira: header.indexOf('jira_issue_id'),
    nonSda: header.indexOf('non_sda_project'),
    time: header.indexOf('time'),
    desc: header.indexOf('description')
  };
  if (col.name === -1 || col.time === -1) {
    throw new Error('La hoja TRA no tiene las cabeceras esperadas (name/time).');
  }

  // Agrega por (nombre, equipo, sda, jira, descripción) sumando minutos.
  var agregado = {};
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col.name]) continue;

    var sda = String(row[col.sda] || '').trim();
    var desc = String(row[col.desc] || '').trim();
    // Sin proyecto SDA: se usa el proyecto no-SDA como descripción
    // (ej. "Soporte usuarios"), igual que hace el informe.
    if (!sda && col.nonSda !== -1 && row[col.nonSda]) {
      desc = String(row[col.nonSda]).trim();
    }

    var entry = [
      String(row[col.name]).trim(),
      String(row[col.team] || '').trim(),
      sda,
      String(row[col.jira] || '').trim(),
      desc
    ];
    var key = entry.join('|');
    if (!agregado[key]) {
      agregado[key] = entry.concat([0]);
    }
    agregado[key][5] += Number(row[col.time]) || 0;
  }

  var rows = Object.keys(agregado).map(function (key) {
    return agregado[key];
  });

  var result = { rows: rows, updatedAt: new Date().toISOString() };
  var json = JSON.stringify(result);
  if (json.length < 95000) {
    cache.put('tra', json, TRA_CONFIG.CACHE_SECONDS);
  }
  return result;
}

/** Localiza la pestaña del informe por gid, con fallback por nombre. */
function getTraSheet_() {
  var ss = SpreadsheetApp.openById(TRA_CONFIG.SPREADSHEET_ID);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === TRA_CONFIG.SHEET_GID) {
      return sheets[i];
    }
  }
  var byName = ss.getSheetByName(TRA_CONFIG.SHEET_NAME);
  if (byName) return byName;
  return sheets[0];
}
