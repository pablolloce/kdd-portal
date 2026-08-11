// Prueba end-to-end del webview en Chromium headless: menú (equipos,
// calendario, informe TRA) → equipo (KB primero, chat tras modal) → menú.
// Ejecutar antes: node build-test-html.mjs
// Chromium: usa el de Playwright; si no está descargado, exporta
// CHROMIUM_PATH con la ruta de un Chromium/Chrome local.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const shot = (name) => join(HERE, name);

const launchOptions = process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH }
  : {};
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('CONSOLE-ERROR:', msg.text());
});

await page.goto(pathToFileURL(join(HERE, 'test.html')).href);

// Espera al init (getUserInfo con latencia mock + render de tarjetas).
await page.waitForFunction(
  () => document.querySelectorAll('.team-card').length === 4,
  null,
  { timeout: 8000 }
);
await page.waitForTimeout(700);

const report = {};
report.badge = await page.$eval('#badgeDemo', (el) => el.textContent);
report.menuVisibleAlInicio = await page.$eval('#screenHome', (el) => !el.hidden);
report.tarjetas = await page.$$eval('.team-card', (els) => els.length);
report.badgeTuEquipo = await page.$eval(
  '.team-card.tc-front-office .team-badge',
  (el) => el.textContent
);
await page.screenshot({ path: shot('menu-equipos.png') });

// ── Pestaña calendario ──
await page.click('#tabCalendar');
await page.waitForTimeout(300);
report.tituloCalendario = await page.$eval('#calTitle', (el) => el.textContent);
report.celdas = await page.$$eval('.cal-cell', (els) => els.length);
report.chipsEnCalendario = await page.$$eval('.cal-chip', (els) => els.length);
await page.screenshot({ path: shot('menu-calendario.png') });

// ── Pestaña proyectos y personas (informe TRA) ──
await page.click('#tabDir');
await page.waitForFunction(
  () => document.querySelectorAll('#tblPersonas tbody tr').length > 0,
  null, { timeout: 8000 }
);
report.traTotalCompleto = await page.$eval('#traTotal', (el) => el.textContent);
report.traPersonasFilas = await page.$$eval('#tblPersonas tbody tr', (els) => els.length);
report.traProyectosFilas = await page.$$eval('#tblProyectos tbody tr', (els) => els.length);
report.traLeyenda = await page.$$eval('.tra-leg', (els) => els.map((e) => e.textContent.split(' · ')[0]));
// Filtro por equipo.
await page.selectOption('#fEquipo', 'FO-Murex');
await page.waitForTimeout(150);
report.traEquiposTrasFiltro = await page.$$eval(
  '#tblPersonas tbody td:nth-child(2)',
  (els) => Array.from(new Set(els.map((e) => e.textContent)))
);
report.traTotalFiltrado = await page.$eval('#traTotal', (el) => el.textContent);
await page.screenshot({ path: shot('tra-filtrado.png') });
// Búsqueda libre.
await page.selectOption('#fEquipo', '');
await page.fill('#dirSearch', 'Calypso');
await page.waitForTimeout(200);
report.traBusquedaCalypso = await page.$$eval('#tblProyectos tbody tr', (els) => els.length);
// Clic en fila de persona → filtra por nombre.
await page.fill('#dirSearch', '');
await page.waitForTimeout(150);
await page.click('#tblPersonas tbody tr');
await page.waitForTimeout(150);
report.traClickPersonaFiltra = await page.$eval('#fNombre', (el) => el.value !== '');
// Reestablecer.
await page.click('#btnResetFiltros');
await page.waitForTimeout(150);
report.traTrasReset = await page.$eval('#traTotal', (el) => el.textContent);
await page.screenshot({ path: shot('tra-dashboard.png') });
await page.click('#tabTeams');

// ── Entra en un equipo ajeno ──
await page.click('.team-card[data-id="liquidez"]');
await page.waitForTimeout(700);
report.pantallaEquipo = await page.$eval('#screenTeam', (el) => !el.hidden);
report.kbPrimeraPestana =
  (await page.$eval('#tabKb', (el) => el.classList.contains('active'))) &&
  (await page.$eval('#viewKb', (el) => !el.hidden)) &&
  (await page.$eval('#viewChat', (el) => el.hidden));
report.kbWarnVisible = await page.$eval('#kbWarn', (el) => !el.hidden);
report.badgeAjeno = await page.$eval('#teamBarBadge', (el) => el.textContent);
report.formacionesSoloDelEquipo = await page.$$eval(
  '#cardsList .card-title',
  (els) => els.map((e) => e.textContent)
);

// ── Clic en el chat → debe salir el modal ──
await page.click('#tabChat');
await page.waitForTimeout(250);
report.modalVisible = await page.$eval('#chatModal', (el) => !el.hidden);
report.modalTexto = (
  await page.$eval('#chatModalBody', (el) => el.textContent)
).slice(0, 70);
await page.screenshot({ path: shot('modal-chat.png') });

// Rechazar → sigue en KB.
await page.click('#btnModalKb');
await page.waitForTimeout(200);
report.trasRechazarSigueKb =
  (await page.$eval('#chatModal', (el) => el.hidden)) &&
  (await page.$eval('#viewKb', (el) => !el.hidden));

// Aceptar → se abre el chat con su aviso.
await page.click('#tabChat');
await page.click('#btnModalOpen');
await page.waitForTimeout(400);
report.chatAbiertoTrasAceptar = await page.$eval('#viewChat', (el) => !el.hidden);
report.chatWarnVisible = await page.$eval('#chatWarn', (el) => !el.hidden);
report.segundaVezSinModal = await page
  .click('#tabKb')
  .then(() => page.click('#tabChat'))
  .then(() => page.$eval('#chatModal', (el) => el.hidden));
await page.screenshot({ path: shot('equipo-chat.png') });

// ── Volver al menú ──
await page.click('#btnBackMenu');
await page.waitForTimeout(300);
report.vueltaAlMenu = await page.$eval('#screenHome', (el) => !el.hidden);

// ── Equipo propio: sin avisos de banner y modal con texto suave ──
await page.click('.team-card[data-id="front-office"]');
await page.waitForTimeout(600);
report.propioSinBanners =
  (await page.$eval('#kbWarn', (el) => el.hidden)) &&
  (await page.$eval('#teamBarBadge', (el) => el.textContent) === 'Tu equipo');
await page.click('#tabChat');
report.modalEnPropio = await page.$eval('#chatModal', (el) => !el.hidden);
await page.click('#btnModalOpen');
await page.waitForTimeout(300);
report.chatPropioSinBanner = await page.$eval('#chatWarn', (el) => el.hidden);

console.log(JSON.stringify(report, null, 2));
await browser.close();
