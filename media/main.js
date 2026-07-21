/* ════════════════════════════════════════════════════════════════════════
   Team Hub · Área de Tesorería — lógica del webview (JS vanilla)

   MODO MOCK: mientras MOCK_MODE sea true, todas las llamadas a la "API"
   se resuelven contra un backend simulado en memoria (MockBackend):
   equipos de las aplicaciones tecnológicas de Tesorería, compañeros
   ficticios que escriben en el chat, formaciones del área y una
   Knowledge Base que imita a Copilot citando documentos de una ruta
   local. Nada sale de este webview.

   MODO REAL: al poner MOCK_MODE = false…
    - chat/formaciones/usuario → fetch a la Web App de Google Apps Script
      (APPS_SCRIPT_URL, ver backend/backend.gs). La acción getUserInfo
      devuelve el EQUIPO del usuario (hoja "Usuarios"), que determina su
      Knowledge Base completa; las KB de otros equipos son la versión
      reducida.
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

  const USER = CONFIG.user || { name: 'Usuario demo', email: 'demo@banco.demo' };

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

  // ══════════════════════════════════════ EQUIPOS DEL ÁREA DE TESORERÍA ═══
  //  Cada equipo mantiene una de las aplicaciones tecnológicas del área:
  //  su Google Group (chat), sus formaciones y su carpeta de Knowledge
  //  Base en la ruta local.
  // ═══════════════════════════════════════════════════════════════════════

  const TEAMS = [
    {
      id: 'front-office',
      nombre: 'Front Office (Murex)',
      corto: 'Front Office',
      icon: '💱',
      grupo: 'fo-murex@banco.demo',
      kbFolder: 'front-office-murex',
      kbDocs: 14,
      members: [
        { name: 'Lucía Ferrer', email: 'lucia.ferrer@banco.demo' },
        { name: 'Marcos Peña', email: 'marcos.pena@banco.demo' },
        { name: 'Irene Solano', email: 'irene.solano@banco.demo' }
      ],
      kbSuggestions: [
        '¿Cómo relanzo el EOD si falla?',
        '¿Dónde está la guía de pricing de swaps?',
        '¿Cuál es el proceso de pases a producción?'
      ],
      kb: [
        {
          keywords: ['eod', 'batch', 'cierre', 'nocturno', 'relanzar', 'curva'],
          answer:
            'El **EOD de Murex** se lanza a las 22:30 desde el orquestador:\n\n' +
            '- Si falla la carga de curvas, revisa primero el feed de market data (`MDCS`).\n' +
            '- Relanza solo el bloque fallido con `relanzar_eod.sh --paso <n>`; nunca el EOD completo sin avisar.\n' +
            '- Si el fallo afecta a la valoración oficial, comunícalo a Riesgos antes de las 7:30.',
          sources: [
            'kb/front-office-murex/eod.md',
            'kb/front-office-murex/runbooks/relanzar-eod.md'
          ]
        },
        {
          keywords: ['pricer', 'pricing', 'valoracion', 'swap', 'derivado', 'curvas'],
          answer:
            'La valoración de swaps usa los **pricers del módulo MX.3**:\n\n' +
            '- Curvas de descuento OIS (€STR) y proyección según el índice de la pata.\n' +
            '- La configuración de generadores de curva está documentada con capturas.\n' +
            '- Cualquier cambio de convención requiere visto bueno de Riesgos y prueba en UAT.',
          sources: [
            'kb/front-office-murex/guia-pricing.md',
            'kb/front-office-murex/curvas.md'
          ]
        },
        {
          keywords: ['pase', 'produccion', 'despliegue', 'uat', 'parche', 'entorno', 'cambio'],
          answer:
            'Proceso de **pases a producción** de Murex:\n\n' +
            '- Todo pase se presenta en el comité de cambios de los miércoles.\n' +
            '- Ventana de despliegue: martes y jueves 19:00–21:00 (nunca en cierre de mes).\n' +
            '- Se exige evidencia de prueba en UAT firmada por la mesa afectada.',
          sources: [
            'kb/front-office-murex/pases.md',
            'kb/front-office-murex/comite-cambios.md'
          ]
        }
      ],
      kbFallbackSources: [
        'kb/front-office-murex/indice.md',
        'kb/front-office-murex/faq.md'
      ]
    },
    {
      id: 'liquidez',
      nombre: 'Liquidez y Pagos',
      corto: 'Liquidez',
      icon: '💧',
      grupo: 'liquidez-pagos@banco.demo',
      kbFolder: 'liquidez-pagos',
      kbDocs: 11,
      members: [
        { name: 'Nuria Campos', email: 'nuria.campos@banco.demo' },
        { name: 'Óscar Molina', email: 'oscar.molina@banco.demo' }
      ],
      kbSuggestions: [
        '¿Cómo libero un pago retenido?',
        '¿Cada cuánto se hace el barrido de nostros?',
        '¿De dónde se alimenta el forecast de liquidez?'
      ],
      kb: [
        {
          keywords: ['pago', 'retenido', 'swift', 'mx', 'iso 20022', 'pacs', 'liberar', 'sanciones'],
          answer:
            'Los **pagos retenidos** quedan en la cola del filtro de sanciones:\n\n' +
            '- Revisa el motivo en el monitor de pagos (pestaña *Compliance*).\n' +
            '- Solo Cumplimiento puede liberar; nosotros documentamos y reclamamos por el buzón oficial.\n' +
            '- Con ISO 20022, los `pacs.008` rechazados devuelven un `pacs.002` con el código de motivo.',
          sources: [
            'kb/liquidez-pagos/pagos-retenidos.md',
            'kb/liquidez-pagos/swift-mx.md'
          ]
        },
        {
          keywords: ['nostro', 'barrido', 'sweeping', 'cuenta', 'saldo'],
          answer:
            'El **barrido de cuentas nostro** (sweeping) corre dos veces al día:\n\n' +
            '- 11:30 CET → posiciones en EUR (vía TARGET2).\n' +
            '- 16:00 CET → resto de divisas según el cutoff de cada corresponsal.\n' +
            '- Los umbrales por cuenta se mantienen en la tabla `SWEEP_CONFIG`.',
          sources: ['kb/liquidez-pagos/nostros.md']
        },
        {
          keywords: ['forecast', 'liquidez', 'prevision', 'intradia', 'dashboard', 'buffer'],
          answer:
            'El **forecast de liquidez intradía** se alimenta de tres fuentes:\n\n' +
            '- Vencimientos de tesorería (posiciones de Murex, corte 7:00).\n' +
            '- Previsión de pagos de clientes (fichero de las sucursales).\n' +
            '- Movimientos de mercado confirmados por Back Office.\n\n' +
            'El dashboard se refresca cada 15 min; el buffer regulatorio se marca en rojo si baja del umbral.',
          sources: [
            'kb/liquidez-pagos/forecast.md',
            'kb/liquidez-pagos/dashboard.md'
          ]
        }
      ],
      kbFallbackSources: [
        'kb/liquidez-pagos/indice.md',
        'kb/liquidez-pagos/faq.md'
      ]
    },
    {
      id: 'riesgos',
      nombre: 'Riesgos y Límites',
      corto: 'Riesgos',
      icon: '📊',
      grupo: 'riesgos-limites@banco.demo',
      kbFolder: 'riesgos-limites',
      kbDocs: 16,
      members: [
        { name: 'Paula Núñez', email: 'paula.nunez@banco.demo' },
        { name: 'Andrés Vega', email: 'andres.vega@banco.demo' },
        { name: 'Clara Ibáñez', email: 'clara.ibanez@banco.demo' }
      ],
      kbSuggestions: [
        '¿Qué hago ante un exceso de límite?',
        '¿A qué hora corre el batch de VaR?',
        '¿Cómo se recalcula el CVA?'
      ],
      kb: [
        {
          keywords: ['var', 'escenario', 'estres', 'batch', 'nocturno', 'sensibilidad'],
          answer:
            'El **batch de VaR** (99%, horizonte 1 día) corre a las 2:00:\n\n' +
            '- 500 escenarios históricos + 40 de estrés definidos por el comité.\n' +
            '- Si el batch supera las 5:00, se activa el protocolo de contingencia (VaR aproximado).\n' +
            '- Las sensibilidades por mesa se publican en el informe de las 8:00.',
          sources: [
            'kb/riesgos-limites/var.md',
            'kb/riesgos-limites/escenarios.md'
          ]
        },
        {
          keywords: ['limite', 'exceso', 'contraparte', 'intradia', 'justificar'],
          answer:
            'Ante un **exceso de límite** el circuito es:\n\n' +
            '- El monitor lo marca en ámbar (intradía) o rojo (cierre).\n' +
            '- La mesa tiene **2 horas** para justificarlo o deshacer la posición.\n' +
            '- Riesgos valida la justificación y deja constancia en la herramienta de límites.',
          sources: [
            'kb/riesgos-limites/limites.md',
            'kb/riesgos-limites/procedimiento-excesos.md'
          ]
        },
        {
          keywords: ['cva', 'xva', 'ajuste', 'valoracion', 'contrapartida', 'descuento'],
          answer:
            'El **CVA** se recalcula en dos momentos:\n\n' +
            '- Nocturno completo con la curva de crédito de cierre.\n' +
            '- Intradía bajo demanda para operaciones nuevas de importe relevante.\n' +
            '- Los spreads de crédito se toman del feed oficial; sin cotización, se aplica el *proxy* sectorial.',
          sources: ['kb/riesgos-limites/xva.md']
        }
      ],
      kbFallbackSources: [
        'kb/riesgos-limites/indice.md',
        'kb/riesgos-limites/metodologia.md'
      ]
    },
    {
      id: 'back-office',
      nombre: 'Back Office y Conciliación',
      corto: 'Back Office',
      icon: '🧾',
      grupo: 'bo-conciliacion@banco.demo',
      kbFolder: 'back-office',
      kbDocs: 9,
      members: [
        { name: 'Sergio Lara', email: 'sergio.lara@banco.demo' },
        { name: 'Eva Duarte', email: 'eva.duarte@banco.demo' }
      ],
      kbSuggestions: [
        '¿Cómo reclamo una confirmación sin casar?',
        '¿Qué hago con un descuadre en nostros?',
        '¿Cuáles son las ventanas de liquidación?'
      ],
      kb: [
        {
          keywords: ['confirmacion', 'mt300', 'casar', 'matching', 'contrapartida', 'reclamar'],
          answer:
            'Confirmaciones **sin casar** (MT300/MT320):\n\n' +
            '- El matching automático reintenta cada 30 min hasta el cutoff.\n' +
            '- Pasadas 4 horas, se reclama a la contrapartida por el canal acordado (plantilla oficial).\n' +
            '- Si la discrepancia es económica, se escala a Front Office antes de tocar nada.',
          sources: [
            'kb/back-office/confirmaciones.md',
            'kb/back-office/runbooks/mt300.md'
          ]
        },
        {
          keywords: ['conciliacion', 'nostro', 'descuadre', 'apunte', 'cuadre'],
          answer:
            'La **conciliación de nostros** corre a las 8:00 con los extractos MT940/camt.053:\n\n' +
            '- Los descuadres van a la cola de investigación con antigüedad y responsable.\n' +
            '- Apuntes < 50 € (comisiones) se regularizan en el día con la cuenta puente.\n' +
            '- Todo descuadre > 5 días se reporta al responsable del área.',
          sources: ['kb/back-office/conciliacion.md']
        },
        {
          keywords: ['liquidacion', 'target2', 'ventana', 'settlement', 'cutoff'],
          answer:
            'Ventanas de **liquidación** habituales:\n\n' +
            '- TARGET2: hasta las 17:00 CET para pagos de cliente, 18:00 interbancario.\n' +
            '- Divisas vía CLS: cutoff interno 15:30 CET.\n' +
            '- Fuera de ventana, se necesita aprobación del responsable de Tesorería (procedimiento de excepción).',
          sources: [
            'kb/back-office/liquidacion.md',
            'kb/back-office/runbooks/excepciones.md'
          ]
        }
      ],
      kbFallbackSources: [
        'kb/back-office/indice.md',
        'kb/back-office/faq.md'
      ]
    }
  ];

  function teamById(id) {
    return TEAMS.find(function (t) { return t.id === id; }) || TEAMS[0];
  }

  /** Nº de documentos visibles en la versión reducida de una KB ajena. */
  function reducedDocs(team) {
    return Math.max(3, Math.round(team.kbDocs / 3));
  }

  // ═══════════════════════════════════════════════════════ MOCK BACKEND ═══
  //  Simula la Web App de Apps Script: chats por equipo (Google Groups),
  //  formaciones GLOBALES del área (Calendar + Sheets con columna Equipo),
  //  el equipo del usuario (hoja "Usuarios") y la Knowledge Base.
  // ═══════════════════════════════════════════════════════════════════════

  const MockBackend = (function () {
    const MIN = 60 * 1000;
    const now = Date.now();

    /**
     * Equipo de la usuaria según la hoja "Usuarios" del backend.
     * En real: doGet?action=getUserInfo&email=… lo resuelve Apps Script.
     */
    const MOCK_USER_TEAM = 'front-office';

    const REPLIES = [
      '¡Buena idea, {name}! 💡',
      'Visto 👍',
      'Lo comentamos en la daily 🙌',
      '+1',
      'Gracias por avisar 🙏',
      'Ok, me lo apunto 📝'
    ];

    /** Chat inicial y mensajes programados por equipo. */
    function createChatStore(team) {
      const m = team.members;
      let messages = [];
      let scheduled = [];

      if (team.id === 'front-office') {
        messages = [
          { sender: m[0], text: 'Buenos días! El EOD de Murex acabó a las 6:12, sin errores en curvas 📈', date: now - 135 * MIN },
          { sender: m[1], text: 'He subido el parche del pricer de swaps a UAT, ¿alguien lo valida con la mesa?', date: now - 120 * MIN },
          { sender: m[2], text: 'Lo pruebo con las operaciones de test de la mesa de divisa 👍', date: now - 117 * MIN },
          { system: true, text: '📅 Nueva formación publicada: «Curvas y pricing en Murex»', date: now - 65 * MIN },
          { sender: m[0], text: 'Recordad: viernes es cierre de mes, congelamos cambios en producción 🙏', date: now - 22 * MIN }
        ];
        scheduled = [
          { at: now + 9000, sender: m[1], text: 'La mesa reporta lentitud en el blotter de FX, ¿lo estáis viendo?' },
          { at: now + 27000, sender: m[2], text: 'Reinicio el servicio de market data en pre y os cuento 🔧' },
          { at: now + 70000, sender: m[0], text: 'Mañana 12:00 comité de cambios: llevad preparados vuestros pases.' }
        ];
      } else if (team.id === 'liquidez') {
        messages = [
          { sender: m[0], text: 'El forecast de liquidez de hoy ya está cargado en el dashboard ✅', date: now - 100 * MIN },
          { sender: m[1], text: 'Ojo: TARGET2 publica ventana de mantenimiento este sábado.', date: now - 90 * MIN },
          { system: true, text: '📅 Nueva formación publicada: «Pagos SWIFT MX (ISO 20022)»', date: now - 55 * MIN },
          { sender: m[0], text: 'Quedan 3 pagos retenidos en la cola de sanciones, los estoy revisando con Cumplimiento.', date: now - 15 * MIN }
        ];
        scheduled = [
          { at: now + 14000, sender: m[1], text: 'Barrido de nostros de las 11:30 completado, sin descuadres 🎉' },
          { at: now + 52000, sender: m[0], text: '¿Podéis validar el fichero de previsión de la sucursal de Londres?' }
        ];
      } else if (team.id === 'riesgos') {
        messages = [
          { sender: m[0], text: 'El batch de VaR tardó 40 min más esta noche por los escenarios nuevos.', date: now - 110 * MIN },
          { sender: m[1], text: 'Hay un exceso intradía en una contraparte, la mesa ya está avisada.', date: now - 95 * MIN },
          { sender: m[2], text: 'Subo el informe de sensibilidades para el comité de riesgos 📊', date: now - 80 * MIN },
          { system: true, text: '📅 Nueva formación publicada: «Límites de contraparte e intradía»', date: now - 48 * MIN }
        ];
        scheduled = [
          { at: now + 18000, sender: m[0], text: 'CVA recalculado con la curva nueva: diferencias mínimas ✔️' },
          { at: now + 60000, sender: m[1], text: 'Recordad revisar los excesos pendientes de justificar antes del cierre.' }
        ];
      } else {
        messages = [
          { sender: m[0], text: 'Quedan 2 confirmaciones MT300 de ayer sin casar, reclamadas a la contrapartida.', date: now - 105 * MIN },
          { sender: m[1], text: 'La conciliación de nostros cuadra salvo un apunte de 12,50 € (comisión) 🔍', date: now - 92 * MIN },
          { system: true, text: '📅 Nueva formación publicada: «Conciliación de cuentas nostro»', date: now - 60 * MIN },
          { sender: m[0], text: 'Migración a MX: el viernes probamos los semt.017 en el entorno de pruebas.', date: now - 20 * MIN }
        ];
        scheduled = [
          { at: now + 16000, sender: m[1], text: 'Liquidación de la ventana TARGET2 completada sin incidencias ✅' },
          { at: now + 58000, sender: m[0], text: '¿Alguien me pasa el manual del matching de confirmaciones?' }
        ];
      }

      return {
        messages: messages.map(function (msg) {
          return msg.system
            ? { id: uid(), system: true, text: msg.text, date: msg.date }
            : { id: uid(), sender: msg.sender.name, email: msg.sender.email, text: msg.text, date: msg.date };
        }),
        scheduled: scheduled,
        replyIndex: 0
      };
    }

    const chatStores = {};
    TEAMS.forEach(function (team) {
      chatStores[team.id] = createChatStore(team);
    });

    /**
     * Formaciones GLOBALES del área de Tesorería.
     * Cada una pertenece al equipo que la organiza (columna "Equipo" en la
     * hoja de cálculo del backend real).
     */
    const formaciones = [
      { teamId: 'front-office', titulo: 'Curvas y pricing en Murex', fecha: futureDate(2, 10, 0), descripcion: 'Generadores de curva, descuento OIS y validación de la valoración oficial frente a la mesa.', creador: 'Lucía Ferrer', asistentes: 9 },
      { teamId: 'liquidez', titulo: 'Pagos SWIFT MX (ISO 20022)', fecha: futureDate(3, 12, 0), descripcion: 'De MT a MX: pacs.008, pacs.002 y cómo leer los códigos de rechazo del nuevo esquema.', creador: 'Óscar Molina', asistentes: 12 },
      { teamId: 'riesgos', titulo: 'VaR y escenarios de estrés', fecha: futureDate(4, 16, 0), descripcion: 'Cómo se calcula el VaR del área, qué escenarios usamos y cómo interpretar el informe diario.', creador: 'Paula Núñez', asistentes: 7 },
      { teamId: 'back-office', titulo: 'Conciliación de cuentas nostro', fecha: futureDate(5, 9, 30), descripcion: 'Extractos MT940/camt.053, cola de investigación y regularización de apuntes menores.', creador: 'Eva Duarte', asistentes: 3 },
      { teamId: 'riesgos', titulo: 'Límites de contraparte e intradía', fecha: futureDate(7, 12, 30), descripcion: 'Circuito de excesos, justificación por la mesa y registro en la herramienta de límites.', creador: 'Andrés Vega', asistentes: 6 },
      { teamId: 'front-office', titulo: 'Introducción al módulo de colateral', fecha: futureDate(8, 10, 0), descripcion: 'CSAs, llamadas de margen y cómo se refleja el colateral en la posición de tesorería.', creador: 'Marcos Peña', asistentes: 4 },
      { teamId: 'liquidez', titulo: 'Forecast de liquidez intradía', fecha: futureDate(10, 11, 0), descripcion: 'Fuentes del forecast, buffer regulatorio y lectura del dashboard de liquidez.', creador: 'Nuria Campos', asistentes: 5 },
      { teamId: 'back-office', titulo: 'Confirmaciones: de MT a MX', fecha: futureDate(12, 16, 0), descripcion: 'Calendario de migración a ISO 20022 en confirmaciones y qué cambia en el matching.', creador: 'Sergio Lara', asistentes: 8 }
    ].map(function (f) {
      return Object.assign({ id: uid(), apuntado: false }, f);
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
          'No he encontrado una respuesta exacta en la Knowledge Base de ' +
          '**' + team.nombre + '**, pero estos documentos pueden ayudarte:\n\n' +
          '- `' + team.kbFallbackSources[0] + '` — mapa de toda la documentación\n' +
          '- `' + team.kbFallbackSources[1] + '` — preguntas frecuentes\n\n' +
          'Prueba a reformular la pregunta con otras palabras clave.',
        sources: team.kbFallbackSources.slice()
      };
    }

    return {
      /** Equipo del usuario (en real: hoja "Usuarios" vía getUserInfo). */
      getUserInfo: function () {
        return { ok: true, team: MOCK_USER_TEAM };
      },

      getChat: function (teamId) {
        const store = chatStores[teamId];
        flushScheduled(store);
        return { ok: true, messages: store.messages.slice(), typing: typingNow(store) };
      },

      sendMessage: function (teamId, payload) {
        const store = chatStores[teamId];
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
        // En el chat de otro equipo la respuesta tarda bastante más
        // (están a lo suyo): refuerza el aviso de paciencia.
        const foreign = teamId !== MOCK_USER_TEAM;
        store.scheduled.push({
          at: Date.now() + (foreign ? rand(9000, 16000) : rand(2800, 5200)),
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

      createFormacion: function (teamId, payload) {
        const nueva = {
          id: uid(),
          teamId: teamId,
          titulo: payload.titulo,
          fecha: payload.fecha,
          descripcion: payload.descripcion || '',
          creador: USER.name,
          asistentes: 1,
          apuntado: true
        };
        formaciones.push(nueva);
        chatStores[teamId].messages.push({
          id: uid(),
          system: true,
          text: '📅 Nueva formación publicada: «' + payload.titulo + '»',
          date: Date.now()
        });
        return { ok: true, formacion: nueva };
      },

      rsvp: function (payload) {
        const item = formaciones.find(function (f) { return f.id === payload.id; });
        if (!item) {
          return { ok: false, error: 'Formación no encontrada' };
        }
        if (!item.apuntado) {
          item.apuntado = true;
          item.asistentes += 1;
          chatStores[item.teamId].messages.push({
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
   * Punto único de acceso a datos. Las acciones de chat/KB llevan el
   * equipo activo; las formaciones son globales del área. En modo real,
   * el POST va como text/plain para evitar el preflight CORS.
   */
  async function api(action, payload) {
    const teamId = state.currentTeamId;

    if (MOCK_MODE) {
      await delay(rand(200, 550));
      switch (action) {
        case 'getUserInfo':
          return MockBackend.getUserInfo();
        case 'getChat':
          return MockBackend.getChat(teamId);
        case 'sendMessage':
          return MockBackend.sendMessage(teamId, payload);
        case 'getFormaciones':
          return MockBackend.getFormaciones();
        case 'createFormacion':
          return MockBackend.createFormacion(teamId, payload);
        case 'rsvp':
          return MockBackend.rsvp(payload);
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
    /** Equipo al que pertenece la usuaria (lo indica el backend). */
    userTeamId: null,
    currentTeamId: TEAMS[0].id,
    messages: [],
    formaciones: [],
    /** Filtro del panel de formaciones: 'all' | 'team'. */
    formFilter: 'all',
    sending: false,
    kbBusy: false,
    /** Historial de la Knowledge Base por equipo. */
    kbHistories: {}
  };

  function isForeign(teamId) {
    return state.userTeamId !== null && teamId !== state.userTeamId;
  }

  function kbHistory(teamId) {
    if (!state.kbHistories[teamId]) {
      const team = teamById(teamId);
      const foreign = isForeign(teamId);
      const text = foreign
        ? 'Estás consultando la **versión reducida** de la Knowledge Base de ' +
          '**' + team.nombre + '** (' + reducedDocs(team) + ' de ' + team.kbDocs +
          ' documentos). Puede contener errores o información desactualizada.\n\n' +
          'Si no resuelvo tu duda, pregunta en su chat — con paciencia 🙂.'
        : '¡Hola! Soy **Copilot** conectado a la Knowledge Base de tu equipo, ' +
          '**' + team.nombre + '** (`' + KB_BASE_PATH + '/' + team.kbFolder +
          '`, ' + team.kbDocs + ' documentos indexados — simulado).\n\n' +
          'Pregúntame lo que necesites: citaré las fuentes de cada respuesta.';
      state.kbHistories[teamId] = [
        {
          id: uid(),
          role: 'assistant',
          text: text,
          sources: [],
          reduced: foreign,
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
    const filtered =
      state.formFilter === 'team'
        ? state.formaciones.filter(function (f) {
            return f.teamId === state.currentTeamId;
          })
        : state.formaciones;

    if (!filtered.length) {
      wrap.innerHTML =
        '<div class="empty"><span class="empty-icon">🗓️</span>' +
        (state.formFilter === 'team'
          ? 'Este equipo aún no ha montado formaciones próximas.'
          : 'No hay formaciones próximas en el área.') +
        '</div>';
      return;
    }

    let html = '';
    filtered.forEach(function (f) {
      const team = teamById(f.teamId);
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
      html +=
        '<span class="pill team">' + team.icon + ' ' +
        escapeHtml(team.corto) + '</span>';
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

  function setFormFilter(filter) {
    state.formFilter = filter;
    const team = teamById(state.currentTeamId);
    $('filtAll').classList.toggle('active', filter === 'all');
    $('filtTeam').classList.toggle('active', filter === 'team');
    $('formTeamLabel').textContent =
      filter === 'team'
        ? 'organizadas por ' + team.corto
        : 'todos los equipos del área';
    renderFormaciones();
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
      node.className = 'kb-answer' + (msg.reduced ? ' reduced' : '');
      node.innerHTML =
        '<div class="kb-head"><span class="kb-bot">🤖</span> Copilot · Knowledge Base' +
        (msg.reduced ? ' <span class="kb-flag">reducida</span>' : '') +
        '<span class="kb-time">' + fmtTime(msg.date) + '</span></div>' +
        '<div class="kb-body">' +
        (msg.streaming
          ? escapeHtml(msg.text) + '<span class="caret"></span>'
          : mdLite(msg.text)) +
        '</div>' +
        '<div class="kb-sources"></div>' +
        (msg.reduced && !msg.streaming && msg.sources && msg.sources.length
          ? '<div class="kb-caveat">⚠️ Respuesta generada desde la versión ' +
            'reducida de la KB de otro equipo: verifícala con sus propietarios.</div>'
          : '');
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
    const foreign = isForeign(teamId);
    const history = kbHistory(teamId);
    state.kbBusy = true;
    $('kbText').value = '';
    autoGrow($('kbText'));

    history.push({ id: uid(), role: 'user', text: q, date: Date.now() });
    if (teamId === state.currentTeamId) {
      appendKbMessage(history[history.length - 1]);
    }

    const answerMsg = {
      id: uid(),
      role: 'assistant',
      text: '',
      sources: [],
      reduced: foreign,
      streaming: true,
      date: Date.now()
    };
    history.push(answerMsg);
    let node =
      teamId === state.currentTeamId ? appendKbMessage(answerMsg) : null;

    try {
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
      const own = team.id === state.userTeamId;
      return (
        '<option value="' + team.id + '">' +
        team.icon + ' ' + escapeHtml(team.nombre) +
        (own ? ' — tu equipo' : '') +
        '</option>'
      );
    }).join('');
    select.value = state.currentTeamId;
    select.addEventListener('change', function () {
      switchTeam(select.value);
    });
  }

  /** Aplica cabeceras, avisos y textos contextuales del equipo activo. */
  function applyTeamContext() {
    const team = teamById(state.currentTeamId);
    const foreign = isForeign(state.currentTeamId);

    $('chatGroupEmail').textContent = team.grupo;
    $('kbPath').textContent = '📁 ' + KB_BASE_PATH + '/' + team.kbFolder;
    $('kbDocs').textContent = foreign
      ? '📄 ' + reducedDocs(team) + ' de ' + team.kbDocs + ' docs (reducida)'
      : '📄 ' + team.kbDocs + ' docs indexados';
    $('chatText').placeholder =
      'Mensaje a ' + team.grupo + '…  (Enter para enviar)';
    $('kbText').placeholder =
      'Pregunta a la KB de ' + team.corto + '…  (Enter para enviar)';
    $('filtTeam').textContent = team.icon + ' De ' + team.corto;

    // Avisos al estar en el espacio de OTRO equipo.
    $('chatWarn').hidden = !foreign;
    $('kbWarn').hidden = !foreign;
  }

  /** Cambia el equipo activo y repinta chat, KB y formaciones. */
  function switchTeam(teamId) {
    if (teamId === state.currentTeamId) return;
    state.currentTeamId = teamId;
    const team = teamById(teamId);

    applyTeamContext();
    setTyping(null);
    $('syncText').textContent = 'Sincronizando…';
    state.messages = [];
    renderChat();
    setFormFilter(state.formFilter); // re-aplica el filtro con el nuevo equipo
    renderKbAll();
    renderKbSuggestions();

    refreshChat().then(function () {
      const list = $('chatList');
      list.scrollTop = list.scrollHeight;
    });
    toast(
      team.icon + ' ' + team.nombre +
      (isForeign(teamId) ? ' (equipo ajeno)' : ' — tu equipo')
    );
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

  async function init() {
    if (MOCK_MODE) {
      $('badgeDemo').textContent =
        'MODO DEMO' + (CONFIG.version ? ' · v' + CONFIG.version : '');
      $('badgeDemo').hidden = false;
      $('demoBanner').hidden = false;
    }
    $('userLine').textContent = 'Identificando usuario…';

    // 1) El backend indica el equipo de la usuaria (hoja "Usuarios").
    try {
      const info = await api('getUserInfo');
      state.userTeamId = (info && info.team) || TEAMS[0].id;
    } catch (err) {
      state.userTeamId = TEAMS[0].id;
    }
    state.currentTeamId = state.userTeamId;
    const myTeam = teamById(state.userTeamId);

    // 2) Cabecera con identidad + equipo propio.
    $('userLine').textContent =
      USER.name + ' · ' + USER.email + '  —  ' +
      myTeam.icon + ' ' + myTeam.nombre;
    const avatar = $('userAvatar');
    avatar.textContent = initials(USER.name);
    avatar.title = USER.name + ' (' + USER.email + ') · ' + myTeam.nombre;

    initTeamSelect();
    initTabs();
    applyTeamContext();
    setFormFilter('all');

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
    $('filtAll').addEventListener('click', function () {
      setFormFilter('all');
    });
    $('filtTeam').addEventListener('click', function () {
      setFormFilter('team');
    });

    // Carga inicial + polling del chat.
    refreshChat().then(function () {
      const list = $('chatList');
      list.scrollTop = list.scrollHeight;
    });
    refreshFormaciones();
    setInterval(refreshChat, POLL_INTERVAL_MS);
  }

  document.addEventListener('DOMContentLoaded', function () {
    init();
  });
})();
