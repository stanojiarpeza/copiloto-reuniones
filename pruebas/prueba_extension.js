'use strict';
process.env.ALLOWED_ORIGINS = 'https://copiloto.example.com';
// Carga la extension de verdad en Chrome y simula Meet, Zoom web y Teams web con subtitulos
process.env.GOOGLE_CLIENT_ID = 'cliente-prueba'; process.env.GOOGLE_CLIENT_SECRET = 'x'; process.env.CLAVE_CIFRADO = 'k';
process.env.PUBLIC_DIR = require('path').join(__dirname, '../servidor/public'); process.env.RATE_LIMIT_PER_MIN = '5000';
const EXT = process.argv[2] || require('path').join(__dirname, '../extension');
const fs = require('fs'); const { execFileSync } = require('child_process');
const pgfalso = require('./pgfalso');
const db = require('../servidor/src/db'); db.usar(new pgfalso.Pool());
const S = require('../servidor/src/server');
const sql = function (q) { return execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-At', '-c', q], { encoding: 'utf8' }).trim(); };
sql('truncate usuarios cascade');
const tok = 'd'.repeat(48);
sql("insert into usuarios(email, refresh_token_cifrado, hoja_id) values ('ana@ejemplo.com', pgp_sym_encrypt('RT','k'), 'H'); insert into dispositivos(token_hash,email) values (digest('" + tok + "','sha256'),'ana@ejemplo.com')");
const realFetch = globalThis.fetch; const R = function (o) { return new Response(JSON.stringify(o), { status: 200 }); };
const recibidos = [];
globalThis.fetch = async function (url, op) {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, op);
  if (/oauth2|sheets/.test(url)) return R({ access_token: 'AT', expires_in: 3599 });
  const b = JSON.parse(op.body);
  if (b.messages[0].role === 'user') { recibidos.push(b.messages[0].content.split('TEXTO: """')[1].split('"""')[0]); return R({ choices: [{ message: { content: '{"idioma":"es","alerta":"ninguna","hay_compromiso":false}' } }] }); }
  return R({ choices: [{ message: { content: process.env.CAPTURAS_TIENDA
    ? 'ALERTA: oportunidad - están comparando proveedores\nDI AHORA: Gracias, John. Para recomendarte el plan correcto, ¿cuántas personas se conectan a la vez?\nPREGUNTA AHORA: ¿Qué es lo que más les ha fallado con su proveedor actual?'
    : 'DI AHORA: ok' } }] });
};
const PAGINAS = {
  meet: { url: 'https://meet.google.com/abc-defg-hij', html: '<title>Meet</title><div role="region" aria-label="Subtítulos" id="caja"></div>',
    script: function () { window.__decir = function (quien, texto) { const b = document.createElement('div'); b.className = 'nMcdL'; b.innerHTML = '<img><span class="NWpY1d"></span><div class="ygicle"></div>'; b.children[1].textContent = quien; b.children[2].textContent = texto; document.getElementById('caja').appendChild(b); }; } },
  zoom: { url: 'https://app.zoom.us/wc/123456789/join', html: '<title>Zoom</title><div class="lt-full-transcript" id="caja"></div>',
    script: function () { window.__decir = function (quien, texto) { const b = document.createElement('div'); b.className = 'lt-full-transcript__item'; b.innerHTML = '<div class="lt-full-transcript__display-name"></div><div class="lt-full-transcript__message"></div>'; b.children[0].textContent = quien; b.children[1].textContent = texto; document.getElementById('caja').appendChild(b); }; } },
  teams: { url: 'https://teams.microsoft.com/v2/', html: '<title>Teams</title><div data-tid="closed-caption-renderer-wrapper" id="caja"></div>',
    script: function () { window.__decir = function (quien, texto) { const b = document.createElement('div'); b.className = 'fui-ChatMessageCompact'; b.innerHTML = '<span data-tid="author"></span><span data-tid="closed-caption-text"></span>'; b.children[0].textContent = quien; b.children[1].textContent = texto; document.getElementById('caja').appendChild(b); }; } }
};
(async function () {
  await new Promise(function (r) { S.servidor.listen(0, '127.0.0.1', r); });
  const base = 'http://127.0.0.1:' + S.servidor.address().port;
  const { chromium } = require('playwright');
  fs.rmSync('/tmp/perfil-ext', { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext('/tmp/perfil-ext', { executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT], viewport: { width: 1280, height: 800 } });
  await ctx.route(/https:\/\/(meet\.google\.com|app\.zoom\.us|teams\.microsoft\.com)\/.*/, function (route) {
    const p = Object.values(PAGINAS).find(function (x) { return route.request().url().startsWith(x.url.split('/').slice(0, 3).join('/')); });
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body>' + p.html + '</body></html>' });
  });
  // Con DOMINIO_REAL=1 la app se abre en https://copiloto.example.com (redirigido a este servidor local)
  const REAL = process.env.DOMINIO_REAL === '1';
  const ORIGEN = REAL ? 'https://copiloto.example.com' : base;
  if (REAL) await ctx.route(/^https:\/\/copiloto\.example\.com\//, async function (route) {
    const req = route.request();
    const r = await route.fetch({ url: req.url().replace('https://copiloto.example.com', base) });
    route.fulfill({ response: r });
  });
  let sw = ctx.serviceWorkers()[0]; if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  console.log('Extensión cargada:', sw.url().split('/')[2].slice(0, 8) + '…', '· versión', await sw.evaluate(function () { return chrome.runtime.getManifest().version; }));

  const app = await ctx.newPage(); const errores = [];
  app.on('pageerror', function (e) { errores.push(e.message); });
  await app.addInitScript(function (a) {
    const s = function (k, v) { localStorage.setItem('copiloto.' + k, v); };
    s('cuenta.email', 'ana@ejemplo.com'); s('cuenta.hojaId', 'H'); s('cuenta.token', a.tok); s('ia.proveedor', 'groq'); s('ia.clave', 'gsk_x');
    s('pf.escenario', 'Venta'); s('pf.objetivo', 'Cerrar'); s('url', a.url); s('fuente', 'subs'); s('miNombre', 'Stanoji Arpeza'); s('pausa', '1000');
  }, { tok: tok, url: ORIGEN + '/webhook/b7d2e9a4-0002-4c22-8b02-000000000002/chat' });
  await app.goto(ORIGEN + '/'); await app.waitForTimeout(1200);
  console.log('La app detecta la extensión:', await app.evaluate(function () { return !/Falta la extensión/.test(document.getElementById('empezarModo').textContent); }), '·', (await app.innerText('#empezarModo')).slice(0, 70) + '…');

  for (const nombre of ['meet', 'zoom', 'teams']) {
    const P = PAGINAS[nombre];
    const pg = await ctx.newPage();
    await pg.goto(P.url); await pg.evaluate(P.script); await pg.waitForTimeout(800);
    const insigniaAntes = await pg.evaluate(function () { const i = document.querySelector('[data-copiloto="insignia"]'); return i ? i.textContent : '(sin insignia)'; });
    if (nombre === 'meet') { await app.bringToFront(); await app.click('#btnEmpezar'); await app.waitForTimeout(300); }
    await pg.evaluate(function (n) { window.__decir('John Smith', 'Hola, gracias por la reunión de hoy en ' + n + ', estamos revisando proveedores de internet para la oficina'); }, nombre);
    await pg.waitForTimeout(400);
    await pg.evaluate(function () { window.__decir('Stanoji Arpeza', 'Perfecto John, cuéntame cuántas personas trabajan en la oficina'); });
    await pg.waitForTimeout(2600);
    const insignia = await pg.evaluate(function () { const i = document.querySelector('[data-copiloto="insignia"]'); return i ? i.textContent : '(sin insignia)'; });
    console.log('\n[' + nombre.toUpperCase() + '] insignia sin subtítulos: «' + insigniaAntes + '»');
    console.log('[' + nombre.toUpperCase() + '] insignia leyendo: «' + insignia + '»');
    await pg.close();
  }
  await app.waitForTimeout(2500);
  const tx = await app.evaluate(function () { const id = document.getElementById('sesion').textContent; return JSON.parse(localStorage.getItem('copiloto.tx.' + id) || '[]').map(function (x) { return x.q + ': ' + x.t; }); });
  console.log('\nTranscripción en la app:\n  ' + tx.join('\n  '));
  console.log('\nLo que recibió el servidor (clasificación):\n  ' + recibidos.join('\n  '));
  if (process.env.CAPTURAS_TIENDA) {
    const d = process.env.CAPTURAS_TIENDA; fs.mkdirSync(d, { recursive: true });
    await app.bringToFront(); await app.evaluate(function () { window.scrollTo(0, 0); });
    await app.screenshot({ path: d + '/1-consejo.png' });
    await app.click('#atTranscripcion'); await app.waitForTimeout(400);
    await app.screenshot({ path: d + '/2-transcripcion.png' });
  }
  console.log('\nErrores:', errores.length ? errores : 'ninguno');
  await ctx.close(); S.servidor.close(); process.exit(0);
})().catch(function (e) { console.error('FALLÓ', e); process.exit(1); });
