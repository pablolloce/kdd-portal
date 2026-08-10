/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KDD Portal · CHAT ↔ Google Groups (por equipo)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Flujo:
 *   - Escribir (chat → mail): el POST sendMessage envía un correo al buzón
 *     del Google Group del equipo (hoja Config), con el asunto
 *     CONFIG.CHAT_SUBJECT para poder distinguirlo después.
 *   - Leer (respuesta → chat): getChat busca en Gmail los hilos dirigidos
 *     al grupo con ese asunto y los convierte en mensajes {sender, email,
 *     text, date}. Cualquier respuesta al hilo (desde el chat o desde el
 *     propio correo) aparece en el chat en el siguiente polling.
 *
 *  CUOTAS: GmailApp.search tiene cuota diaria. Con polling agresivo desde
 *  varios clientes se agota, así que:
 *   - getChat cachea el resultado CHAT_CACHE_SECONDS (CacheService).
 *   - En la extensión, sube POLL_INTERVAL_MS a 15–30 s en modo real.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Últimos mensajes del "chat" (correos del grupo del equipo). */
function getChat_(teamId) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'chat_' + teamId;
  var cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  var team = getTeamConfig_(teamId);
  var query =
    'to:"' + team.groupEmail + '" subject:"' + CONFIG.CHAT_SUBJECT + '"';
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
  out = out.slice(-CONFIG.MAX_CHAT_MESSAGES);

  cache.put(cacheKey, JSON.stringify(out), CONFIG.CHAT_CACHE_SECONDS);
  return out;
}

/** Envía un mensaje del usuario al buzón del Google Group del equipo. */
function sendChatMessage_(teamId, name, email, text) {
  if (!text) throw new Error('Mensaje vacío');
  var team = getTeamConfig_(teamId);

  MailApp.sendEmail({
    to: team.groupEmail,
    subject: CONFIG.CHAT_SUBJECT + ' ' + name,
    body: text + '\n\n— ' + name + ' <' + email + '> vía KDD Portal',
    name: 'KDD Portal · ' + name
  });

  // Invalida la caché para que el propio autor vea su mensaje pronto.
  CacheService.getScriptCache().remove('chat_' + teamId);
}

/** Limpia firmas/citas típicas del cuerpo de un correo. */
function cleanBody_(body) {
  var text = (body || '').split(/\n--\s*\n/)[0]; // corta la firma "-- "
  text = text.split(/\nEl .+ escribió:\n/)[0];    // corta la cita en respuestas
  text = text.replace(/\n>+.*$/gm, '');           // quita líneas citadas "> "
  text = text.replace(/— .+ vía KDD Portal\s*$/, '');
  return text.trim().slice(0, 2000);
}
