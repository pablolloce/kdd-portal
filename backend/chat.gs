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
      var raw = msg.getPlainBody();

      // Autor real de los mensajes del portal: su firma «— Nombre <email>
      // vía KDD Portal» sobrevive a la redistribución del grupo aunque
      // Groups reescriba el From al buzón del grupo (política DMARC del
      // dominio). OJO: se busca en el contenido PROPIO (tras recortar
      // citas) — una respuesta manual CITA la firma del mensaje anterior
      // y no debe pasar por mensaje del portal. Sin firma con el From
      // reescrito, el Reply-To suele conservar a la persona.
      var propio = recortarCitas_(raw);
      var firma = propio.match(/—\s*([^<\n]+?)\s*<([^>\s]+)>\s*vía KDD Portal/);
      if (firma) {
        name = firma[1].trim();
        email = firma[2].trim();
      } else if (email.toLowerCase() === team.groupEmail.toLowerCase()) {
        var replyTo = String(msg.getReplyTo() || '');
        var rt = replyTo.match(/^\s*"?([^"<]*)"?\s*<(.+)>\s*$/);
        var rtEmail = (rt ? rt[2] : replyTo).trim();
        if (rtEmail && rtEmail.indexOf('@') !== -1 &&
            rtEmail.toLowerCase() !== team.groupEmail.toLowerCase()) {
          name = (rt ? rt[1].trim() : '') || rtEmail;
          email = rtEmail;
        }
      }

      var text = cleanBody_(raw);
      if (!text) return; // p. ej. una respuesta que era solo cita

      out.push({
        id: msg.getId(),
        sender: name || email,
        email: email,
        text: text,
        date: msg.getDate().getTime(),
        viaPortal: Boolean(firma)
      });
    });
  });

  out.sort(function (a, b) { return a.date - b.date; });

  // El grupo redistribuye cada correo también a su autor: de un mensaje
  // enviado desde el portal acaban en el buzón la copia enviada Y el eco
  // del grupo, con el mismo contenido a minutos de diferencia. Se queda la
  // primera copia. SOLO se filtran mensajes con firma del portal: una
  // respuesta manual idéntica y seguida (un «+1» dos veces) no es un eco.
  var ultimaVez = {};
  out = out.filter(function (m) {
    if (!m.viaPortal) return true;
    var clave = (m.email + '|' + m.text).toLowerCase();
    if (ultimaVez[clave] !== undefined && m.date - ultimaVez[clave] < 10 * 60 * 1000) {
      return false;
    }
    ultimaVez[clave] = m.date;
    return true;
  });
  out.forEach(function (m) { delete m.viaPortal; });

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

/**
 * Recorta del cuerpo todo lo que es historia citada, dejando solo el
 * contenido PROPIO del mensaje (la firma del portal, si la hay, se queda:
 * getChat_ la necesita para atribuir el autor real antes de quitarla).
 */
function recortarCitas_(body) {
  var text = String(body || '').replace(/\r\n/g, '\n');
  text = text.split(/\n--\s*\n/)[0]; // corta la firma "-- "

  // Cabecera de cita de Gmail («El <fecha>, <nombre> escribió:» / «On …
  // wrote:»). En texto plano Gmail la PARTE en varias líneas cuando es
  // larga, así que no puede exigirse que quepa en una sola (con fechas
  // largas la cabecera sobrevivía y el chat mostraba el mensaje anterior
  // citado). Todo lo que sigue a la cabecera es historia citada: fuera.
  var cita = /(^|\n)\s*(El|On) [\s\S]{0,300}?(escribi[oó]|wrote)\s*:\s*\n/.exec(text);
  if (cita) {
    text = text.slice(0, cita.index);
  }

  return text.replace(/^\s*>.*$/gm, ''); // quita líneas citadas "> "
}

/** Cuerpo limpio para el chat: sin citas y sin la firma del portal. */
function cleanBody_(body) {
  return recortarCitas_(body)
    .replace(/— .+ vía KDD Portal\s*$/, '')
    .trim()
    .slice(0, 2000);
}
