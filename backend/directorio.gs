/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KDD Portal · DIRECTORIO — proyectos y personas del área
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Alimenta la pestaña «Proyectos y personas» del menú. Es el MISMO origen
 *  de datos que el informe de Looker Studio del área: si el informe parte
 *  de un Google Sheets, basta con apuntar aquí a ese spreadsheet (o copiar
 *  sus pestañas al de KDD Portal) y ambos quedan sincronizados.
 *
 *  Hojas:
 *   Proyectos: ID | Nombre | Equipo | Estado | ResponsableEmail | Avance
 *              | Descripcion | PersonasEmails (separados por comas)
 *   Personas:  Email | Nombre | Equipo | Rol
 *
 *  Estados esperados: "En curso" | "En pausa" | "Cerrado".
 *
 *  NOTA sobre incrustar Looker Studio: dentro de un webview de VS Code el
 *  login de Google no funciona, así que el iframe solo se vería si el
 *  informe permitiera acceso público con embed activado. Por eso el portal
 *  pinta los datos en nativo y ofrece el botón «Abrir en Looker Studio»
 *  para el informe original.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Directorio completo: { personas: [...], proyectos: [...] }. */
function getDirectorio_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('directorio');
  if (cached) {
    return JSON.parse(cached);
  }

  var personas = getSheet_(CONFIG.SHEET_PERSONAS)
    .getDataRange().getValues().slice(1)
    .filter(function (row) { return row[0]; })
    .map(function (row) {
      return {
        email: String(row[0]).trim(),
        nombre: String(row[1] || ''),
        teamId: String(row[2] || '').trim(),
        rol: String(row[3] || '')
      };
    });

  var proyectos = getSheet_(CONFIG.SHEET_PROYECTOS)
    .getDataRange().getValues().slice(1)
    .filter(function (row) { return row[0]; })
    .map(function (row) {
      return {
        id: String(row[0]).trim(),
        nombre: String(row[1] || ''),
        teamId: String(row[2] || '').trim(),
        estado: String(row[3] || 'En curso'),
        responsable: String(row[4] || '').trim(),
        avance: Math.max(0, Math.min(100, Number(row[5]) || 0)),
        descripcion: String(row[6] || ''),
        personas: String(row[7] || '')
          .split(',')
          .map(function (email) { return email.trim(); })
          .filter(Boolean)
      };
    });

  var result = { personas: personas, proyectos: proyectos };
  cache.put('directorio', JSON.stringify(result), 120);
  return result;
}
