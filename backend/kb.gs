/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KDD Portal · KNOWLEDGE BASE — Drive → carpeta local de la extensión
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Cada equipo tiene su carpeta de Drive (columna KbDriveFolderId de la
 *  hoja Config). Este módulo actúa de "proxy" para que la extensión pueda
 *  DESCARGAR la KB a una carpeta local SIN necesitar OAuth de Drive en
 *  VS Code:
 *
 *    1. getKbIndex(team)          → lista de documentos (id, ruta, fecha)
 *    2. getKbFile(team, fileId)   → contenido en texto/markdown
 *
 *  La extensión compara fechas con su copia local (KB_BASE_PATH/<equipo>)
 *  y baja solo lo modificado. Después, el chat de la KB usa GitHub Copilot
 *  (Language Model API de VS Code) con esos archivos locales como contexto
 *  — ver backend/instrucciones-kb-copilot.md para el prompt ad-hoc.
 *
 *  Tipos soportados: Google Docs (export a markdown), .md, .txt. El resto
 *  (PDF, hojas…) se lista con supported=false para que la extensión lo
 *  muestre pero no lo descargue.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Índice recursivo de la carpeta de KB del equipo. */
function getKbIndex_(teamId) {
  var team = getTeamConfig_(teamId);
  if (!team.kbFolderId) {
    throw new Error('El equipo ' + teamId + ' no tiene KbDriveFolderId en Config');
  }
  var root = DriveApp.getFolderById(team.kbFolderId);
  var files = [];
  walkKbFolder_(root, '', files);
  files.sort(function (a, b) { return a.path < b.path ? -1 : 1; });
  return files;
}

function walkKbFolder_(folder, prefix, out) {
  var it = folder.getFiles();
  while (it.hasNext()) {
    var file = it.next();
    out.push({
      id: file.getId(),
      name: file.getName(),
      path: prefix + file.getName(),
      mimeType: file.getMimeType(),
      updated: file.getLastUpdated().getTime(),
      size: file.getSize(),
      supported: isKbSupported_(file)
    });
  }
  var folders = folder.getFolders();
  while (folders.hasNext()) {
    var sub = folders.next();
    walkKbFolder_(sub, prefix + sub.getName() + '/', out);
  }
}

function isKbSupported_(file) {
  var mime = file.getMimeType();
  if (mime === MimeType.GOOGLE_DOCS) return true;
  if (mime === 'text/markdown' || mime === 'text/plain') return true;
  // Los .md a veces se suben como binario genérico: se acepta por extensión.
  return /\.(md|txt)$/i.test(file.getName());
}

/**
 * Contenido de un documento de la KB en texto plano/markdown.
 * Por seguridad solo sirve archivos que estén DENTRO de la carpeta del
 * equipo (se valida contra el índice, no contra el id a ciegas).
 */
function getKbFile_(teamId, fileId) {
  if (!fileId) throw new Error('Falta fileId');
  var index = getKbIndex_(teamId);
  var entry = null;
  for (var i = 0; i < index.length; i++) {
    if (index[i].id === fileId) {
      entry = index[i];
      break;
    }
  }
  if (!entry) {
    throw new Error('El archivo no pertenece a la KB del equipo ' + teamId);
  }
  if (!entry.supported) {
    return { id: entry.id, path: entry.path, supported: false, content: '' };
  }

  var content;
  if (entry.mimeType === MimeType.GOOGLE_DOCS) {
    content = exportDocAsMarkdown_(fileId);
  } else {
    content = DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8');
  }

  return {
    id: entry.id,
    path: entry.path,
    updated: entry.updated,
    supported: true,
    content: String(content).slice(0, CONFIG.KB_MAX_CHARS)
  };
}

/**
 * Exporta un Google Doc como markdown vía la API de Drive (v3 soporta
 * text/markdown). Si el export falla, cae a texto plano con DocumentApp.
 * Requiere scope drive.readonly (UrlFetchApp + token del script).
 */
function exportDocAsMarkdown_(fileId) {
  try {
    var url =
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
      '/export?mimeType=' + encodeURIComponent('text/markdown');
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) {
      return res.getContentText();
    }
  } catch (err) {
    // Silencioso: probamos el fallback.
  }
  // Fallback: texto plano (pierde formato, pero sirve como contexto).
  return DocumentApp.openById(fileId).getBody().getText();
}
