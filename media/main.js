/* ════════════════════════════════════════════════════════════════════════
   Team Hub — lógica del webview (JavaScript vanilla, sin frameworks)

   MODO MOCK: mientras MOCK_MODE sea true, todas las llamadas a la "API"
   se resuelven contra un backend simulado en memoria (MockBackend), con
   latencia artificial, compañeros ficticios que escriben en el chat y
   formaciones de ejemplo. Nada sale de este webview.

   MODO REAL: al poner MOCK_MODE = false, las mismas llamadas api() harán
   fetch a la Web App de Google Apps Script (APPS_SCRIPT_URL), que es la
   que habla con Google Grupos, Calendar y Sheets (ver backend/backend.gs).
   ════════════════════════════════════════════════════════════════════════ */

/* global acquireVsCodeApi */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────── Configuración ──

  const CONFIG = window.__TEAM_HUB_CONFIG__ || {};

  /** true → backend simulado; false → fetch real a Apps Script. */
  const MOCK_MODE = CONFIG.mockMode !== false;

  /**
   * URL del despliegue Web App de Google Apps Script.
   * Se deja como constante configurable para el modo real; en modo mock
   * no se usa.
   */
  const APPS_SCRIPT_URL =
    'https://script.google.com/macros/s/TU_ID_DE_DESPLIEGUE/exec';

  /** Intervalo de polling del chat (ms). */
  const POLL_INTERVAL_MS = 3000;

  const vscode =
    typeof acquireVsCodeApi === 'function'
      ? acquireVsCodeApi()
      : { postMessage: function () {} };

  const USER = CONFIG.user || { name: 'Usuario demo', email: 'demo@equipo.demo' };

  // ──────────────────────────────────────────────────────────── Utilidades ──

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function rand(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  let idCounter = 0;
  function uid() {
    idCounter += 1;
    return 'id-' + Date.now().toString(36) + '-' + idCounter;
  }

  function initials(name) {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (p) {
        return p[0].toUpperCase();
      })
      .join('');
  }

  /** Color de avatar estable por nombre (clases avatar-c0 … avatar-c4). */
  function avatarClass(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) | 0;
    }
    return 'avatar-c' + (Math.abs(hash) % 5);
  }

  function fmtTime(date) {
    return new Date(date).toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function fmtDaySeparator(date) {
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Hoy';
    if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
    return d.toLocaleDateString('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });
  }

  // ═══════════════════════════════════════════════════════ MOCK BACKEND ═══
  //  Simula lo que en producción hará la Web App de Apps Script:
  //   - getChat        → leer hilos del Google Group
  //   - sendMessage    → enviar correo al Google Group
  //   - getFormaciones → leer Sheets + Calendar
  //   - createFormacion→ fila en Sheets + evento en Calendar + aviso al grupo
  //   - rsvp           → invitado en Calendar + fila en Sheets "Asistentes"
  // ═══════════════════════════════════════════════════════════════════════

  const MockBackend = (function () {
    const MIN = 60 * 1000;
    const now = Date.now();

    const TEAM = [
      { name: 'Ana García', email: 'ana.garcia@equipo.demo' },
      { name: 'Luis Martín', email: 'luis.martin@equipo.demo' },
      { name: 'Sara Ortega', email: 'sara.ortega@equipo.demo' }
    ];

    // Historial inicial del "Google Group".
    const messages = [
      {
        id: uid(),
        sender: 'Ana García',
        email: TEAM[0].email,
        text: '¡Buenos días equipo! ☕',
        date: now - 130 * MIN
      },
      {
        id: uid(),
        sender: 'Luis Martín',
        email: TEAM[1].email,
        text:
          'Buenas! Acabo de subir la rama con el fix del login, ' +
          '¿alguien me hace review? 🙏',
        date: now - 118 * MIN
      },
      {
        id: uid(),
        sender: 'Sara Ortega',
        email: TEAM[2].email,
        text: 'Yo le echo un vistazo después de la daily 👍',
        date: now - 115 * MIN
      },
      {
        id: uid(),
        system: true,
        text:
          '📅 Nueva formación publicada: «Introducción a Google Apps Script»',
        date: now - 62 * MIN
      },
      {
        id: uid(),
        sender: 'Ana García',
        email: TEAM[0].email,
        text: 'Recordad rellenar la hoja de horas antes del viernes 🙏',
        date: now - 24 * MIN
      }
    ];

    // Mensajes "entrantes" programados para dar vida a la demo.
    const scheduled = [
      {
        at: now + 9000,
        sender: TEAM[1],
        text: '¿Habéis visto el nuevo panel del Team Hub en VS Code? 👀'
      },
      {
        at: now + 26000,
        sender: TEAM[2],
        text: '¡Sí! Queda genial integrado con el tema del editor 🔥'
      },
      {
        at: now + 75000,
        sender: TEAM[0],
        text: 'Recordad que mañana tenemos demo con cliente a las 12:00.'
      }
    ];

    // Respuestas automáticas cuando el usuario escribe.
    const REPLIES = [
      '¡Buena idea, {name}! 💡',
      'Visto 👍',
      'Genial, lo comentamos en la daily 🙌',
      '+1',
      'Perfecto, gracias por avisar 🙏',
      'Ok! Me lo apunto 📝'
    ];
    let replyIndex = 0;

    function futureDate(daysFromNow, hour, minute) {
      const d = new Date();
      d.setDate(d.getDate() + daysFromNow);
      d.setHours(hour, minute || 0, 0, 0);
      return d.toISOString();
    }

    // "Hoja de cálculo" de formaciones + asistentes.
    const formaciones = [
      {
        id: uid(),
        titulo: 'Introducción a Google Apps Script',
        fecha: futureDate(2, 10, 0),
        descripcion:
          'Primeros pasos con GAS: doGet/doPost, servicios de Workspace ' +
          '(Sheets, Calendar, Gmail) y despliegue de Web Apps.',
        creador: 'Ana García',
        asistentes: 6,
        apuntado: false
      },
      {
        id: uid(),
        titulo: 'Testing en TypeScript con Vitest',
        fecha: futureDate(5, 16, 0),
        descripcion:
          'Escribir tests unitarios rápidos, mocking de módulos y cobertura ' +
          'aplicada a nuestros proyectos.',
        creador: 'Luis Martín',
        asistentes: 3,
        apuntado: false
      },
      {
        id: uid(),
        titulo: 'Accesibilidad web (WCAG 2.2)',
        fecha: futureDate(9, 12, 30),
        descripcion:
          'Repaso práctico de los criterios AA: foco visible, contraste, ' +
          'navegación por teclado y lectores de pantalla.',
        creador: 'Sara Ortega',
        asistentes: 8,
        apuntado: false
      }
    ];

    /** Mueve a `messages` los mensajes programados cuya hora ya pasó. */
    function flushScheduled() {
      const t = Date.now();
      for (let i = scheduled.length - 1; i >= 0; i--) {
        if (scheduled[i].at <= t) {
          const item = scheduled.splice(i, 1)[0];
          messages.push({
            id: uid(),
            sender: item.sender.name,
            email: item.sender.email,
            text: item.text,
            date: item.at
          });
        }
      }
      messages.sort(function (a, b) {
        return a.date - b.date;
      });
    }

    /** Nombre de quien "está escribiendo" ahora mismo, o null. */
    function typingNow() {
      const t = Date.now();
      for (const item of scheduled) {
        if (t >= item.at - 2200 && t < item.at) {
          return item.sender.name;
        }
      }
      return null;
    }

    return {
      getChat: function () {
        flushScheduled();
        return { ok: true, messages: messages.slice(), typing: typingNow() };
      },

      sendMessage: function (payload) {
        messages.push({
          id: uid(),
          sender: USER.name,
          email: USER.email,
          text: payload.text,
          date: Date.now()
        });
        // Programa una respuesta automática de un compañero.
        const teammate = TEAM[rand(0, TEAM.length)];
        const template = REPLIES[replyIndex % REPLIES.length];
        replyIndex += 1;
        scheduled.push({
          at: Date.now() + rand(2800, 5200),
          sender: teammate,
          text: template.replace('{name}', USER.name.split(' ')[0])
        });
        return { ok: true };
      },

      getFormaciones: function () {
        const list = formaciones.slice().sort(function (a, b) {
          return new Date(a.fecha) - new Date(b.fecha);
        });
        return { ok: true, formaciones: list };
      },

      createFormacion: function (payload) {
        const nueva = {
          id: uid(),
          titulo: payload.titulo,
          fecha: payload.fecha,
          descripcion: payload.descripcion || '',
          creador: USER.name,
          asistentes: 1, // el creador queda apuntado
          apuntado: true
        };
        formaciones.push(nueva);
        // Simula el correo de aviso al Google Group.
        messages.push({
          id: uid(),
          system: true,
          text: '📅 Nueva formación publicada: «' + payload.titulo + '»',
          date: Date.now()
        });
        return { ok: true, formacion: nueva };
      },

      rsvp: function (payload) {
        const item = formaciones.find(function (f) {
          return f.id === payload.id;
        });
        if (!item) {
          return { ok: false, error: 'Formación no encontrada' };
        }
        if (!item.apuntado) {
          item.apuntado = true;
          item.asistentes += 1;
          messages.push({
            id: uid(),
            system: true,
            text:
              '✅ ' + USER.name + ' se ha apuntado a «' + item.titulo + '»',
            date: Date.now()
          });
        }
        return { ok: true, formacion: item };
      }
    };
  })();

  // ─────────────────────────────────────────────────────────── Capa de API ──

  /**
   * Punto único de acceso a datos.
   * En mock: latencia artificial + MockBackend.
   * En real: GET/POST a la Web App de Apps Script. El POST se envía como
   * text/plain para evitar el preflight CORS (Apps Script no lo soporta).
   */
  async function api(action, payload) {
    if (MOCK_MODE) {
      await delay(rand(200, 550));
      switch (action) {
        case 'getChat':
          return MockBackend.getChat();
        case 'sendMessage':
          return MockBackend.sendMessage(payload);
        case 'getFormaciones':
          return MockBackend.getFormaciones();
        case 'createFormacion':
          return MockBackend.createFormacion(payload);
        case 'rsvp':
          return MockBackend.rsvp(payload);
        default:
          return { ok: false, error: 'Acción desconocida: ' + action };
      }
    }

    // ── Modo real (Google Apps Script) ──
    if (payload) {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(
          Object.assign({ action: action, email: USER.email, name: USER.name }, payload)
        )
      });
      return res.json();
    }
    const url =
      APPS_SCRIPT_URL +
      '?action=' + encodeURIComponent(action) +
      '&email=' + encodeURIComponent(USER.email);
    const res = await fetch(url);
    return res.json();
  }

  // ─────────────────────────────────────────────────────── Estado de la UI ──

  const state = {
    messages: [],
    formaciones: [],
    sending: false
  };

  // ──────────────────────────────────────────────────────────────── Toast ──

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
    }, 2600);
  }

  // ──────────────────────────────────────────────────────── Render: chat ──

  function renderChat() {
    const list = $('chatList');
    const nearBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight < 60;

    let html = '';
    let lastDay = '';
    let prevSender = null;

    state.messages.forEach(function (msg, index) {
      const day = new Date(msg.date).toDateString();
      if (day !== lastDay) {
        html +=
          '<div class="day-sep">' +
          escapeHtml(fmtDaySeparator(msg.date)) +
          '</div>';
        lastDay = day;
        prevSender = null;
      }

      if (msg.system) {
        html += '<div class="msg-system">' + escapeHtml(msg.text) + '</div>';
        prevSender = null;
        return;
      }

      const own = msg.email === USER.email;
      const firstOfGroup = msg.sender !== prevSender;
      const next = state.messages[index + 1];
      const lastOfGroup =
        !next || next.system || next.sender !== msg.sender ||
        new Date(next.date).toDateString() !== day;

      const rowClasses = [
        'msg-row',
        own ? 'own' : 'other',
        firstOfGroup ? 'first-of-group' : '',
        lastOfGroup ? 'last-of-group' : ''
      ].join(' ');

      html += '<div class="' + rowClasses + '">';
      html +=
        '<span class="avatar ' +
        (own ? 'avatar-own' : avatarClass(msg.sender)) +
        '" title="' + escapeHtml(msg.sender) + '">' +
        escapeHtml(initials(msg.sender)) +
        '</span>';
      html += '<div class="msg-block">';
      if (!own && firstOfGroup) {
        html += '<span class="sender">' + escapeHtml(msg.sender) + '</span>';
      }
      html +=
        '<div class="msg-bubble">' +
        escapeHtml(msg.text) +
        '<span class="time">' + fmtTime(msg.date) + '</span>' +
        '</div>';
      html += '</div></div>';

      prevSender = msg.sender;
    });

    list.innerHTML = html;
    if (nearBottom) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function setTyping(name) {
    const box = $('typing');
    if (name) {
      $('typingName').textContent = name;
      box.hidden = false;
    } else {
      box.hidden = true;
    }
  }

  // ────────────────────────────────────────────────── Render: formaciones ──

  function renderFormaciones() {
    const wrap = $('cardsList');

    if (!state.formaciones.length) {
      wrap.innerHTML =
        '<div class="empty"><span class="empty-icon">🗓️</span>' +
        'No hay formaciones próximas.<br>¡Crea la primera!</div>';
      return;
    }

    let html = '';
    state.formaciones.forEach(function (f) {
      const d = new Date(f.fecha);
      const day = d.getDate();
      const month = d.toLocaleDateString('es-ES', { month: 'short' })
        .replace('.', '');
      const hora = d.toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit'
      });

      html += '<article class="card" data-id="' + f.id + '">';
      html +=
        '<div class="date-block"><span class="day">' + day +
        '</span><span class="month">' + escapeHtml(month) + '</span></div>';
      html += '<div class="card-body">';
      html += '<h3 class="card-title">' + escapeHtml(f.titulo) + '</h3>';
      if (f.descripcion) {
        html +=
          '<p class="card-desc">' + escapeHtml(f.descripcion) + '</p>';
      }
      html += '<div class="card-meta">';
      html += '<span>🕐 ' + hora + '</span>';
      html += '<span>👤 ' + escapeHtml(f.creador) + '</span>';
      html +=
        '<span class="pill">👥 ' + f.asistentes +
        (f.asistentes === 1 ? ' asistente' : ' asistentes') + '</span>';
      html += '</div>';
      html += '<div class="card-actions">';
      if (f.apuntado) {
        html +=
          '<button class="btn joined" type="button" disabled>✓ Apuntado</button>';
      } else {
        html +=
          '<button class="btn primary btn-rsvp" type="button" data-id="' +
          f.id + '">Apuntarse</button>';
      }
      html += '</div></div></article>';
    });

    wrap.innerHTML = html;

    // Listeners de los botones "Apuntarse".
    wrap.querySelectorAll('.btn-rsvp').forEach(function (btn) {
      btn.addEventListener('click', function () {
        onRsvp(btn.getAttribute('data-id'), btn);
      });
    });
  }

  // ──────────────────────────────────────────────────────────── Acciones ──

  async function refreshChat() {
    try {
      const data = await api('getChat');
      if (data && data.ok) {
        state.messages = data.messages;
        renderChat();
        setTyping(data.typing || null);
        $('syncText').textContent =
          'Sincronizado · ' + fmtTime(Date.now());
      }
    } catch (err) {
      $('syncText').textContent = 'Sin conexión';
    }
  }

  async function refreshFormaciones() {
    try {
      const data = await api('getFormaciones');
      if (data && data.ok) {
        state.formaciones = data.formaciones;
        renderFormaciones();
      }
    } catch (err) {
      // Silencioso: se reintenta en la siguiente acción.
    }
  }

  async function onSendMessage(event) {
    event.preventDefault();
    if (state.sending) return;

    const input = $('chatText');
    const text = input.value.trim();
    if (!text) return;

    state.sending = true;
    input.value = '';
    autoGrow(input);

    try {
      await api('sendMessage', { text: text });
      await refreshChat();
      // Polls extra para captar rápido el "escribiendo…" y la respuesta.
      setTimeout(refreshChat, 1500);
      setTimeout(refreshChat, 3500);
      setTimeout(refreshChat, 5600);
    } catch (err) {
      toast('⚠️ No se pudo enviar el mensaje');
    } finally {
      state.sending = false;
      input.focus();
    }
  }

  async function onRsvp(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Apuntando…';
    try {
      const data = await api('rsvp', { id: id });
      if (data && data.ok) {
        const f = state.formaciones.find(function (x) { return x.id === id; });
        if (f) {
          f.apuntado = true;
          f.asistentes = data.formacion.asistentes;
        }
        renderFormaciones();
        refreshChat();
        toast('✅ Te has apuntado. Se añadirá al evento de Calendar (simulado).');
      } else {
        throw new Error((data && data.error) || 'Error');
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Apuntarse';
      toast('⚠️ No se pudo completar la inscripción');
    }
  }

  async function onCreateFormacion(event) {
    event.preventDefault();

    const titulo = $('fTitulo').value.trim();
    const fecha = $('fFecha').value;
    const hora = $('fHora').value || '10:00';
    const descripcion = $('fDesc').value.trim();

    if (!titulo || !fecha) {
      toast('⚠️ El título y la fecha son obligatorios');
      return;
    }

    const fechaCompleta = new Date(fecha + 'T' + hora);
    if (fechaCompleta.getTime() < Date.now() - 60000) {
      toast('⚠️ La fecha debe ser futura');
      return;
    }

    const btn = $('btnCrear');
    btn.disabled = true;
    btn.textContent = 'Creando…';

    try {
      const data = await api('createFormacion', {
        titulo: titulo,
        fecha: fechaCompleta.toISOString(),
        descripcion: descripcion
      });
      if (data && data.ok) {
        $('formNueva').reset();
        toggleFormNueva(false);
        await refreshFormaciones();
        refreshChat();
        toast('🎓 Formación creada y notificada al grupo (simulado).');
        vscode.postMessage({
          type: 'notify',
          level: 'info',
          text: 'Formación «' + titulo + '» creada.'
        });
      } else {
        throw new Error((data && data.error) || 'Error');
      }
    } catch (err) {
      toast('⚠️ No se pudo crear la formación');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Crear y notificar al grupo';
    }
  }

  // ─────────────────────────────────────────────────────── Pequeña UI aux ──

  function toggleFormNueva(show) {
    const form = $('formNueva');
    const willShow = typeof show === 'boolean' ? show : form.hidden;
    form.hidden = !willShow;
    $('btnToggleNueva').textContent = willShow ? '－ Cerrar' : '＋ Nueva';
    if (willShow) {
      // Fecha mínima = hoy, y foco directo al título.
      const today = new Date();
      const iso = today.toISOString().slice(0, 10);
      const fFecha = $('fFecha');
      fFecha.min = iso;
      if (!fFecha.value) {
        fFecha.value = iso;
      }
      $('fTitulo').focus();
    }
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 110) + 'px';
  }

  // ───────────────────────────────────────────────────────── Arranque ──

  function init() {
    // Cabecera con la identidad (mock) del usuario.
    $('userLine').textContent =
      'Conectado como ' + USER.name + ' · ' + USER.email;
    const avatar = $('userAvatar');
    avatar.textContent = initials(USER.name);
    avatar.title = USER.name + ' (' + USER.email + ')';

    if (MOCK_MODE) {
      $('badgeDemo').hidden = false;
      $('demoBanner').hidden = false;
    }

    // Chat.
    $('chatForm').addEventListener('submit', onSendMessage);
    const chatText = $('chatText');
    chatText.addEventListener('input', function () {
      autoGrow(chatText);
    });
    chatText.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('chatForm').requestSubmit();
      }
    });

    // Formaciones.
    $('btnToggleNueva').addEventListener('click', function () {
      toggleFormNueva();
    });
    $('btnCancelarNueva').addEventListener('click', function () {
      toggleFormNueva(false);
    });
    $('formNueva').addEventListener('submit', onCreateFormacion);

    // Carga inicial + polling del chat.
    refreshChat().then(function () {
      const list = $('chatList');
      list.scrollTop = list.scrollHeight;
    });
    refreshFormaciones();
    setInterval(refreshChat, POLL_INTERVAL_MS);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
