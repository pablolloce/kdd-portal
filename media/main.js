/* ════════════════════════════════════════════════════════════════════════
   Team Hub — lógica del webview (JavaScript vanilla, sin frameworks)

   MODO MOCK: mientras MOCK_MODE sea true, todas las llamadas a la "API"
   se resuelven contra un backend simulado en memoria (MockBackend), con
   latencia artificial, varios EQUIPOS con compañeros ficticios que
   escriben en el chat, formaciones de ejemplo y una Knowledge Base que
   imita a Copilot citando documentos de una ruta local. Nada sale de
   este webview.

   MODO REAL: al poner MOCK_MODE = false…
    - chat/formaciones → fetch a la Web App de Google Apps Script
      (APPS_SCRIPT_URL, ver backend/backend.gs), pasando el equipo activo.
    - Knowledge Base → Language Model API de VS Code (Copilot) con los
      documentos de KB_BASE_PATH/<equipo> como contexto.
   ════════════════════════════════════════════════════════════════════════ */

/* global acquireVsCodeApi */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────── Configuración ──

  const CONFIG = window.__TEAM_HUB_CONFIG__ || {};

  /** true → backend simulado; false → fetch real a Apps Script. */
  const MOCK_MODE = CONFIG.mockMode !== false;

  /** URL del despliegue Web App de Google Apps Script (modo real). */
  const APPS_SCRIPT_URL =
    'https://script.google.com/macros/s/TU_ID_DE_DESPLIEGUE/exec';

  /**
   * Ruta local base del repositorio de conocimiento (modo real).
   * Cada equipo tiene su carpeta: KB_BASE_PATH/<carpeta-del-equipo>.
   */
  const KB_BASE_PATH = './kb';

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

  /** Mini-markdown seguro: **negrita**, `código`, listas "- " y saltos. */
  function mdLite(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^- (.+)$/gm, '<span class="li">•&nbsp;$1</span>');
    html = html.replace(/\n/g, '<br>');
    return html;
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

  /** Quita acentos y pasa a minúsculas (para buscar en la KB). */
  function normalize(text) {
    return String(text)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function futureDate(daysFromNow, hour, minute) {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    d.setHours(hour, minute || 0, 0, 0);
    return d.toISOString();
  }

  // ═══════════════════════════════════════════════════════════ EQUIPOS ═══
  //  Cada equipo simula: su Google Group (chat), su calendario de
  //  formaciones y su carpeta de Knowledge Base en la ruta local.
  // ═══════════════════════════════════════════════════════════════════════

  const TEAMS = [
    {
      id: 'frontend',
      nombre: 'Equipo Frontend',
      icon: '🎨',
      grupo: 'frontend@equipo.demo',
      kbFolder: 'equipo-frontend',
      kbDocs: 12,
      members: [
        { name: 'Ana García', email: 'ana.garcia@equipo.demo' },
        { name: 'Luis Martín', email: 'luis.martin@equipo.demo' },
        { name: 'Sara Ortega', email: 'sara.ortega@equipo.demo' }
      ],
      kbSuggestions: [
        '¿Dónde está la guía de estilos?',
        '¿Cómo se despliega a producción?',
        '¿Qué framework de testing usamos?'
      ],
      kb: [
        {
          keywords: ['estilo', 'guia', 'css', 'componente', 'diseno', 'tokens'],
          answer:
            'La guía de estilos está en `kb/equipo-frontend/guia-estilos.md`.\n\n' +
            '- Usamos **tokens de diseño** en `tokens.css` (colores, espaciado, tipografía).\n' +
            '- Los componentes compartidos viven en `src/ui/` y se documentan en Storybook.\n' +
            '- Antes de crear un componente nuevo, revisa el **inventario** para no duplicar.',
          sources: [
            'kb/equipo-frontend/guia-estilos.md',
            'kb/equipo-frontend/componentes/inventario.md'
          ]
        },
        {
          keywords: ['deploy', 'desplegar', 'produccion', 'publicar', 'release', 'hotfix'],
          answer:
            'El despliegue a producción es automático al hacer **merge a `main`**:\n\n' +
            '- La CI ejecuta lint + tests + build (GitHub Actions).\n' +
            '- Si todo pasa, se publica y se etiqueta la release.\n' +
            '- Para un **hotfix**, usa una rama `hotfix/*` y avisa en el chat del equipo.',
          sources: [
            'kb/equipo-frontend/ci-cd.md',
            'kb/equipo-frontend/runbooks/deploy.md'
          ]
        },
        {
          keywords: ['test', 'testing', 'prueba', 'vitest', 'playwright', 'cobertura'],
          answer:
            'Estrategia de testing del equipo:\n\n' +
            '- **Unitarios**: Vitest (`npm test`), cobertura mínima del 80%.\n' +
            '- **E2E**: Playwright, en la pipeline nocturna.\n' +
            '- Los mocks compartidos están en `test/fixtures/`.',
          sources: [
            'kb/equipo-frontend/testing.md',
            'kb/equipo-frontend/runbooks/e2e.md'
          ]
        }
      ],
      kbFallbackSources: [
        'kb/equipo-frontend/indice.md',
        'kb/equipo-frontend/faq.md'
      ]
    },
    {
      id: 'backend',
      nombre: 'Equipo Backend',
      icon: '⚙️',
      grupo: 'backend@equipo.demo',
      kbFolder: 'equipo-backend',
      kbDocs: 18,
      members: [
        { name: 'Carlos Ruiz', email: 'carlos.ruiz@equipo.demo' },
        { name: 'Elena Vidal', email: 'elena.vidal@equipo.demo' },
        { name: 'Jorge Peña', email: 'jorge.pena@equipo.demo' }
      ],
      kbSuggestions: [
        '¿Cómo se hace una migración de base de datos?',
        '¿Cuál es la convención para los errores de la API?',
        '¿Cómo se despliega un servicio?'
      ],
      kb: [
        {
          keywords: ['migracion', 'base de datos', 'bd', 'sql', 'postgres', 'flyway', 'esquema'],
          answer:
            'Las migraciones se gestionan con **Flyway** sobre PostgreSQL:\n\n' +
            '- Crea el fichero en `db/migrations/` con el patrón `V<n>__descripcion.sql`.\n' +
            '- Se aplican automáticamente al desplegar; **nunca** edites una migración ya aplicada.\n' +
            '- Para datos sensibles, coordina la ventana con el equipo en el chat.',
          sources: [
            'kb/equipo-backend/migraciones.md',
            'kb/equipo-backend/runbooks/flyway.md'
          ]
        },
        {
          keywords: ['api', 'error', 'errores', 'rest', 'endpoint', 'convencion', 'http'],
          answer:
            'Convenciones de la API REST:\n\n' +
            '- Versionado por ruta: `/v1/...`.\n' +
            '- Errores en formato **RFC 7807** (`application/problem+json`).\n' +
            '- Los códigos y mensajes estándar están tabulados en la guía de la API.',
          sources: ['kb/equipo-backend/guia-api.md']
        },
        {
          keywords: ['deploy', 'desplegar', 'servicio', 'produccion', 'cloud run', 'publicar'],
          answer:
            'Cada servicio se despliega a **Cloud Run** desde su pipeline:\n\n' +
            '- Merge a `main` → build de imagen → despliegue *canary* al 10%.\n' +
            '- Si las métricas aguantan 15 min, se promociona al 100%.\n' +
            '- El rollback es un clic en la revisión anterior (ver runbook).',
          sources: [
            'kb/equipo-backend/ci-cd.md',
            'kb/equipo-backend/runbooks/rollback.md'
          ]
        }
      ],
      kbFallbackSources: [
        'kb/equipo-backend/indice.md',
        'kb/equipo-backend/arquitectura.md'
      ]
    },
    {
      id: 'qa-datos',
      nombre: 'Equipo QA & Datos',
      icon: '🧪',
      grupo: 'qa-datos@equipo.demo',
      kbFolder: 'equipo-qa-datos',
      kbDocs: 9,
      members: [
        { name: 'Marta Sanz', email: 'marta.sanz@equipo.demo' },
        { name: 'David Gil', email: 'david.gil@equipo.demo' }
      ],
      kbSuggestions: [
        '¿Cómo lanzo la suite E2E?',
        '¿Dónde están los dashboards de métricas?',
        '¿Cómo reporto un bug?'
      ],
      kb: [
        {
          keywords: ['e2e', 'suite', 'playwright', 'automatiza', 'lanzar', 'ejecutar'],
          answer:
            'La suite E2E se lanza con `npm run e2e` (Playwright):\n\n' +
            '- En local usa `--ui` para el modo interactivo.\n' +
            '- En CI corre cada noche contra *staging*; el informe queda en el job.\n' +
            '- Marca tests inestables con `@flaky` y abre incidencia.',
          sources: [
            'kb/equipo-qa-datos/e2e.md',
            'kb/equipo-qa-datos/runbooks/playwright.md'
          ]
        },
        {
          keywords: ['dashboard', 'looker', 'metrica', 'kpi', 'informe', 'datos'],
          answer:
            'Los dashboards viven en **Looker Studio**:\n\n' +
            '- «Calidad releases» → métricas de bugs por versión.\n' +
            '- «Salud E2E» → estabilidad de la suite por día.\n' +
            '- Los orígenes de datos se documentan en la carpeta `datos/`.',
          sources: ['kb/equipo-qa-datos/dashboards.md']
        },
        {
          keywords: ['bug', 'incidencia', 'reporte', 'reportar', 'defecto', 'plantilla'],
          answer:
            'Para reportar un bug usa la **plantilla oficial**:\n\n' +
            '- Título con el patrón `[área] resumen`.\n' +
            '- Pasos de reproducción + resultado esperado vs. real.\n' +
            '- Adjunta evidencia (captura o traza) y etiqueta la severidad.',
          sources: [
            'kb/equipo-qa-datos/plantilla-bugs.md',
            'kb/equipo-qa-datos/severidades.md'
          ]
        }
      ],
      kbFallbackSources: [
        'kb/equipo-qa-datos/indice.md',
        'kb/equipo-qa-datos/faq.md'
      ]
    }
  ];

  function teamById(id) {
    return TEAMS.find(function (t) { return t.id === id; }) || TEAMS[0];
  }

  // ═══════════════════════════════════════════════════════ MOCK BACKEND ═══
  //  Un "almacén" por equipo: chat (Google Group), formaciones (Calendar +
  //  Sheets) y respuestas de la Knowledge Base (Copilot + ruta local).
  // ═══════════════════════════════════════════════════════════════════════

  const MockBackend = (function () {
    const MIN = 60 * 1000;
    const now = Date.now();

    const REPLIES = [
      '¡Buena idea, {name}! 💡',
      'Visto 👍',
      'Genial, lo comentamos en la daily 🙌',
      '+1',
      'Perfecto, gracias por avisar 🙏',
      'Ok! Me lo apunto 📝'
    ];

    /** Semillas de chat, mensajes programados y formaciones por equipo. */
    function createStore(team) {
      const m = team.members;
      let messages = [];
      let scheduled = [];
      let formaciones = [];

      if (team.id === 'frontend') {
        messages = [
          { sender: m[0], text: '¡Buenos días equipo! ☕', date: now - 130 * MIN },
          { sender: m[1], text: 'Buenas! Acabo de subir la rama con el fix del login, ¿alguien me hace review? 🙏', date: now - 118 * MIN },
          { sender: m[2], text: 'Yo le echo un vistazo después de la daily 👍', date: now - 115 * MIN },
          { system: true, text: '📅 Nueva formación publicada: «Introducción a Google Apps Script»', date: now - 62 * MIN },
          { sender: m[0], text: 'Recordad rellenar la hoja de horas antes del viernes 🙏', date: now - 24 * MIN }
        ];
        scheduled = [
          { at: now + 9000, sender: m[1], text: '¿Habéis visto el nuevo panel del Team Hub en VS Code? 👀' },
          { at: now + 26000, sender: m[2], text: '¡Sí! Queda genial integrado con el tema del editor 🔥' },
          { at: now + 75000, sender: m[0], text: 'Recordad que mañana tenemos demo con cliente a las 12:00.' }
        ];
        formaciones = [
          { titulo: 'Introducción a Google Apps Script', fecha: futureDate(2, 10, 0), descripcion: 'Primeros pasos con GAS: doGet/doPost, servicios de Workspace (Sheets, Calendar, Gmail) y despliegue de Web Apps.', creador: m[0].name, asistentes: 6 },
          { titulo: 'Testing en TypeScript con Vitest', fecha: futureDate(5, 16, 0), descripcion: 'Escribir tests unitarios rápidos, mocking de módulos y cobertura aplicada a nuestros proyectos.', creador: m[1].name, asistentes: 3 },
          { titulo: 'Accesibilidad web (WCAG 2.2)', fecha: futureDate(9, 12, 30), descripcion: 'Repaso práctico de los criterios AA: foco visible, contraste, navegación por teclado y lectores de pantalla.', creador: m[2].name, asistentes: 8 }
        ];
      } else if (team.id === 'backend') {
        messages = [
          { sender: m[1], text: 'He dejado la migración 042 lista en la rama, revisadla antes del deploy de esta tarde 🚀', date: now - 95 * MIN },
          { sender: m[0], text: 'Le echo un ojo ahora. ¿Toca también al índice de pedidos?', date: now - 88 * MIN },
          { sender: m[1], text: 'Sí, añade uno parcial para las consultas del listado.', date: now - 86 * MIN },
          { system: true, text: '📅 Nueva formación publicada: «Optimización de consultas en PostgreSQL»', date: now - 50 * MIN },
          { sender: m[2], text: 'El canary del servicio de pagos lleva 20 min estable, promociono al 100% ✅', date: now - 12 * MIN }
        ];
        scheduled = [
          { at: now + 15000, sender: m[0], text: 'Migración revisada, aprobada ✔️' },
          { at: now + 48000, sender: m[2], text: 'Ojo: mañana rotamos las credenciales de la BD de staging.' }
        ];
        formaciones = [
          { titulo: 'Optimización de consultas en PostgreSQL', fecha: futureDate(3, 11, 0), descripcion: 'EXPLAIN ANALYZE, índices parciales, particionado y trampas habituales en consultas N+1.', creador: m[0].name, asistentes: 4 },
          { titulo: 'Mensajería con Pub/Sub', fecha: futureDate(7, 15, 30), descripcion: 'Patrones de publicación/suscripción, reintentos, dead-letter queues e idempotencia.', creador: m[1].name, asistentes: 5 }
        ];
      } else {
        messages = [
          { sender: m[0], text: 'La suite E2E ha pasado en verde esta noche ✅ 214/214', date: now - 110 * MIN },
          { sender: m[1], text: '¡Bien! ¿Cerramos entonces la incidencia del checkout?', date: now - 104 * MIN },
          { sender: m[0], text: 'Sí, la cierro y actualizo el dashboard de calidad.', date: now - 102 * MIN },
          { system: true, text: '📅 Nueva formación publicada: «Automatización E2E con Playwright»', date: now - 70 * MIN },
          { sender: m[1], text: 'He subido el informe semanal de métricas al Drive del equipo 📊', date: now - 18 * MIN }
        ];
        scheduled = [
          { at: now + 20000, sender: m[0], text: 'Recordatorio: el corte de datos del informe mensual es el jueves.' },
          { at: now + 60000, sender: m[1], text: '¿Alguien más ve lento el entorno de staging? 🐢' }
        ];
        formaciones = [
          { titulo: 'Automatización E2E con Playwright', fecha: futureDate(2, 12, 0), descripcion: 'Selectores robustos, fixtures, paralelización y cómo mantener la suite estable en CI.', creador: m[0].name, asistentes: 7 },
          { titulo: 'Dashboards con Looker Studio', fecha: futureDate(6, 10, 30), descripcion: 'Conectar orígenes, métricas calculadas y buenas prácticas de visualización para el equipo.', creador: m[1].name, asistentes: 2 },
          { titulo: 'Calidad de datos con Great Expectations', fecha: futureDate(11, 16, 0), descripcion: 'Validaciones automáticas de esquemas y datos en los pipelines de ingesta.', creador: m[0].name, asistentes: 3 }
        ];
      }

      return {
        messages: messages.map(function (msg) {
          return msg.system
            ? { id: uid(), system: true, text: msg.text, date: msg.date }
            : { id: uid(), sender: msg.sender.name, email: msg.sender.email, text: msg.text, date: msg.date };
        }),
        scheduled: scheduled,
        replyIndex: 0,
        formaciones: formaciones.map(function (f) {
          return Object.assign({ id: uid(), apuntado: false }, f);
        })
      };
    }

    const stores = {};
    TEAMS.forEach(function (team) {
      stores[team.id] = createStore(team);
    });

    function flushScheduled(store) {
      const t = Date.now();
      for (let i = store.scheduled.length - 1; i >= 0; i--) {
        if (store.scheduled[i].at <= t) {
          const item = store.scheduled.splice(i, 1)[0];
          store.messages.push({
            id: uid(),
            sender: item.sender.name,
            email: item.sender.email,
            text: item.text,
            date: item.at
          });
        }
      }
      store.messages.sort(function (a, b) { return a.date - b.date; });
    }

    function typingNow(store) {
      const t = Date.now();
      for (const item of store.scheduled) {
        if (t >= item.at - 2200 && t < item.at) {
          return item.sender.name;
        }
      }
      return null;
    }

    /** Busca la mejor entrada de la KB del equipo para una pregunta. */
    function findKbAnswer(team, question) {
      const q = normalize(question);
      let best = null;
      let bestScore = 0;
      team.kb.forEach(function (entry) {
        let score = 0;
        entry.keywords.forEach(function (kw) {
          if (q.indexOf(normalize(kw)) !== -1) score += 1;
        });
        if (score > bestScore) {
          bestScore = score;
          best = entry;
        }
      });
      if (best) {
        return { answer: best.answer, sources: best.sources.slice() };
      }
      return {
        answer:
          'No he encontrado una respuesta exacta en la Knowledge Base del ' +
          '**' + team.nombre + '**, pero estos documentos pueden ayudarte:\n\n' +
          '- `' + team.kbFallbackSources[0] + '` — mapa de toda la documentación\n' +
          '- `' + team.kbFallbackSources[1] + '` — preguntas frecuentes\n\n' +
          'Prueba a reformular la pregunta con otras palabras clave.',
        sources: team.kbFallbackSources.slice()
      };
    }

    return {
      getChat: function (teamId) {
        const store = stores[teamId];
        flushScheduled(store);
        return { ok: true, messages: store.messages.slice(), typing: typingNow(store) };
      },

      sendMessage: function (teamId, payload) {
        const store = stores[teamId];
        const team = teamById(teamId);
        store.messages.push({
          id: uid(),
          sender: USER.name,
          email: USER.email,
          text: payload.text,
          date: Date.now()
        });
        const teammate = team.members[rand(0, team.members.length)];
        const template = REPLIES[store.replyIndex % REPLIES.length];
        store.replyIndex += 1;
        store.scheduled.push({
          at: Date.now() + rand(2800, 5200),
          sender: teammate,
          text: template.replace('{name}', USER.name.split(' ')[0])
        });
        return { ok: true };
      },

      getFormaciones: function (teamId) {
        const list = stores[teamId].formaciones.slice().sort(function (a, b) {
          return new Date(a.fecha) - new Date(b.fecha);
        });
        return { ok: true, formaciones: list };
      },

      createFormacion: function (teamId, payload) {
        const store = stores[teamId];
        const nueva = {
          id: uid(),
          titulo: payload.titulo,
          fecha: payload.fecha,
          descripcion: payload.descripcion || '',
          creador: USER.name,
          asistentes: 1,
          apuntado: true
        };
        store.formaciones.push(nueva);
        store.messages.push({
          id: uid(),
          system: true,
          text: '📅 Nueva formación publicada: «' + payload.titulo + '»',
          date: Date.now()
        });
        return { ok: true, formacion: nueva };
      },

      rsvp: function (teamId, payload) {
        const store = stores[teamId];
        const item = store.formaciones.find(function (f) { return f.id === payload.id; });
        if (!item) {
          return { ok: false, error: 'Formación no encontrada' };
        }
        if (!item.apuntado) {
          item.apuntado = true;
          item.asistentes += 1;
          store.messages.push({
            id: uid(),
            system: true,
            text: '✅ ' + USER.name + ' se ha apuntado a «' + item.titulo + '»',
            date: Date.now()
          });
        }
        return { ok: true, formacion: item };
      },

      kbAsk: function (teamId, payload) {
        const team = teamById(teamId);
        const result = findKbAnswer(team, payload.question);
        return { ok: true, answer: result.answer, sources: result.sources };
      }
    };
  })();

  // ─────────────────────────────────────────────────────────── Capa de API ──

  /**
   * Punto único de acceso a datos. Todas las acciones llevan el equipo
   * activo. En modo real, el POST va como text/plain para evitar el
   * preflight CORS (Apps Script no lo soporta).
   */
  async function api(action, payload) {
    const teamId = state.currentTeamId;

    if (MOCK_MODE) {
      await delay(rand(200, 550));
      switch (action) {
        case 'getChat':
          return MockBackend.getChat(teamId);
        case 'sendMessage':
          return MockBackend.sendMessage(teamId, payload);
        case 'getFormaciones':
          return MockBackend.getFormaciones(teamId);
        case 'createFormacion':
          return MockBackend.createFormacion(teamId, payload);
        case 'rsvp':
          return MockBackend.rsvp(teamId, payload);
        case 'kbAsk':
          // En modo real esta acción NO va a Apps Script: usará la
          // Language Model API (Copilot) desde la extensión.
          return MockBackend.kbAsk(teamId, payload);
        default:
          return { ok: false, error: 'Acción desconocida: ' + action };
      }
    }

    // ── Modo real (Google Apps Script) ──
    if (payload) {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign(
          { action: action, team: teamId, email: USER.email, name: USER.name },
          payload
        ))
      });
      return res.json();
    }
    const url =
      APPS_SCRIPT_URL +
      '?action=' + encodeURIComponent(action) +
      '&team=' + encodeURIComponent(teamId) +
      '&email=' + encodeURIComponent(USER.email);
    const res = await fetch(url);
    return res.json();
  }

  // ─────────────────────────────────────────────────────── Estado de la UI ──

  const state = {
    currentTeamId: TEAMS[0].id,
    messages: [],
    formaciones: [],
    sending: false,
    kbBusy: false,
    /** Historial de la Knowledge Base por equipo. */
    kbHistories: {}
  };

  function kbHistory(teamId) {
    if (!state.kbHistories[teamId]) {
      const team = teamById(teamId);
      state.kbHistories[teamId] = [
        {
          id: uid(),
          role: 'assistant',
          text:
            '¡Hola! Soy **Copilot** conectado a la Knowledge Base del ' +
            '**' + team.nombre + '** (`' + KB_BASE_PATH + '/' + team.kbFolder +
            '`, ' + team.kbDocs + ' documentos indexados — simulado).\n\n' +
            'Pregúntame lo que necesites: citaré las fuentes de cada respuesta.',
          sources: [],
          date: Date.now()
        }
      ];
    }
    return state.kbHistories[teamId];
  }

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

    wrap.querySelectorAll('.btn-rsvp').forEach(function (btn) {
      btn.addEventListener('click', function () {
        onRsvp(btn.getAttribute('data-id'), btn);
      });
    });
  }

  // ─────────────────────────────────────────────── Render: Knowledge Base ──

  /** Crea el nodo DOM de un mensaje de la KB y lo añade a la lista. */
  function appendKbMessage(msg) {
    const list = $('kbList');
    const node = document.createElement('div');

    if (msg.role === 'user') {
      node.className = 'msg-row own first-of-group last-of-group';
      node.innerHTML =
        '<span class="avatar avatar-own" title="' + escapeHtml(USER.name) + '">' +
        escapeHtml(initials(USER.name)) + '</span>' +
        '<div class="msg-block"><div class="msg-bubble">' +
        escapeHtml(msg.text) +
        '<span class="time">' + fmtTime(msg.date) + '</span></div></div>';
    } else {
      node.className = 'kb-answer';
      node.innerHTML =
        '<div class="kb-head"><span class="kb-bot">🤖</span> Copilot · Knowledge Base' +
        '<span class="kb-time">' + fmtTime(msg.date) + '</span></div>' +
        '<div class="kb-body">' +
        (msg.streaming
          ? escapeHtml(msg.text) + '<span class="caret"></span>'
          : mdLite(msg.text)) +
        '</div>' +
        '<div class="kb-sources"></div>';
      fillKbSources(node, msg);
    }

    list.appendChild(node);
    list.scrollTop = list.scrollHeight;
    return node;
  }

  function fillKbSources(node, msg) {
    const box = node.querySelector('.kb-sources');
    if (!box) return;
    if (!msg.sources || !msg.sources.length || msg.streaming) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML =
      '<span class="src-label">Fuentes:</span>' +
      msg.sources
        .map(function (src) {
          return (
            '<button class="src-chip" type="button" data-path="' +
            escapeHtml(src) + '" title="Abrir documento (demo)">📄 ' +
            escapeHtml(src.split('/').pop()) + '</button>'
          );
        })
        .join('');
    box.querySelectorAll('.src-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        vscode.postMessage({ type: 'openSource', path: chip.getAttribute('data-path') });
      });
    });
  }

  /** Repinta todo el historial de la KB del equipo activo. */
  function renderKbAll() {
    const list = $('kbList');
    list.innerHTML = '';
    kbHistory(state.currentTeamId).forEach(function (msg) {
      appendKbMessage(msg);
    });
  }

  function renderKbSuggestions() {
    const team = teamById(state.currentTeamId);
    const box = $('kbSuggest');
    box.innerHTML = team.kbSuggestions
      .map(function (q) {
        return (
          '<button class="sug-chip" type="button">' + escapeHtml(q) + '</button>'
        );
      })
      .join('');
    box.querySelectorAll('.sug-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        askKb(chip.textContent);
      });
    });
  }

  /** Pregunta a la KB con efecto de streaming estilo Copilot. */
  async function askKb(question) {
    const q = String(question || '').trim();
    if (!q || state.kbBusy) return;

    const teamId = state.currentTeamId;
    const history = kbHistory(teamId);
    state.kbBusy = true;
    $('kbText').value = '';
    autoGrow($('kbText'));

    history.push({ id: uid(), role: 'user', text: q, date: Date.now() });
    if (teamId === state.currentTeamId) {
      appendKbMessage(history[history.length - 1]);
    }

    // Mensaje del asistente en modo streaming.
    const answerMsg = {
      id: uid(),
      role: 'assistant',
      text: '',
      sources: [],
      streaming: true,
      date: Date.now()
    };
    history.push(answerMsg);
    let node =
      teamId === state.currentTeamId ? appendKbMessage(answerMsg) : null;

    try {
      // Latencia de "búsqueda en la KB + Copilot".
      const data = await api('kbAsk', { question: q });
      const full = data.answer || 'No he podido generar una respuesta.';

      // Streaming: revela la respuesta por trozos.
      let i = 0;
      await new Promise(function (resolve) {
        const timer = setInterval(function () {
          i = Math.min(full.length, i + rand(2, 6));
          answerMsg.text = full.slice(0, i);
          if (node && node.isConnected) {
            const body = node.querySelector('.kb-body');
            body.innerHTML = escapeHtml(answerMsg.text) + '<span class="caret"></span>';
            const list = $('kbList');
            list.scrollTop = list.scrollHeight;
          }
          if (i >= full.length) {
            clearInterval(timer);
            resolve();
          }
        }, 24);
      });

      answerMsg.streaming = false;
      answerMsg.text = full;
      answerMsg.sources = data.sources || [];
      // Repinta el historial completo: cubre también el caso de haber
      // cambiado de equipo y vuelto durante el streaming.
      if (state.currentTeamId === teamId) {
        renderKbAll();
      }
    } catch (err) {
      answerMsg.streaming = false;
      answerMsg.text = '⚠️ No se pudo consultar la Knowledge Base.';
      if (state.currentTeamId === teamId) {
        renderKbAll();
      }
    } finally {
      state.kbBusy = false;
      if (state.currentTeamId === teamId) {
        $('kbText').focus();
      }
    }
  }

  // ──────────────────────────────────────────────────────────── Acciones ──

  async function refreshChat() {
    const teamId = state.currentTeamId;
    try {
      const data = await api('getChat');
      // Si el usuario cambió de equipo mientras llegaba la respuesta, se ignora.
      if (teamId !== state.currentTeamId) return;
      if (data && data.ok) {
        state.messages = data.messages;
        renderChat();
        setTyping(data.typing || null);
        $('syncText').textContent = 'Sincronizado · ' + fmtTime(Date.now());
      }
    } catch (err) {
      if (teamId === state.currentTeamId) {
        $('syncText').textContent = 'Sin conexión';
      }
    }
  }

  async function refreshFormaciones() {
    const teamId = state.currentTeamId;
    try {
      const data = await api('getFormaciones');
      if (teamId !== state.currentTeamId) return;
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

  // ─────────────────────────────────────────────── Selector de equipos ──

  function initTeamSelect() {
    const select = $('teamSelect');
    select.innerHTML = TEAMS.map(function (team) {
      return (
        '<option value="' + team.id + '">' +
        team.icon + ' ' + escapeHtml(team.nombre) +
        '</option>'
      );
    }).join('');
    select.value = state.currentTeamId;
    select.addEventListener('change', function () {
      switchTeam(select.value);
    });
  }

  /** Cambia el equipo activo y repinta chat, KB y formaciones. */
  function switchTeam(teamId) {
    if (teamId === state.currentTeamId) return;
    state.currentTeamId = teamId;
    const team = teamById(teamId);

    // Cabeceras contextuales.
    $('chatGroupEmail').textContent = team.grupo;
    $('formTeamLabel').textContent = team.icon + ' ' + team.nombre;
    $('kbPath').textContent = '📁 ' + KB_BASE_PATH + '/' + team.kbFolder;
    $('kbDocs').textContent = '📄 ' + team.kbDocs + ' docs indexados';
    $('chatText').placeholder =
      'Mensaje a ' + team.grupo + '…  (Enter para enviar)';
    $('kbText').placeholder =
      'Pregunta a la KB del ' + team.nombre + '…  (Enter para enviar)';

    // Estado transitorio fuera.
    setTyping(null);
    $('syncText').textContent = 'Sincronizando…';
    state.messages = [];
    state.formaciones = [];
    renderChat();
    renderFormaciones();
    renderKbAll();
    renderKbSuggestions();

    refreshChat().then(function () {
      const list = $('chatList');
      list.scrollTop = list.scrollHeight;
    });
    refreshFormaciones();
    toast(team.icon + ' Cambiado al ' + team.nombre);
  }

  // ──────────────────────────────────────────────────────────── Pestañas ──

  function initTabs() {
    const tabChat = $('tabChat');
    const tabKb = $('tabKb');

    function activate(tab) {
      const isChat = tab === 'chat';
      tabChat.classList.toggle('active', isChat);
      tabKb.classList.toggle('active', !isChat);
      tabChat.setAttribute('aria-selected', String(isChat));
      tabKb.setAttribute('aria-selected', String(!isChat));
      $('viewChat').hidden = !isChat;
      $('viewKb').hidden = isChat;
      if (isChat) {
        $('chatList').scrollTop = $('chatList').scrollHeight;
        $('chatText').focus();
      } else {
        $('kbList').scrollTop = $('kbList').scrollHeight;
        $('kbText').focus();
      }
    }

    tabChat.addEventListener('click', function () { activate('chat'); });
    tabKb.addEventListener('click', function () { activate('kb'); });
  }

  // ─────────────────────────────────────────────────────── Pequeña UI aux ──

  function toggleFormNueva(show) {
    const form = $('formNueva');
    const willShow = typeof show === 'boolean' ? show : form.hidden;
    form.hidden = !willShow;
    $('btnToggleNueva').textContent = willShow ? '－ Cerrar' : '＋ Nueva';
    if (willShow) {
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
    const team = teamById(state.currentTeamId);

    $('userLine').textContent =
      'Conectado como ' + USER.name + ' · ' + USER.email;
    const avatar = $('userAvatar');
    avatar.textContent = initials(USER.name);
    avatar.title = USER.name + ' (' + USER.email + ')';

    if (MOCK_MODE) {
      $('badgeDemo').hidden = false;
      $('demoBanner').hidden = false;
    }

    // Cabeceras del equipo inicial.
    $('chatGroupEmail').textContent = team.grupo;
    $('formTeamLabel').textContent = team.icon + ' ' + team.nombre;
    $('kbPath').textContent = '📁 ' + KB_BASE_PATH + '/' + team.kbFolder;
    $('kbDocs').textContent = '📄 ' + team.kbDocs + ' docs indexados';
    $('chatText').placeholder =
      'Mensaje a ' + team.grupo + '…  (Enter para enviar)';
    $('kbText').placeholder =
      'Pregunta a la KB del ' + team.nombre + '…  (Enter para enviar)';

    initTeamSelect();
    initTabs();

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

    // Knowledge Base.
    $('kbForm').addEventListener('submit', function (event) {
      event.preventDefault();
      askKb($('kbText').value);
    });
    const kbText = $('kbText');
    kbText.addEventListener('input', function () {
      autoGrow(kbText);
    });
    kbText.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('kbForm').requestSubmit();
      }
    });
    renderKbAll();
    renderKbSuggestions();

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
