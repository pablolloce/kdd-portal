/* ════════════════════════════════════════════════════════════════════════
   KDD Portal · Área de Tesorería — lógica del webview (JS vanilla)

   NAVEGACIÓN
     - Pantalla «menú»: pestañas Equipos (tarjetas) y Calendario de
       formaciones (mes completo del área, todas las formaciones).
     - Pantalla «equipo»: ← Menú, Knowledge Base (primera pestaña), Chat
       del equipo (segunda, protegida por un aviso modal para fomentar el
       uso previo de la KB) y las formaciones SOLO de ese equipo.

   MODO MOCK: mientras MOCK_MODE sea true, todas las llamadas a la "API"
   se resuelven contra un backend simulado en memoria (MockBackend).
   Nada sale de este webview.

   MODO REAL: al poner MOCK_MODE = false…
    - chat/formaciones/usuario → fetch a la Web App de Google Apps Script
      (APPS_SCRIPT_URL, ver backend/backend.gs). La acción getUserInfo
      devuelve el EQUIPO del usuario (hoja "Usuarios").
    - Knowledge Base → Language Model API de VS Code (Copilot) con los
      documentos de KB_BASE_PATH/<equipo> como contexto.
   ════════════════════════════════════════════════════════════════════════ */

/* global acquireVsCodeApi */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────── Configuración ──

  const CONFIG = window.__TEAM_HUB_CONFIG__ || {};

  /**
   * true → backend simulado; false → fetch real a Apps Script.
   * Viene del ajuste kddPortal.modoMock (inyectado por la extensión).
   */
  const MOCK_MODE = CONFIG.mockMode !== false;

  /** URL /exec del despliegue Web App (ajuste kddPortal.appsScriptUrl). */
  const APPS_SCRIPT_URL = String(CONFIG.appsScriptUrl || '').trim();

  /** Token compartido opcional (ajuste kddPortal.tokenAcceso). */
  const ACCESS_TOKEN = String(CONFIG.token || '').trim();

  /**
   * Ruta local base del repositorio de conocimiento (modo real).
   * Cada equipo tiene su carpeta: KB_BASE_PATH/<carpeta-del-equipo>.
   */
  const KB_BASE_PATH = './kb';

  /**
   * Intervalo de polling del chat (ms). En real es más lento a propósito:
   * GmailApp.search tiene cuota diaria y el backend cachea 15 s.
   */
  const POLL_INTERVAL_MS = MOCK_MODE ? 3000 : 20000;

  const vscode =
    typeof acquireVsCodeApi === 'function'
      ? acquireVsCodeApi()
      : { postMessage: function () {} };

  const USER = CONFIG.user || { name: 'Usuario demo', email: 'demo@banco.demo' };

  /**
   * Sesión real del login (backend/auth.gs, action=auth): { token, email }
   * o null mientras no se ha conectado. La inyecta la extensión si ya
   * había una guardada (context.secrets); se actualiza en vivo al recibir
   * el mensaje 'loginOk' (ver wireLogin). Aquí en el webview solo se usa
   * para la UI del botón «Conectar» — la extensión guarda por su cuenta
   * el sessionToken y el token OAuth compartido, y es quien de verdad
   * llama a Apps Script (ver apiReal más abajo).
   */
  let sesion = CONFIG.sesion || null;

  /** Peticiones 'apiCall' pendientes de respuesta de la extensión. */
  let apiReqSeq = 0;
  const apiPending = {};

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

  /**
   * Mini-markdown seguro: **negrita**, `código`, listas "- ", saltos y
   * enlaces [texto](destino). El destino solo puede ser http(s) o una ruta
   * de documento .md/.txt de la KB (nada de javascript: u otros esquemas);
   * se renderiza como <a data-href> y el clic lo resuelve la extensión
   * (documento local de la KB → editor de VS Code; URL → navegador).
   */
  function mdLite(text) {
    let html = escapeHtml(text);
    html = html.replace(
      /\[([^\]]{1,150})\]\((https?:[^\s()<>]{1,600}|[^\s()<>:]{1,300}\.(?:md|txt))\)/gi,
      '<a class="kb-doclink" data-href="$2">$1</a>'
    );
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

  /** Date → "dd/mm/aaaa" (formato español del formulario de formaciones). */
  function fechaES(date) {
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return d + '/' + m + '/' + date.getFullYear();
  }

  /**
   * "dd/mm/aaaa" → Date (a las 00:00 locales), o null si no es una fecha
   * válida de verdad (rechaza 31/02/2026 y similares).
   */
  function parseFechaES(text) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(text || '').trim());
    if (!m) return null;
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    const anio = Number(m[3]);
    const fecha = new Date(anio, mes - 1, dia);
    if (
      fecha.getFullYear() !== anio ||
      fecha.getMonth() !== mes - 1 ||
      fecha.getDate() !== dia
    ) {
      return null;
    }
    return fecha;
  }

  function rand(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  let idCounter = 0;
  function uid() {
    idCounter += 1;
    return 'id-' + Date.now().toString(36) + '-' + idCounter;
  }

  /** Bloque centrado de carga (spinner + texto) para listas y tablas. */
  function htmlCargando(texto) {
    return (
      '<div class="loading-block"><span class="spinner"></span>' +
      escapeHtml(texto) + '</div>'
    );
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

  /**
   * Iniciales a partir del email corporativo: primera letra + primera
   * letra tras el primer punto de la parte local
   * («pablo.llorentec.contractor@…» → «PL»). Sin punto, cae a las
   * iniciales del nombre visible.
   */
  function inicialesDeEmail(email, nombreFallback) {
    const local = String(email || '').split('@')[0];
    const partes = local.split('.').filter(Boolean);
    if (partes.length >= 2) {
      return (partes[0][0] + partes[1][0]).toUpperCase();
    }
    if (partes.length === 1 && partes[0]) {
      return partes[0][0].toUpperCase();
    }
    return initials(nombreFallback || '');
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

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
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

  /** Clave de día local AAAA-MM-DD (para el calendario). */
  function isoDay(date) {
    const d = new Date(date);
    return (
      d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }

  // ══════════════════════════════════════ EQUIPOS DEL ÁREA DE TESORERÍA ═══

  const MOCK_TEAMS = [
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

  /**
   * Equipos activos. En mock son los MOCK_TEAMS de arriba; en modo real se
   * cargan de la hoja Config del backend (action=getTeams) durante init(),
   * de modo que añadir un equipo = añadir una fila en la hoja.
   */
  let TEAMS = MOCK_MODE ? MOCK_TEAMS : [];

  function teamById(id) {
    return TEAMS.find(function (t) { return t.id === id; }) || TEAMS[0];
  }

  /** Clase de color por índice de equipo (tc-c0…tc-c4, cíclica). */
  function teamColorClass(teamId) {
    const idx = TEAMS.findIndex(function (t) { return t.id === teamId; });
    return 'tc-c' + ((idx >= 0 ? idx : 0) % 5);
  }

  /** Nº de documentos visibles en la versión reducida de una KB ajena. */
  function reducedDocs(team) {
    if (!team.kbDocs) return null;
    return Math.max(3, Math.round(team.kbDocs / 3));
  }

  const DEFAULT_TEAM_ICONS = ['🏦', '📈', '⚙️', '🧩', '📊', '🗄️', '🔐', '🛠️'];
  const KB_SUGGESTIONS_GENERICAS = [
    '¿Qué documentación hay disponible?',
    '¿Cómo se despliega a producción?',
    '¿Dónde está el runbook de incidencias?'
  ];

  /** Convierte una fila de la hoja Config en un equipo para la UI. */
  function buildRealTeam(row, index) {
    const nombre = row.nombre || row.teamId;
    return {
      id: row.teamId,
      nombre: nombre,
      corto: nombre.split('(')[0].trim().split(/\s+/).slice(0, 2).join(' '),
      icon: row.icono || DEFAULT_TEAM_ICONS[index % DEFAULT_TEAM_ICONS.length],
      grupo: row.grupo || '',
      kbFolder: row.teamId,
      kbDriveId: row.kbFolder || '',
      kbDocs: null,
      hasKb: Boolean(row.hasKb),
      miembros: row.miembros || 0,
      members: [],
      kbSuggestions: KB_SUGGESTIONS_GENERICAS,
      kb: null,
      kbFallbackSources: []
    };
  }

  /** Modo real: carga los equipos desde la hoja Config del backend. */
  async function loadTeams() {
    const data = await api('getTeams');
    if (!data || !data.ok) {
      const err = new Error((data && data.error) || 'getTeams no respondió');
      // Marca de la extensión: la llamada rebotó por sesión caducada.
      err.authExpired = Boolean(data && data.authExpired);
      throw err;
    }
    TEAMS = (data.teams || []).map(buildRealTeam);
    if (!TEAMS.length) {
      throw new Error('La hoja Config no tiene equipos dados de alta');
    }
  }

  // ═══════════════════════════════════════════════════════ MOCK BACKEND ═══

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
    MOCK_TEAMS.forEach(function (team) {
      chatStores[team.id] = createChatStore(team);
    });

    /** Formaciones GLOBALES del área (columna "Equipo" en el backend real). */
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

    /**
     * Imputaciones del informe TRA (réplica del Looker Studio del área).
     * En real: Google Sheets «Informe TRA Portal» (hoja PORTAL, se
     * actualiza a diario) leído por Apps Script (action=getTra).
     *
     * Cada fila: [nombre, equipo, sdatool, featureJira, descripcion, minutos]
     * (el tiempo viene en MINUTOS, igual que la hoja real; la UI lo pasa a
     * horas). Los equipos y personas de este informe NO son los del portal:
     * es información complementaria y no todo el área aparece aquí.
     */
    const TRA_ROWS = [
      ['MARIO CANO LOSADA', 'FO-Murex', 'SDATOOL-34546', 'CIBMUREX3-9788', 'Desarrollos Estructuras Subfase 2 - Murex Trading', 14040],
      ['ANA BELÉN RUIZ MOLINA', 'FO-Murex', 'SDATOOL-34546', 'CIBMUREX3-9274', 'Desarrollos Estructuras Subfase 2 - Murex Reporting', 10380],
      ['COSME DELGADO PRIETO', 'FO-Murex', 'SDATOOL-34546', 'CIBMUREX3-138', '[SDA_34546] Murex batch Calypso OTC Fase 4 [Mx-Reporting]', 8220],
      ['NOELIA PARDO GIL', 'STAR', 'SDATOOL-34546', 'CIBSTAR-560', '[SDATOOL-34546 MMF: 2301724] Restricción de envío a Abaco: Filtro de estructuras Calypso', 6480],
      ['DANIEL ORTS PLA', 'MSC', 'SDATOOL-34546', 'CIBMARKETM-1659', '[SDATOOL_34546/1081305] MSC - Fase IV - Migración productos IRS y CCIRS', 5940],
      ['PEDRO ALARCÓN NIETO', 'Calypso', 'SDATOOL-49699', 'CIBCALYPS1-3781', 'Calypso OTC Fase V - Assessment Payoffs Multitrigger', 16920],
      ['SILVIA MORA GALLEGO', 'Calypso', 'SDATOOL-49699', 'CIBCALYPS1-3900', 'Upgrade Calypso 18 - regresión de módulos OTC', 12540],
      ['MARIO CANO LOSADA', 'FO-Murex', 'SDATOOL-49699', 'CIBCALYPS1-3781', 'Calypso OTC Fase V - Assessment Payoffs Multitrigger', 4980],
      ['TERESA LLANOS VEGA', 'Transaction_Reporting', 'SDATOOL-34723', 'CIBTRADEREP-421', 'Transaction Reporting EMIR Refit - ajustes de esquema', 12360],
      ['IVÁN CASTRO REY', 'Transaction_Reporting', 'SDATOOL-34723', 'CIBTRADEREP-577', 'RTS 22 - incorporación de campos nuevos', 9420],
      ['ÁLVARO CID BLANCO', 'FRTB-RFR', 'SDATOOL-51125', 'CIBFRTB-118', 'Motor FRTB-RFR: construcción de curvas libres de riesgo', 11640],
      ['ROCÍO MARÍN SOTO', 'FRTB-RFR', 'SDATOOL-51125', 'CIBFRTB-201', 'FRTB SA - agregación de sensibilidades por bucket', 7080],
      ['LAURA VILA ARNAIZ', 'FO-Murex', 'SDATOOL-30916', 'CIBFRONT2B-4766', 'Eventos en 4Sight para optimización de interfaces', 9660],
      ['GONZALO URBINA SANZ', 'DUCO', 'SDATOOL-55415', 'CIBDUCO-543', 'SDATOOL-55415/MMF 2167498 ALCON PnL Cambio del dataplatform', 11160],
      ['JORGE ABAD LUNA', 'RDR', 'SDATOOL-42831', 'CIBGLOBALD-3085', 'DMT PAWIF Q2 Back', 8760],
      ['JORGE ABAD LUNA', 'RDR', 'SDATOOL-42831', 'CIBGLOBALD-3084', 'DMT PAWIF Q2 Front', 3540],
      ['CARMEN SOLÍS VERA', 'TS', 'SDATOOL-49874', 'CIBMONITOR-35', '[SDATOOL-49874 MMF: 2299964] - Migración NOVA - Servicio Mifid', 13560],
      ['NOELIA PARDO GIL', 'STAR', 'SDATOOL-52547', 'CIBSTAR-712', 'STAR - conciliación intradía de operaciones', 10920],
      ['ELSA GARCÍA COBO', 'Integraciones ESB', 'SDATOOL-52547', 'CIBESB-1204', 'Integración ESB - colas de eventos STAR', 6360],
      ['SILVIA MORA GALLEGO', 'Calypso', 'SDATOOL-45247', 'CIBMUREX3-12194', '[Murex RISK] - CMT Callable - Análisis de requerimientos', 5220],
      ['TERESA LLANOS VEGA', 'Transaction_Reporting', 'SDATOOL-49629', 'CIBTRADEREP-610', 'Reporting MiFIR - reconciliación con front', 4680],
      ['ÁLVARO CID BLANCO', 'FRTB-RFR', 'SDATOOL-49629', 'CIBFRTB-233', 'Backtesting FRTB - informes de excepciones', 3120],
      ['ELSA GARCÍA COBO', 'Integraciones ESB', '', '', 'Soporte usuarios', 7440],
      ['CARMEN SOLÍS VERA', 'TS', '', '', 'Soporte usuarios', 4980],
      ['COSME DELGADO PRIETO', 'FO-Murex', '', '', 'Soporte usuarios', 3900],
      ['GONZALO URBINA SANZ', 'DUCO', '', '', 'Soporte usuarios', 2340],
      ['IVÁN CASTRO REY', 'Transaction_Reporting', 'SDATOOL-55569', 'CIBTRADEREP-702', 'Refit fase II - validaciones de contrapartida', 6900],
      ['ROCÍO MARÍN SOTO', 'FRTB-RFR', 'SDATOOL-55569', 'CIBFRTB-260', 'Curvas RFR - calibración con datos de mercado', 4740],
      ['LAURA VILA ARNAIZ', 'FO-Murex', 'SDATOOL-55569', 'CIBMUREX3-12630', 'Mx - adaptación de interfaces a curvas RFR', 5160],
      ['ANA BELÉN RUIZ MOLINA', 'FO-Murex', 'SDATOOL-45247', 'CIBMUREX3-12201', '[Murex RISK] - CMT Callable - desarrollo de pricers', 4380],
      ['PEDRO ALARCÓN NIETO', 'Calypso', 'SDATOOL-52547', 'CIBCALYPS1-4012', 'Calypso - alimentación de la conciliación STAR', 3960],
      ['DANIEL ORTS PLA', 'MSC', 'SDATOOL-49874', 'CIBMONITOR-41', 'Migración NOVA - monitorización de servicios', 4500]
    ];

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
      },

      getTra: function () {
        return {
          ok: true,
          rows: TRA_ROWS.map(function (row) { return row.slice(); })
        };
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
    // Fallback seguro: durante la carga inicial en modo real, TEAMS aún
    // está vacío (se rellena con getTeams) y userTeamId todavía no se ha
    // resuelto. Las acciones que se llaman en ese momento (getTeams,
    // getUserInfo) no usan teamId, así que '' es inofensivo.
    const teamId =
      state.currentTeamId || state.userTeamId || (TEAMS[0] && TEAMS[0].id) || '';

    // La KB responde SIEMPRE en local: el hito Copilot (vscode.lm con la
    // KB sincronizada de Drive) está pendiente y el backend GAS no tiene
    // acción kbAsk. Así el modo real no rompe la pestaña KB.
    if (action === 'kbAsk') {
      await delay(rand(400, 900));
      return MockBackend.kbAsk(teamId, payload);
    }

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
          // La formación se crea a nombre del equipo indicado en el payload
          // (el equipo de la usuaria cuando se crea desde el calendario).
          return MockBackend.createFormacion(payload.team || teamId, payload);
        case 'rsvp':
          return MockBackend.rsvp(payload);
        case 'getTra':
          return MockBackend.getTra();
        default:
          return { ok: false, error: 'Acción desconocida: ' + action };
      }
    }

    // ── Modo real (Google Apps Script) ──
    if (!APPS_SCRIPT_URL) {
      return {
        ok: false,
        error: 'Falta configurar el ajuste kddPortal.appsScriptUrl'
      };
    }
    // La llamada de verdad la hace la extensión (Node.js, sin CORS): así
    // puede mandar el token compartido como Authorization: Bearer, algo
    // que el navegador del webview bloquearía con preflight (Apps Script
    // no lo soporta). El webview solo pide la acción; la extensión añade
    // sessionToken/tokenAcceso/el Bearer por su cuenta (ver
    // callBackendReal en extension.ts).
    return apiReal(action, teamId, payload);
  }

  /** Pide a la extensión que llame a Apps Script y espera 'apiResult'. */
  function apiReal(action, teamId, payload) {
    return new Promise(function (resolve) {
      const reqId = 'api' + (++apiReqSeq);
      apiPending[reqId] = resolve;
      vscode.postMessage({
        type: 'apiCall',
        reqId: reqId,
        action: action,
        team: teamId,
        email: USER.email,
        name: USER.name,
        payload: payload || null
      });
    });
  }

  // ─────────────────────────────────────────────────────── Estado de la UI ──

  const state = {
    /**
     * true en cuanto init() supera loadTeams() y engancha los listeners
     * (sección "3) Menú inicial" en adelante). Si sigue en false tras un
     * intento de login, es seguro volver a llamar a init(): la primera
     * vez no llegó a enganchar nada (permite reintentar sin duplicar
     * listeners; ver wireLogin/loginOk más abajo).
     */
    initOk: false,
    /** Equipo al que pertenece la usuaria (lo indica el backend). */
    userTeamId: null,
    /** Equipo abierto (null mientras se está en el menú). */
    currentTeamId: null,
    /** 'home' | 'team' */
    screen: 'home',
    /** Pestaña del menú: 'teams' | 'calendar' | 'dir'. */
    homeTab: 'teams',
    /** Filas del informe TRA (se cargan con getTra). */
    tra: null,
    /** true una vez pobladas las listas de los filtros. */
    traFiltersReady: false,
    dirQuery: '',
    traFilters: { nombre: '', equipo: '', sda: '', jira: '' },
    /** Pestaña dentro del equipo: 'kb' | 'chat'. */
    teamTab: 'kb',
    /** teamId → true una vez aceptado el aviso del chat. */
    chatUnlocked: {},
    /** Error de la última carga del informe TRA ('' = sin error). */
    traError: '',
    /** Secuencia y peticiones pendientes del puente KB↔Copilot. */
    kbReqSeq: 0,
    kbPending: {},
    /** teamId → nº de docs tras la última sincronización de su KB. */
    kbSynced: {},
    /** Mes visible del calendario (Date del día 1). */
    calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    /** Día seleccionado del calendario (AAAA-MM-DD). */
    calSelected: isoDay(new Date()),
    messages: [],
    formaciones: [],
    /** true tras la primera carga de formaciones (para mostrar carga). */
    formacionesCargadas: false,
    sending: false,
    kbBusy: false,
    kbHistories: {}
  };

  function isForeign(teamId) {
    return state.userTeamId !== null && teamId !== state.userTeamId;
  }

  function kbHistory(teamId) {
    if (!state.kbHistories[teamId]) {
      const team = teamById(teamId);
      const foreign = isForeign(teamId);
      const text = !MOCK_MODE
        ? (foreign
            ? 'Estás consultando la KB de **' + team.nombre + '** (equipo ' +
              'ajeno): trátala como **versión reducida**, puede contener ' +
              'errores o información desactualizada.\n\n' +
              'Respondo con **Copilot** sobre los documentos sincronizados ' +
              'desde su Drive. Si no resuelvo tu duda, pregunta en su chat ' +
              '— con paciencia 🙂.'
            : '¡Hola! Respondo con **Copilot** sobre la Knowledge Base de ' +
              'tu equipo, **' + team.nombre + '**, sincronizada desde Drive ' +
              'a tu carpeta local.\n\n' +
              'Pregúntame lo que necesites: citaré las fuentes de cada respuesta.')
        : foreign
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

  let lastErrorToast = '';
  /** Muestra el error real del backend (dedupe del último mostrado). */
  function toastError(prefix, error) {
    const texto = '⚠️ ' + prefix + ': ' + String(error || 'error desconocido');
    if (texto === lastErrorToast) return;
    lastErrorToast = texto;
    toast(texto.slice(0, 180));
  }

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

  // ═══════════════════════════════════════════ MENÚ: TARJETAS DE EQUIPO ═══

  function renderTeamsGrid() {
    const grid = $('teamsGrid');
    let html = '';

    TEAMS.forEach(function (team) {
      const own = team.id === state.userTeamId;
      const proximas = state.formaciones.filter(function (f) {
        return f.teamId === team.id;
      }).length;

      html += '<button class="team-card ' + teamColorClass(team.id) +
        '" type="button" data-id="' + team.id + '">';
      html += '<span class="team-card-head">';
      html += '<span class="team-card-icon">' + team.icon + '</span>';
      if (own) {
        html += '<span class="team-badge own">Tu equipo</span>';
      }
      html += '</span>';
      html += '<span class="team-card-name">' + escapeHtml(team.nombre) + '</span>';
      html += '<span class="team-card-group">' + escapeHtml(team.grupo) + '</span>';
      html += '<span class="team-card-stats">';
      html += '<span>👥 ' + (team.members.length || team.miembros || 0) + '</span>';
      html += '<span>🎓 ' + proximas + ' próxima' + (proximas === 1 ? '' : 's') + '</span>';
      if (MOCK_MODE) {
        html += own
          ? '<span>📄 ' + team.kbDocs + ' docs</span>'
          : '<span class="warn-text">📄 ' + reducedDocs(team) + '/' + team.kbDocs + ' (reducida)</span>';
      } else {
        html += team.hasKb
          ? (own
              ? '<span>📄 KB en Drive</span>'
              : '<span class="warn-text">📄 KB (reducida)</span>')
          : '<span class="warn-text">📄 sin KB</span>';
      }
      html += '</span>';
      html += '<span class="team-card-cta">Entrar →</span>';
      html += '</button>';
    });

    grid.innerHTML = html;
    grid.querySelectorAll('.team-card').forEach(function (card) {
      card.addEventListener('click', function () {
        enterTeam(card.getAttribute('data-id'));
      });
    });
  }

  // ═══════════════════════════════════ MENÚ: CALENDARIO DE FORMACIONES ═══

  /** Índice { 'AAAA-MM-DD': [formaciones…] } del estado actual. */
  function formacionesByDay() {
    const index = {};
    state.formaciones.forEach(function (f) {
      const key = isoDay(f.fecha);
      (index[key] = index[key] || []).push(f);
    });
    return index;
  }

  function renderCalendar() {
    const month = state.calMonth;
    $('calTitle').textContent = capitalize(
      month.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })
    );

    const byDay = formacionesByDay();
    const todayKey = isoDay(new Date());

    // Lunes anterior (o igual) al día 1 del mes.
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7;
    first.setDate(first.getDate() - offset);

    let html = '';
    for (let i = 0; i < 42; i++) {
      const day = new Date(first);
      day.setDate(first.getDate() + i);
      const key = isoDay(day);
      const inMonth = day.getMonth() === month.getMonth();
      const items = byDay[key] || [];

      const classes = [
        'cal-cell',
        inMonth ? '' : 'other-month',
        key === todayKey ? 'today' : '',
        key === state.calSelected ? 'selected' : ''
      ].join(' ');

      html += '<button class="' + classes + '" type="button" data-date="' + key + '">';
      html += '<span class="cal-daynum">' + day.getDate() + '</span>';
      items.slice(0, 2).forEach(function (f) {
        html +=
          '<span class="cal-chip"><i class="tdot ' + teamColorClass(f.teamId) +
          '"></i><span class="cal-chip-text">' + escapeHtml(f.titulo) + '</span></span>';
      });
      if (items.length > 2) {
        html += '<span class="cal-more">+' + (items.length - 2) + ' más</span>';
      }
      html += '</button>';
    }

    $('calGrid').innerHTML = html;
    $('calGrid').querySelectorAll('.cal-cell').forEach(function (cell) {
      cell.addEventListener('click', function () {
        state.calSelected = cell.getAttribute('data-date');
        renderCalendar();
        renderCalDetail();
      });
    });
  }

  /** Tarjeta de formación (reutilizada en calendario y pantalla de equipo). */
  function formacionCardHtml(f, showTeam) {
    const team = teamById(f.teamId);
    const d = new Date(f.fecha);
    const day = d.getDate();
    const month = d.toLocaleDateString('es-ES', { month: 'short' }).replace('.', '');
    const hora = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

    let html = '<article class="card" data-id="' + f.id + '">';
    html +=
      '<div class="date-block"><span class="day">' + day +
      '</span><span class="month">' + escapeHtml(month) + '</span></div>';
    html += '<div class="card-body">';
    html += '<h3 class="card-title">' + escapeHtml(f.titulo) + '</h3>';
    if (f.descripcion) {
      html += '<p class="card-desc">' + escapeHtml(f.descripcion) + '</p>';
    }
    html += '<div class="card-meta">';
    if (showTeam) {
      html +=
        '<span class="pill team"><i class="tdot ' + teamColorClass(f.teamId) +
        '"></i>' + team.icon + ' ' + escapeHtml(team.corto) + '</span>';
    }
    html += '<span>🕐 ' + hora + '</span>';
    html += '<span>👤 ' + escapeHtml(f.creador) + '</span>';
    html +=
      '<span class="pill">👥 ' + f.asistentes +
      (f.asistentes === 1 ? ' asistente' : ' asistentes') + '</span>';
    html += '</div>';
    html += '<div class="card-actions">';
    if (f.apuntado) {
      html += '<button class="btn joined" type="button" disabled>✓ Apuntado</button>';
    } else {
      html +=
        '<button class="btn primary btn-rsvp" type="button" data-id="' +
        f.id + '">Apuntarse</button>';
    }
    html += '</div></div></article>';
    return html;
  }

  function attachRsvpHandlers(container) {
    container.querySelectorAll('.btn-rsvp').forEach(function (btn) {
      btn.addEventListener('click', function () {
        onRsvp(btn.getAttribute('data-id'), btn);
      });
    });
  }

  function renderCalDetail() {
    const wrap = $('calDetail');
    const items = state.formaciones.filter(function (f) {
      return isoDay(f.fecha) === state.calSelected;
    });

    const selectedDate = new Date(state.calSelected + 'T12:00:00');
    const heading = capitalize(
      selectedDate.toLocaleDateString('es-ES', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      })
    );

    let html = '<h3 class="cal-detail-title">' + escapeHtml(heading) + '</h3>';

    // Aún sin datos: carga, no un «no hay formaciones» prematuro.
    if (!state.formacionesCargadas && !state.formaciones.length) {
      wrap.innerHTML = html + htmlCargando('Cargando formaciones…');
      return;
    }

    if (items.length) {
      items.forEach(function (f) {
        html += formacionCardHtml(f, true);
      });
    } else {
      const upcoming = state.formaciones.slice(0, 3);
      html += '<p class="cal-empty">No hay formaciones este día.</p>';
      if (upcoming.length) {
        html += '<h4 class="cal-detail-sub">Próximas en el área</h4>';
        upcoming.forEach(function (f) {
          html += formacionCardHtml(f, true);
        });
      }
    }

    wrap.innerHTML = html;
    attachRsvpHandlers(wrap);
  }

  // ══════════════ MENÚ: PROYECTOS Y PERSONAS (informe TRA / Looker) ═══
  //  Réplica del Looker Studio de imputaciones: total de horas, donut de
  //  proyectos por tiempo, filtros (Nombre / Equipo / Proyecto SDA /
  //  Feature JIRA) y tablas de personas y proyectos, todo interconectado.
  //  Filas: [nombre, equipo, sdatool, featureJira, descripcion, minutos].

  const TRA = { NOMBRE: 0, EQUIPO: 1, SDA: 2, JIRA: 3, DESC: 4, MIN: 5 };

  async function loadTra() {
    try {
      const data = await api('getTra');
      if (data && data.ok) {
        state.tra = data.rows;
        state.traError = '';
      } else {
        state.traError = (data && data.error) || 'respuesta inválida del backend';
        toastError('Informe TRA', state.traError);
      }
    } catch (err) {
      state.traError = 'sin conexión con el backend';
      toastError('Informe TRA', state.traError);
    }
    if (state.screen === 'home' && state.homeTab === 'dir') {
      renderTra();
    }
  }

  /** Minutos → horas con formato es-ES (27.687,25). */
  function fmtHoras(minutos) {
    return (minutos / 60).toLocaleString('es-ES', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  /** Etiqueta del proyecto de una fila (SDATOOL o proyecto sin SDA). */
  function traSdaLabel(row) {
    return row[TRA.SDA] || row[TRA.DESC] || 'Sin proyecto';
  }

  function filteredTraRows() {
    const f = state.traFilters;
    const q = normalize(state.dirQuery);
    return state.tra.filter(function (row) {
      if (f.nombre && row[TRA.NOMBRE] !== f.nombre) return false;
      if (f.equipo && row[TRA.EQUIPO] !== f.equipo) return false;
      if (f.sda && traSdaLabel(row) !== f.sda) return false;
      if (f.jira && row[TRA.JIRA] !== f.jira) return false;
      if (!q) return true;
      return normalize(row.join(' ')).indexOf(q) !== -1;
    });
  }

  /** Rellena los desplegables de filtros con los valores del dataset. */
  function populateTraFilters() {
    if (state.traFiltersReady) return;
    state.traFiltersReady = true;

    function fill(id, values, todos) {
      const select = $(id);
      select.innerHTML =
        '<option value="">' + todos + '</option>' +
        values.map(function (v) {
          return '<option value="' + escapeHtml(v) + '">' +
            escapeHtml(v) + '</option>';
        }).join('');
    }

    function uniqueSorted(mapFn) {
      const set = {};
      state.tra.forEach(function (row) {
        const value = mapFn(row);
        if (value) set[value] = true;
      });
      return Object.keys(set).sort(function (a, b) {
        return a.localeCompare(b, 'es');
      });
    }

    fill('fNombre', uniqueSorted(function (r) { return r[TRA.NOMBRE]; }), 'Todos');
    fill('fEquipo', uniqueSorted(function (r) { return r[TRA.EQUIPO]; }), 'Todos');
    fill('fSda', uniqueSorted(traSdaLabel), 'Todos');
    fill('fJira', uniqueSorted(function (r) { return r[TRA.JIRA]; }), 'Todas');
  }

  function resetTraFilters() {
    state.traFilters = { nombre: '', equipo: '', sda: '', jira: '' };
    state.dirQuery = '';
    $('dirSearch').value = '';
    $('fNombre').value = '';
    $('fEquipo').value = '';
    $('fSda').value = '';
    $('fJira').value = '';
    renderTraResults();
  }

  /** Quita UN filtro (chip ✕) y sincroniza su selector. */
  function clearTraFilter(campo) {
    if (campo === 'q') {
      state.dirQuery = '';
      $('dirSearch').value = '';
    } else {
      state.traFilters[campo] = '';
      const selectDe = { nombre: 'fNombre', equipo: 'fEquipo', sda: 'fSda', jira: 'fJira' };
      $(selectDe[campo]).value = '';
    }
    renderTraResults();
  }

  /**
   * Chips de filtros activos (estilo Looker/Power BI): uno por filtro con
   * su ✕, más «Quitar todos». Siempre a la vista cuando hay algo filtrado
   * — se ve QUÉ está filtrado y se limpia con un clic.
   */
  function renderTraChips() {
    const box = $('traChips');
    const chips = [];
    [
      { campo: 'nombre', icon: '👤' },
      { campo: 'equipo', icon: '🏦' },
      { campo: 'sda', icon: '📁' },
      { campo: 'jira', icon: '🎫' }
    ].forEach(function (def) {
      if (state.traFilters[def.campo]) {
        chips.push({ campo: def.campo, icon: def.icon, texto: state.traFilters[def.campo] });
      }
    });
    if (state.dirQuery) {
      chips.push({ campo: 'q', icon: '🔎', texto: '«' + state.dirQuery + '»' });
    }

    if (!chips.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML =
      chips.map(function (c) {
        return (
          '<button class="tra-chip" type="button" data-campo="' + c.campo + '" ' +
          'title="Quitar este filtro">' + c.icon + ' ' + escapeHtml(c.texto) +
          '<span class="tra-chip-x">✕</span></button>'
        );
      }).join('') +
      (chips.length > 1
        ? '<button class="tra-chip tra-chip-reset" type="button" data-campo="*">' +
          '✕ Quitar todos</button>'
        : '');
    box.querySelectorAll('.tra-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        const campo = chip.getAttribute('data-campo');
        if (campo === '*') {
          resetTraFilters();
        } else {
          clearTraFilter(campo);
        }
      });
    });
  }

  /** Colores del donut (variables del tema, con fallback). */
  function traChartColors() {
    const styles = getComputedStyle(document.documentElement);
    function v(name, fallback) {
      return (styles.getPropertyValue(name) || '').trim() || fallback;
    }
    return [
      v('--vscode-charts-blue', '#3794ff'),
      v('--vscode-charts-purple', '#b180d7'),
      v('--vscode-charts-green', '#89d185'),
      v('--vscode-charts-orange', '#d18616'),
      v('--vscode-descriptionForeground', '#9d9d9d')
    ];
  }

  /** Donut «proyectos imputados por tiempo»: top 4 SDATOOL + Otros. */
  function renderTraChart(rows, totalMin) {
    const porSda = {};
    rows.forEach(function (row) {
      const key = traSdaLabel(row);
      porSda[key] = (porSda[key] || 0) + row[TRA.MIN];
    });
    const orden = Object.keys(porSda).sort(function (a, b) {
      return porSda[b] - porSda[a];
    });
    const top = orden.slice(0, 4).map(function (key) {
      return { label: key, min: porSda[key] };
    });
    const restoMin = orden.slice(4).reduce(function (acc, key) {
      return acc + porSda[key];
    }, 0);
    if (restoMin > 0) {
      top.push({ label: 'Otros', min: restoMin });
    }

    const canvas = $('traDonut');
    const ctx = canvas.getContext('2d');
    const colors = traChartColors();
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const radio = Math.min(cx, cy) - 4;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let angulo = -Math.PI / 2;
    top.forEach(function (parte, i) {
      const frac = totalMin ? parte.min / totalMin : 0;
      const fin = angulo + frac * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radio, angulo, fin);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      angulo = fin;
    });
    // Agujero del donut (recorte al color de fondo del panel).
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx, cy, radio * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    $('traLegend').innerHTML = top.map(function (parte, i) {
      const pct = totalMin
        ? ((100 * parte.min) / totalMin).toLocaleString('es-ES', {
            minimumFractionDigits: 1, maximumFractionDigits: 1
          })
        : '0';
      // «Otros» agrupa el resto: no es filtrable.
      const clicable = parte.label !== 'Otros';
      return (
        '<span class="tra-leg' + (clicable ? ' tra-leg-click' : '') + '"' +
        (clicable
          ? ' data-sda="' + escapeHtml(parte.label) + '" title="Filtrar por ' +
            escapeHtml(parte.label) + '"'
          : '') +
        '><i class="leg-c' + (i % 5) + '"></i>' +
        escapeHtml(parte.label) + ' · ' + pct + '%</span>'
      );
    }).join('');
    // Clic en la leyenda del donut → filtra por ese proyecto (toggle).
    $('traLegend').querySelectorAll('.tra-leg-click').forEach(function (leg) {
      leg.addEventListener('click', function () {
        const sda = leg.getAttribute('data-sda');
        state.traFilters.sda = state.traFilters.sda === sda ? '' : sda;
        $('fSda').value = state.traFilters.sda;
        renderTraResults();
      });
    });
  }

  /** Recalcula KPIs, donut y tablas con los filtros activos. */
  function renderTraResults() {
    const rows = filteredTraRows();
    const totalMin = rows.reduce(function (acc, row) {
      return acc + row[TRA.MIN];
    }, 0);

    // Agregado por persona.
    const porPersona = {};
    rows.forEach(function (row) {
      const key = row[TRA.NOMBRE];
      if (!porPersona[key]) {
        porPersona[key] = { nombre: key, equipo: row[TRA.EQUIPO], min: 0 };
      }
      porPersona[key].min += row[TRA.MIN];
    });
    const personas = Object.keys(porPersona).map(function (k) {
      return porPersona[k];
    }).sort(function (a, b) { return b.min - a.min; });

    // Agregado por proyecto (SDATOOL + feature).
    const porProyecto = {};
    rows.forEach(function (row) {
      const key = traSdaLabel(row) + '|' + row[TRA.JIRA];
      if (!porProyecto[key]) {
        porProyecto[key] = {
          sda: traSdaLabel(row),
          jira: row[TRA.JIRA],
          desc: row[TRA.DESC],
          min: 0
        };
      }
      porProyecto[key].min += row[TRA.MIN];
    });
    const proyectos = Object.keys(porProyecto).map(function (k) {
      return porProyecto[k];
    }).sort(function (a, b) { return b.min - a.min; });

    // KPIs.
    $('traTotal').textContent = fmtHoras(totalMin);
    $('traPersonas').textContent = '👥 ' + personas.length + ' personas';
    $('traProyectos').textContent = '📁 ' + proyectos.length + ' proyectos';
    $('cntPersonas').textContent = personas.length ? '(' + personas.length + ')' : '';
    $('cntProyectos').textContent = proyectos.length ? '(' + proyectos.length + ')' : '';

    renderTraChart(rows, totalMin);
    renderTraChips();

    // Tabla de personas (clic en fila → filtra por ese nombre; la fila
    // seleccionada queda resaltada y un segundo clic la deselecciona).
    const tbodyPersonas = $('tblPersonas').querySelector('tbody');
    tbodyPersonas.innerHTML = personas.length
      ? personas.map(function (p) {
          const activa = state.traFilters.nombre === p.nombre;
          return (
            '<tr data-nombre="' + escapeHtml(p.nombre) + '"' +
            (activa ? ' class="tra-active"' : '') + ' ' +
            'title="' + (activa ? 'Quitar el filtro' : 'Filtrar por ' + escapeHtml(p.nombre)) + '">' +
            '<td>' + escapeHtml(p.nombre) + '</td>' +
            '<td>' + escapeHtml(p.equipo) + '</td>' +
            '<td class="num">' + fmtHoras(p.min) + '</td></tr>'
          );
        }).join('')
      : '<tr><td colspan="3" class="tra-empty">Sin resultados</td></tr>';
    tbodyPersonas.querySelectorAll('tr[data-nombre]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        const nombre = tr.getAttribute('data-nombre');
        state.traFilters.nombre =
          state.traFilters.nombre === nombre ? '' : nombre;
        $('fNombre').value = state.traFilters.nombre;
        renderTraResults();
      });
    });

    // Tabla de proyectos (clic en fila → filtra por ese SDATOOL, con la
    // misma selección resaltada y toggle).
    const tbodyProyectos = $('tblProyectos').querySelector('tbody');
    tbodyProyectos.innerHTML = proyectos.length
      ? proyectos.map(function (p) {
          const activa = state.traFilters.sda === p.sda;
          return (
            '<tr data-sda="' + escapeHtml(p.sda) + '"' +
            (activa ? ' class="tra-active"' : '') + ' ' +
            'title="' + (activa ? 'Quitar el filtro' : 'Filtrar por ' + escapeHtml(p.sda)) + '">' +
            '<td class="mono">' + escapeHtml(p.sda) + '</td>' +
            '<td class="mono">' + escapeHtml(p.jira || '—') + '</td>' +
            '<td class="tra-desc">' + escapeHtml(p.desc) + '</td>' +
            '<td class="num">' + fmtHoras(p.min) + '</td></tr>'
          );
        }).join('')
      : '<tr><td colspan="4" class="tra-empty">Sin resultados</td></tr>';
    tbodyProyectos.querySelectorAll('tr[data-sda]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        const sda = tr.getAttribute('data-sda');
        state.traFilters.sda = state.traFilters.sda === sda ? '' : sda;
        $('fSda').value = state.traFilters.sda;
        renderTraResults();
      });
    });
  }

  function renderTra() {
    if (!state.tra) {
      if (state.traError) {
        $('traTotal').textContent = '—';
        $('traLegend').innerHTML = '';
        $('traPersonas').textContent = '';
        $('traProyectos').textContent = '';
        const aviso =
          '⚠️ ' + escapeHtml(state.traError) +
          ' — corrige y pulsa «Reestablecer filtros» para reintentar.';
        $('tblPersonas').querySelector('tbody').innerHTML =
          '<tr><td colspan="3" class="tra-empty">' + aviso + '</td></tr>';
        $('tblProyectos').querySelector('tbody').innerHTML =
          '<tr><td colspan="4" class="tra-empty">' + aviso + '</td></tr>';
        return;
      }
      $('traTotal').textContent = '…';
      $('tblPersonas').querySelector('tbody').innerHTML =
        '<tr><td colspan="3">' + htmlCargando('Cargando el informe TRA…') + '</td></tr>';
      $('tblProyectos').querySelector('tbody').innerHTML =
        '<tr><td colspan="4">' + htmlCargando('Cargando el informe TRA…') + '</td></tr>';
      loadTra();
      return;
    }
    populateTraFilters();
    renderTraResults();
  }

  // ══════════════════════════════════ EQUIPO: FORMACIONES DEL EQUIPO ═══

  function renderTeamFormaciones() {
    const wrap = $('cardsList');
    const team = teamById(state.currentTeamId);
    const items = state.formaciones.filter(function (f) {
      return f.teamId === state.currentTeamId;
    });

    // Aún sin datos: carga, no un «no hay formaciones» prematuro.
    if (!state.formacionesCargadas && !items.length) {
      wrap.innerHTML = htmlCargando('Cargando formaciones…');
      return;
    }

    if (!items.length) {
      wrap.innerHTML =
        '<div class="empty"><span class="empty-icon">🗓️</span>' +
        escapeHtml(team.corto) + ' no tiene formaciones próximas.<br>' +
        'Consulta el calendario del área desde el menú.</div>';
      return;
    }

    let html = '';
    items.forEach(function (f) {
      html += formacionCardHtml(f, false);
    });
    wrap.innerHTML = html;
    attachRsvpHandlers(wrap);
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

  // ─────────────────────────────────────────────── Render: Knowledge Base ──

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

    // ── Modo real: la extensión responde con Copilot sobre la KB local
    // sincronizada desde Drive; los trozos llegan por window message. ──
    if (!MOCK_MODE) {
      const reqId = 'kb-' + (++state.kbReqSeq);
      state.kbPending[reqId] = { answerMsg: answerMsg, node: node, teamId: teamId };
      vscode.postMessage({
        type: 'kbAsk',
        reqId: reqId,
        teamId: teamId,
        teamNombre: teamById(teamId).nombre,
        question: q,
        foreign: foreign
      });
      return;
    }

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
      // cambiado de equipo/pantalla y vuelto durante el streaming.
      if (state.currentTeamId === teamId && state.screen === 'team') {
        renderKbAll();
      }
    } catch (err) {
      answerMsg.streaming = false;
      answerMsg.text = '⚠️ No se pudo consultar la Knowledge Base.';
      if (state.currentTeamId === teamId && state.screen === 'team') {
        renderKbAll();
      }
    } finally {
      state.kbBusy = false;
      if (state.currentTeamId === teamId && state.screen === 'team') {
        $('kbText').focus();
      }
    }
  }

  /** Mensajes del puente KB↔Copilot que envía la extensión. */
  function onKbBridgeMessage(msg) {
    const p = state.kbPending[msg.reqId];
    if (!p) return;

    if (msg.type === 'kbChunk') {
      p.answerMsg.text += String(msg.text || '');
      if (p.node && p.node.isConnected) {
        p.node.querySelector('.kb-body').innerHTML =
          escapeHtml(p.answerMsg.text) + '<span class="caret"></span>';
        $('kbList').scrollTop = $('kbList').scrollHeight;
      }
      return;
    }

    delete state.kbPending[msg.reqId];
    p.answerMsg.streaming = false;
    if (msg.type === 'kbDone') {
      p.answerMsg.sources = msg.sources || [];
      if (msg.modelo) {
        $('kbEngine').innerHTML = '⚡ Copilot · ' + escapeHtml(msg.modelo);
      }
    } else {
      p.answerMsg.text =
        '⚠️ ' + String(msg.error || 'No se pudo consultar la KB con Copilot');
    }
    state.kbBusy = false;
    if (state.currentTeamId === p.teamId && state.screen === 'team') {
      renderKbAll();
      $('kbText').focus();
    }
  }

  /** Lanza la sincronización Drive→local de la KB de un equipo. */
  function kbSyncNow(teamId, silencioso) {
    vscode.postMessage({
      type: 'kbSync',
      reqId: 'sync-' + (++state.kbReqSeq),
      teamId: teamId
    });
    // El botón muestra la sincronización en curso (icono girando).
    const btn = $('btnKbSync');
    btn.disabled = true;
    btn.innerHTML = '<span class="icono-giro">⟳</span> Sincronizando…';
    if (!silencioso) toast('⟳ Sincronizando la KB desde Drive…');
  }

  /** Devuelve el botón de sincronizar a su estado normal. */
  function restaurarBotonKbSync() {
    const btn = $('btnKbSync');
    btn.disabled = false;
    btn.textContent = '⟳ Sincronizar';
  }

  function onKbSyncMessage(msg) {
    restaurarBotonKbSync();
    if (msg.type === 'kbSyncDone') {
      state.kbSynced[msg.teamId] = msg.docs;
      const team = teamById(msg.teamId);
      if (team) team.kbDocs = msg.docs;
      const visible =
        state.currentTeamId === msg.teamId && state.screen === 'team';

      // Carpeta de Drive sin documentos: se dice claramente en la propia
      // KB (no hay nada que consultar), en vez de un contador a 0 y un
      // error críptico de Copilot en la primera pregunta.
      if (!msg.docs) {
        if (visible) {
          $('kbDocs').textContent = '📄 sin documentos';
          $('kbDocs').title = msg.ruta || '';
          const hist = kbHistory(msg.teamId);
          hist.push({
            id: uid(),
            role: 'assistant',
            text:
              'ℹ️ Este equipo aún **no tiene Knowledge Base**: su carpeta de ' +
              'Drive no contiene ningún documento compatible (Google Docs, ' +
              '`.md` o `.txt`). Añade documentación a la carpeta del equipo ' +
              'y pulsa «⟳ Sincronizar».',
            sources: [],
            date: Date.now()
          });
          appendKbMessage(hist[hist.length - 1]);
        }
        toast('ℹ️ La carpeta de Drive de la KB está vacía');
        return;
      }

      if (visible) {
        $('kbDocs').textContent = '📄 ' + msg.docs + ' docs sincronizados';
        $('kbDocs').title = msg.ruta || '';
      }
      toast('✅ KB sincronizada: ' + msg.docs + ' documentos (' +
        (msg.bajados || 0) + ' nuevos o actualizados)');
    } else {
      toastError('Sincronización KB', msg.error);
    }
  }

  // ──────────────────────────────────────────────────────────── Acciones ──

  async function refreshChat() {
    if (state.screen !== 'team' || !state.currentTeamId) return;
    const teamId = state.currentTeamId;
    try {
      const data = await api('getChat');
      // Si la usuaria salió del equipo mientras llegaba la respuesta, se ignora.
      if (teamId !== state.currentTeamId || state.screen !== 'team') return;
      if (data && data.ok) {
        state.messages = data.messages;
        renderChat();
        setTyping(data.typing || null);
        $('syncText').textContent = 'Sincronizado · ' + fmtTime(Date.now());
      } else {
        $('syncText').textContent = 'Error';
        quitarCargaDelChat();
        toastError('Chat', data && data.error);
      }
    } catch (err) {
      if (teamId === state.currentTeamId) {
        $('syncText').textContent = 'Sin conexión';
        quitarCargaDelChat();
      }
    }
  }

  /** Si el chat sigue en «cargando» y la carga falló, lo dice en la lista. */
  function quitarCargaDelChat() {
    const list = $('chatList');
    if (list.querySelector('.loading-block')) {
      list.innerHTML =
        '<div class="loading-block">⚠️ No se pudo cargar el chat del grupo ' +
        '— se reintenta en el siguiente refresco.</div>';
    }
  }

  async function refreshFormaciones() {
    try {
      const data = await api('getFormaciones');
      if (data && data.ok) {
        state.formaciones = data.formaciones;
        state.formacionesCargadas = true;
        if (state.screen === 'team') {
          renderTeamFormaciones();
        } else {
          renderTeamsGrid();
          renderCalendar();
          renderCalDetail();
        }
      } else {
        toastError('Formaciones', data && data.error);
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
        if (state.screen === 'team') {
          renderTeamFormaciones();
          refreshChat();
        } else {
          renderCalendar();
          renderCalDetail();
        }
        toast('✅ Te has apuntado. Se añadirá al evento de Calendar (simulado).');
      } else {
        throw new Error((data && data.error) || 'Error');
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Apuntarse';
      toastError('Inscripción', err && err.message);
    }
  }

  async function onCreateFormacion(event) {
    event.preventDefault();

    const titulo = $('fTitulo').value.trim();
    const fechaTexto = $('fFecha').value;
    const hora = $('fHora').value || '10:00';
    const descripcion = $('fDesc').value.trim();

    if (!titulo || !fechaTexto) {
      toast('⚠️ El título y la fecha son obligatorios');
      return;
    }

    const fechaBase = parseFechaES(fechaTexto);
    if (!fechaBase) {
      toast('⚠️ Fecha no válida: usa el formato dd/mm/aaaa');
      return;
    }
    const partesHora = hora.split(':');
    const fechaCompleta = new Date(
      fechaBase.getFullYear(), fechaBase.getMonth(), fechaBase.getDate(),
      Number(partesHora[0]), Number(partesHora[1] || 0)
    );
    if (fechaCompleta.getTime() < Date.now() - 60000) {
      toast('⚠️ La fecha debe ser futura');
      return;
    }

    const btn = $('btnCrear');
    btn.disabled = true;
    btn.textContent = 'Creando…';

    try {
      const data = await api('createFormacion', {
        team: state.userTeamId,
        titulo: titulo,
        fecha: fechaCompleta.toISOString(),
        descripcion: descripcion
      });
      if (data && data.ok) {
        $('formNueva').reset();
        toggleFormNueva(false);
        // Salta el calendario al mes de la nueva formación.
        state.calMonth = new Date(
          fechaCompleta.getFullYear(), fechaCompleta.getMonth(), 1
        );
        state.calSelected = isoDay(fechaCompleta);
        await refreshFormaciones();
        // El backend avisa si la formación quedó SIN evento de calendario
        // (y de por qué): sin este aviso parecía un fallo silencioso.
        const aviso = data.formacion && data.formacion.aviso;
        if (aviso) {
          toast('🎓 Formación creada y notificada al grupo. ⚠️ ' + aviso);
        } else {
          toast(MOCK_MODE
            ? '🎓 Formación creada y notificada a tu equipo (simulado).'
            : '🎓 Formación creada: evento en el calendario y aviso al grupo.');
        }
        vscode.postMessage({
          type: 'notify',
          level: 'info',
          text: 'Formación «' + titulo + '» creada.' + (aviso ? ' ⚠️ ' + aviso : '')
        });
      } else {
        throw new Error((data && data.error) || 'Error');
      }
    } catch (err) {
      toastError('Crear formación', err && err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Crear y notificar al grupo';
    }
  }

  // ═══════════════════════════════════════════ NAVEGACIÓN ENTRE PANTALLAS ═══

  function showScreen(screen) {
    state.screen = screen;
    $('screenHome').hidden = screen !== 'home';
    $('screenTeam').hidden = screen !== 'team';
  }

  /** Entra en el espacio de un equipo (desde las tarjetas del menú). */
  function enterTeam(teamId) {
    state.currentTeamId = teamId;
    const team = teamById(teamId);
    const foreign = isForeign(teamId);

    // Barra del equipo.
    $('teamBarIcon').textContent = team.icon;
    $('teamBarName').textContent = team.nombre;
    $('teamBarGroup').textContent = team.grupo;
    const badge = $('teamBarBadge');
    badge.textContent = foreign ? 'Equipo ajeno' : 'Tu equipo';
    badge.className = 'team-badge ' + (foreign ? 'foreign' : 'own');

    // Avisos de espacio ajeno.
    $('chatWarn').hidden = !foreign;
    $('kbWarn').hidden = !foreign;

    // Contextos de KB y chat.
    if (MOCK_MODE) {
      $('kbPath').textContent = '📁 ' + KB_BASE_PATH + '/' + team.kbFolder;
      $('kbPath').classList.remove('kb-clickable');
      $('kbPath').title = '';
      $('kbDocs').textContent = foreign
        ? '📄 ' + reducedDocs(team) + ' de ' + team.kbDocs + ' docs (reducida)'
        : '📄 ' + team.kbDocs + ' docs indexados';
      $('kbEngine').innerHTML = '⚡ Copilot <em>(simulado)</em>';
      $('btnKbSync').hidden = true;
      $('btnKbDrive').hidden = true;
    } else {
      $('kbPath').textContent =
        '📁 ' + (CONFIG.rutaKb || 'almacén de la extensión') + '/' + team.id;
      $('kbPath').classList.add('kb-clickable');
      $('kbPath').title =
        'Abrir la carpeta local de la KB o cambiar su ubicación (ajuste kddPortal.rutaKb)';
      const sincronizados = state.kbSynced[team.id];
      $('kbDocs').textContent = sincronizados
        ? '📄 ' + sincronizados + ' docs sincronizados' +
          (foreign ? ' (reducida)' : '')
        : team.hasKb
          ? '📄 KB en Drive — pulsa Sincronizar'
          : '📄 KB sin configurar en la hoja Config';
      $('kbEngine').innerHTML = '⚡ Copilot';
      $('btnKbSync').hidden = false;
      $('btnKbDrive').hidden = !team.kbDriveId;
      // Primera visita al equipo: sincroniza su KB en segundo plano.
      if (team.hasKb && state.kbSynced[team.id] === undefined) {
        state.kbSynced[team.id] = 0;
        kbSyncNow(team.id, true);
      }
    }
    $('btnNuevaEquipo').hidden = teamId !== state.userTeamId;
    $('chatGroupEmail').textContent = team.grupo;
    $('chatText').placeholder =
      'Mensaje a ' + team.grupo + '…  (Enter para enviar)';
    $('kbText').placeholder =
      'Pregunta a la KB de ' + team.corto + '…  (Enter para enviar)';
    $('formTeamLabel').textContent = 'de ' + team.corto;

    // La KB SIEMPRE es la pestaña inicial al entrar.
    activateTeamTab('kb', true);

    state.messages = [];
    renderChat();
    // Hasta la primera respuesta del grupo, el chat muestra su carga
    // (en real la primera lectura de Gmail tarda unos segundos).
    $('chatList').innerHTML = htmlCargando('Cargando el chat del grupo…');
    setTyping(null);
    $('syncText').textContent = 'Sincronizando…';
    renderKbAll();
    renderKbSuggestions();
    renderTeamFormaciones();

    showScreen('team');
    refreshChat().then(function () {
      const list = $('chatList');
      list.scrollTop = list.scrollHeight;
    });
  }

  /** Vuelve al menú inicial. */
  function goHome() {
    state.currentTeamId = null;
    showScreen('home');
    renderTeamsGrid();
    renderCalendar();
    renderCalDetail();
  }

  // ─────────────────────────────────────────────── Pestañas del menú ──

  function activateHomeTab(tab) {
    state.homeTab = tab;
    const defs = [
      { id: 'teams', btn: 'tabTeams', view: 'viewTeams' },
      { id: 'calendar', btn: 'tabCalendar', view: 'viewCalendar' },
      { id: 'dir', btn: 'tabDir', view: 'viewDir' }
    ];
    defs.forEach(function (d) {
      const active = d.id === tab;
      $(d.btn).classList.toggle('active', active);
      $(d.btn).setAttribute('aria-selected', String(active));
      $(d.view).hidden = !active;
    });
    if (tab === 'calendar') {
      renderCalendar();
      renderCalDetail();
    }
    if (tab === 'dir') {
      renderTra();
      $('dirSearch').focus();
    }
  }

  // ───────────────────────────────────── Pestañas del equipo (KB / chat) ──

  /**
   * Activa una pestaña del equipo. El chat exige haber aceptado el aviso
   * modal (una vez por equipo y sesión); si no, se muestra el aviso.
   */
  function activateTeamTab(tab, skipModal) {
    if (tab === 'chat' && !skipModal && !state.chatUnlocked[state.currentTeamId]) {
      openChatModal();
      return;
    }

    state.teamTab = tab;
    const isKb = tab === 'kb';
    $('tabKb').classList.toggle('active', isKb);
    $('tabChat').classList.toggle('active', !isKb);
    $('tabKb').setAttribute('aria-selected', String(isKb));
    $('tabChat').setAttribute('aria-selected', String(!isKb));
    $('viewKb').hidden = !isKb;
    $('viewChat').hidden = isKb;
    if (isKb) {
      $('kbList').scrollTop = $('kbList').scrollHeight;
      $('kbText').focus();
    } else {
      $('chatList').scrollTop = $('chatList').scrollHeight;
      $('chatText').focus();
    }
  }

  // ─────────────────────────────────────── Aviso modal antes del chat ──

  function openChatModal() {
    const team = teamById(state.currentTeamId);
    const foreign = isForeign(state.currentTeamId);
    $('chatModalBody').innerHTML = foreign
      ? 'Estás a punto de escribir al grupo de <strong>' +
        escapeHtml(team.nombre) + '</strong>. Atienden el chat cuando pueden: ' +
        'ten <strong>paciencia</strong> con las respuestas y pregunta solo si ' +
        'su Knowledge Base no ha resuelto tu duda.'
      : 'Muchas dudas del día a día ya están resueltas en la Knowledge Base ' +
        'de <strong>' + escapeHtml(team.nombre) + '</strong>. ' +
        '¿Seguro que no prefieres consultarla primero?';
    $('chatModal').hidden = false;
    $('btnModalKb').focus();
  }

  function closeChatModal(openChat) {
    $('chatModal').hidden = true;
    if (openChat) {
      state.chatUnlocked[state.currentTeamId] = true;
      activateTeamTab('chat', true);
    } else {
      activateTeamTab('kb', true);
    }
  }

  // ─────────────────────────────────────────────────────── Pequeña UI aux ──

  function toggleFormNueva(show) {
    const form = $('formNueva');
    const willShow = typeof show === 'boolean' ? show : form.hidden;
    form.hidden = !willShow;
    $('btnToggleNueva').textContent = willShow ? '－ Cerrar' : '＋ Nueva';
    if (willShow) {
      const myTeam = teamById(state.userTeamId);
      $('formNote').textContent =
        'Se creará a nombre de tu equipo (' + myTeam.icon + ' ' +
        myTeam.corto + ') y se avisará a su grupo.';
      const fFecha = $('fFecha');
      if (!fFecha.value) {
        fFecha.value = fechaES(new Date());
      }
      $('fTitulo').focus();
    }
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 110) + 'px';
  }

  // ────────────────────────────────────────────── Login (action=auth) ──

  /** true cuando la sesión existe pero su token ya no vale (caducó ~1h). */
  let sesionExpirada = false;

  /**
   * Sincroniza el botón «Conectar» con el estado actual. Tres estados:
   * sin sesión → «Conectar» (primario); sesión viva → «✓ Conectado ·
   * renovar»; sesión caducada → «DESCONECTADO · reconectar» (aviso).
   * NUNCA se deshabilita: pulsar siempre (re)lanza el login — un botón
   * bloqueado dejaba atrapado al usuario con un token inservible.
   */
  function actualizarBotonConectar() {
    const btn = $('btnConectar');
    if (MOCK_MODE) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.disabled = false;
    btn.classList.remove('primary', 'joined', 'warn');
    if (!sesion) {
      btn.classList.add('primary');
      btn.textContent = 'Conectar';
      btn.title = 'Iniciar sesión con tu cuenta corporativa en el navegador';
    } else if (sesionExpirada) {
      btn.classList.add('warn');
      btn.textContent = 'DESCONECTADO · reconectar';
      btn.title = 'La sesión ha caducado. Pulsa para reconectar en el navegador.';
    } else {
      btn.classList.add('joined');
      btn.textContent = '✓ Conectado · renovar';
      btn.title =
        'Sesión activa. Pulsa para renovarla (necesario tras redesplegar el backend o si caduca el token compartido).';
    }
  }

  /** Lanza el login mostrando el estado «Conectando…» en el botón. */
  function iniciarLoginUI() {
    const btn = $('btnConectar');
    btn.disabled = true;
    btn.textContent = 'Conectando…';
    vscode.postMessage({ type: 'iniciarLogin' });
  }

  /**
   * La sesión ya no vale (caducidad avisada por la extensión o detectada
   * en una llamada). El botón pasa a DESCONECTADO y, si aún no se había
   * llegado a cargar nada, se muestra la pantalla grande de conexión.
   */
  function marcarDesconectado() {
    if (!sesion || sesionExpirada) {
      sesionExpirada = Boolean(sesion);
      actualizarBotonConectar();
      return;
    }
    sesionExpirada = true;
    actualizarBotonConectar();
    toastError('Sesión', 'ha caducado — pulsa «DESCONECTADO · reconectar»');
    if (!state.initOk) {
      mostrarConectarGrande();
    }
  }

  /**
   * Pantalla inicial sin sesión (o con sesión caducada antes de cargar):
   * SOLO el botón grande de conectar — sin pestañas ni errores en crudo.
   */
  function mostrarConectarGrande() {
    $('userLine').classList.remove('cargando');
    $('userLine').textContent = 'Sin conexión';
    $('homeTabs').hidden = true;
    $('teamsGrid').innerHTML =
      '<div class="connect-cta">' +
      '<p>Conecta tu cuenta corporativa para entrar al portal: se abre tu ' +
      'navegador, verificas tu identidad de Google y vuelves aquí.</p>' +
      '<button class="btn primary btn-grande" id="btnConectarGrande" type="button">' +
      (sesionExpirada ? 'Reconectar' : 'Conectar') + '</button>' +
      '</div>';
    $('btnConectarGrande').addEventListener('click', function () {
      $('btnConectarGrande').disabled = true;
      $('btnConectarGrande').textContent = 'Conectando…';
      iniciarLoginUI();
    });
  }

  /**
   * Engancha el botón «Conectar» y los mensajes de login. Se llama SIEMPRE
   * al arrancar, antes de init() — así funciona aunque init() falle nada
   * más empezar (justo el caso en el que hace falta: sin sesión, modo
   * real, loadTeams() revienta y init() vuelve enseguida sin enganchar
   * nada más).
   */
  function wireLogin() {
    actualizarBotonConectar();
    $('btnConectar').addEventListener('click', iniciarLoginUI);
    window.addEventListener('message', function (event) {
      const msg = (event && event.data) || {};
      if (msg.type === 'loginOk') {
        // El token en sí (sessionToken + el Bearer compartido) se queda
        // en la extensión — aquí solo hace falta saber que hay sesión y
        // el email, para la UI del botón. api() ya no lo necesita: cada
        // llamada real se la pide a la extensión (ver apiReal).
        sesion = { email: msg.email };
        sesionExpirada = false;
        actualizarBotonConectar();
        toast('✓ Conectado como ' + msg.email);
        // Primer login tras un arranque sin sesión (o caducada): init()
        // no llegó a enganchar nada, así que reintentar es seguro (ver
        // el comentario de state.initOk en init()).
        if (!state.initOk) {
          init();
        }
      } else if (msg.type === 'loginError') {
        actualizarBotonConectar();
        toastError('Conectar', msg.error);
        // Reactiva también el botón grande si es el que está en pantalla.
        const grande = document.getElementById('btnConectarGrande');
        if (grande) {
          grande.disabled = false;
          grande.textContent = sesionExpirada ? 'Reconectar' : 'Conectar';
        }
      } else if (msg.type === 'loginExpired') {
        // Aviso proactivo de la extensión (~1 min antes de caducar).
        marcarDesconectado();
      } else if (msg.type === 'sessionStatus') {
        // Respuesta al checkSession del arranque con sesión guardada.
        if (!msg.ok) {
          marcarDesconectado();
        }
      } else if (msg.type === 'apiResult' && msg.reqId) {
        const resolve = apiPending[msg.reqId];
        if (resolve) {
          delete apiPending[msg.reqId];
          resolve(msg.data);
        }
        // Cualquier llamada rechazada por caducidad pasa el botón a
        // DESCONECTADO, venga de donde venga (polling del chat incluido).
        if (msg.data && msg.data.authExpired) {
          marcarDesconectado();
        }
      }
    });
    // La sesión inyectada puede llevar horas guardada: se comprueba si
    // su token sigue vivo (la extensión responde con sessionStatus).
    if (!MOCK_MODE && sesion) {
      vscode.postMessage({ type: 'checkSession' });
    }
  }

  // ───────────────────────────────────────────────────────── Arranque ──

  async function init() {
    // Insignia siempre visible: el MODO y la versión instalada. El estado
    // de conexión NO va aquí (lo lleva el botón Conectar): la insignia
    // decía «CONECTADO» solo por estar en modo real, contradiciendo al
    // botón «DESCONECTADO» de al lado.
    $('badgeDemo').textContent =
      (MOCK_MODE ? 'MODO DEMO' : 'MODO REAL') +
      (CONFIG.version ? ' · v' + CONFIG.version : '');
    $('badgeDemo').hidden = false;
    if (MOCK_MODE) {
      $('demoBanner').hidden = false;
    }
    // Avatar con las iniciales del correo (pablo.llorentec… → «PL»),
    // visible también antes de conectar.
    const avatarIni = $('userAvatar');
    avatarIni.textContent = inicialesDeEmail(USER.email, USER.name);
    avatarIni.title = USER.name + ' (' + USER.email + ')';
    // Spinner pequeño junto al «Identificando usuario…» del topbar.
    $('userLine').classList.add('cargando');
    $('userLine').innerHTML =
      '<span class="spinner spinner-mini"></span>Identificando usuario…';

    // 0) Modo real SIN sesión: nada de llamadas ni errores en crudo —
    // solo la pantalla de conexión. Tras conectar, loginOk relanza init().
    if (!MOCK_MODE && (!sesion || sesionExpirada)) {
      $('userLine').classList.remove('cargando');
      mostrarConectarGrande();
      return;
    }

    // 0bis) Modo real: los equipos salen de la hoja Config del backend.
    if (!MOCK_MODE) {
      $('teamsGrid').innerHTML = htmlCargando('Cargando los equipos del área…');
      try {
        await loadTeams();
      } catch (err) {
        // Token caducado — por la marca de ESTA llamada o porque el
        // checkSession del arranque llegó antes (carrera): pantalla de
        // conexión, nunca el error en crudo.
        $('userLine').classList.remove('cargando');
        if ((err && err.authExpired) || sesionExpirada) {
          marcarDesconectado();
          mostrarConectarGrande();
          return;
        }
        const motivo = (err && err.message) || 'error desconocido';
        $('userLine').textContent = 'Error conectando con el backend';
        $('teamsGrid').innerHTML =
          '<div class="empty"><span class="empty-icon">⚠️</span>' +
          'No se pudieron cargar los equipos: ' + escapeHtml(motivo) +
          '.<br>Revisa los ajustes de KDD Portal o el despliegue del ' +
          'backend (backend/DESPLIEGUE.md).</div>';
        toastError('Equipos', motivo);
        return;
      }
      // Refuerzo de la misma carrera en el otro orden: si el checkSession
      // marcó la sesión caducada mientras getTeams aún respondía bien
      // (caducó justo en medio), manda el estado desconectado.
      if (sesionExpirada) {
        mostrarConectarGrande();
        return;
      }
    }
    // A partir de aquí no hay más "return" antes de enganchar los
    // listeners (sección 3 en adelante): a partir de ahora, reintentar
    // llamando a init() otra vez duplicaría listeners. Ver wireLogin.
    state.initOk = true;
    $('homeTabs').hidden = false;

    // 1) El backend indica el equipo del usuario (hoja "Usuarios").
    let teamUsuario = '';
    try {
      const info = await api('getUserInfo');
      if (info && info.ok !== false) {
        teamUsuario = String(info.team || '');
      } else {
        toastError('Identidad', info && info.error);
      }
    } catch (err) {
      // Sin respuesta: se aplica el fallback de abajo.
    }
    if (teamUsuario && TEAMS.some(function (t) { return t.id === teamUsuario; })) {
      state.userTeamId = teamUsuario;
    } else {
      state.userTeamId = TEAMS[0].id;
      if (!MOCK_MODE) {
        toastError(
          'Identidad',
          teamUsuario
            ? 'tu equipo «' + teamUsuario + '» no está en la hoja Config'
            : 'tu email no está en la hoja Usuarios — mostrando ' + TEAMS[0].nombre
        );
      }
    }
    const myTeam = teamById(state.userTeamId);

    // 2) Cabecera con identidad + equipo propio.
    $('userLine').classList.remove('cargando');
    $('userLine').textContent =
      USER.name + ' · ' + USER.email + '  —  ' +
      myTeam.icon + ' ' + myTeam.nombre;
    const avatar = $('userAvatar');
    avatar.textContent = inicialesDeEmail(USER.email, USER.name);
    avatar.title = USER.name + ' (' + USER.email + ') · ' + myTeam.nombre;

    // 3) Menú inicial.
    $('tabTeams').addEventListener('click', function () {
      activateHomeTab('teams');
    });
    $('tabCalendar').addEventListener('click', function () {
      activateHomeTab('calendar');
    });
    $('tabDir').addEventListener('click', function () {
      activateHomeTab('dir');
    });
    renderTeamsGrid();

    // Proyectos y personas (informe TRA).
    $('dirSearch').addEventListener('input', function () {
      state.dirQuery = $('dirSearch').value;
      if (state.tra) renderTraResults();
    });
    [
      { id: 'fNombre', campo: 'nombre' },
      { id: 'fEquipo', campo: 'equipo' },
      { id: 'fSda', campo: 'sda' },
      { id: 'fJira', campo: 'jira' }
    ].forEach(function (def) {
      $(def.id).addEventListener('change', function () {
        state.traFilters[def.campo] = $(def.id).value;
        if (state.tra) renderTraResults();
      });
    });
    $('btnResetFiltros').addEventListener('click', function () {
      if (state.tra) {
        resetTraFilters();
      } else {
        state.traError = '';
        renderTra(); // reintenta la carga
      }
    });
    $('btnLooker').addEventListener('click', function () {
      vscode.postMessage({ type: 'openLooker' });
      toast('↗ Abriendo el informe de Looker Studio en el navegador…');
    });
    loadTra();

    // Calendario.
    $('calPrev').addEventListener('click', function () {
      state.calMonth = new Date(
        state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1
      );
      renderCalendar();
    });
    $('calNext').addEventListener('click', function () {
      state.calMonth = new Date(
        state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1
      );
      renderCalendar();
    });
    $('calToday').addEventListener('click', function () {
      const today = new Date();
      state.calMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      state.calSelected = isoDay(today);
      renderCalendar();
      renderCalDetail();
    });
    renderCalendar();
    renderCalDetail();

    // 4) Pantalla de equipo.
    $('btnBackMenu').addEventListener('click', goHome);
    $('tabKb').addEventListener('click', function () {
      activateTeamTab('kb');
    });
    $('tabChat').addEventListener('click', function () {
      activateTeamTab('chat');
    });

    // KB real: sincronización manual y alta de formación desde el equipo.
    $('btnKbSync').addEventListener('click', function () {
      if (state.currentTeamId) kbSyncNow(state.currentTeamId, false);
    });
    // Carpeta de la KB en Drive, en el navegador.
    $('btnKbDrive').addEventListener('click', function () {
      const team = teamById(state.currentTeamId);
      if (team && team.kbDriveId) {
        vscode.postMessage({ type: 'openKbDrive', folderId: team.kbDriveId });
        toast('↗ Abriendo la carpeta de Drive de la KB…');
      }
    });
    // Carpeta local de la KB: abrir en el explorador o cambiar la ruta.
    $('kbPath').addEventListener('click', function () {
      if (!MOCK_MODE && state.currentTeamId) {
        vscode.postMessage({ type: 'kbCarpetaLocal', teamId: state.currentTeamId });
      }
    });
    // Enlaces [texto](destino) dentro de las respuestas de la KB: los
    // resuelve la extensión (documento de la KB → editor; URL → navegador).
    $('kbList').addEventListener('click', function (event) {
      const link = event.target && event.target.closest
        ? event.target.closest('.kb-doclink')
        : null;
      if (!link) return;
      event.preventDefault();
      vscode.postMessage({
        type: 'openKbLink',
        teamId: state.currentTeamId,
        href: link.getAttribute('data-href') || ''
      });
    });
    $('btnNuevaEquipo').addEventListener('click', function () {
      goHome();
      activateHomeTab('calendar');
      toggleFormNueva(true);
    });

    // Mensajes de la extensión (puente KB↔Copilot y sincronización).
    window.addEventListener('message', function (event) {
      const msg = (event && event.data) || {};
      if (msg.type === 'kbChunk' || msg.type === 'kbDone' || msg.type === 'kbError') {
        onKbBridgeMessage(msg);
      } else if (msg.type === 'kbSyncDone' || msg.type === 'kbSyncError') {
        onKbSyncMessage(msg);
      }
    });

    // Aviso modal del chat.
    $('btnModalKb').addEventListener('click', function () {
      closeChatModal(false);
    });
    $('btnModalOpen').addEventListener('click', function () {
      closeChatModal(true);
    });
    $('chatModal').addEventListener('click', function (event) {
      if (event.target === $('chatModal')) {
        closeChatModal(false);
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('chatModal').hidden) {
        closeChatModal(false);
      }
    });

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

    // Nueva formación (desde el calendario, a nombre del equipo propio).
    // Horas en desplegable de medias horas (08:00–19:30): más directo que
    // el input time nativo, que además se pinta en formato AM/PM inglés.
    const selHora = $('fHora');
    for (let h = 8; h <= 19; h++) {
      ['00', '30'].forEach(function (min) {
        const valor = String(h).padStart(2, '0') + ':' + min;
        const opt = document.createElement('option');
        opt.value = valor;
        opt.textContent = valor;
        if (valor === '10:00') opt.selected = true;
        selHora.appendChild(opt);
      });
    }
    // Fecha en formato español dd/mm/aaaa con las barras automáticas
    // (el input date nativo se pinta en formato americano mm/dd/aaaa).
    $('fFecha').addEventListener('input', function () {
      const campo = $('fFecha');
      const digitos = campo.value.replace(/\D/g, '').slice(0, 8);
      let out = digitos;
      if (digitos.length > 4) {
        out = digitos.slice(0, 2) + '/' + digitos.slice(2, 4) + '/' + digitos.slice(4);
      } else if (digitos.length > 2) {
        out = digitos.slice(0, 2) + '/' + digitos.slice(2);
      }
      campo.value = out;
    });
    $('btnToggleNueva').addEventListener('click', function () {
      toggleFormNueva();
    });
    $('btnCancelarNueva').addEventListener('click', function () {
      toggleFormNueva(false);
    });
    $('formNueva').addEventListener('submit', onCreateFormacion);

    // 5) Datos + polling del chat (solo actúa dentro de un equipo).
    refreshFormaciones();
    setInterval(refreshChat, POLL_INTERVAL_MS);
  }

  document.addEventListener('DOMContentLoaded', function () {
    wireLogin();
    init();
  });
})();
