'use strict';
process.env.GOOGLE_CLIENT_ID = 'cliente-prueba'; process.env.GOOGLE_CLIENT_SECRET = 'x'; process.env.CLAVE_CIFRADO = 'k';
process.env.PUBLIC_DIR = require('path').join(__dirname, '../servidor/public'); process.env.RATE_LIMIT_PER_MIN = '1000';
const fs = require('fs'); const { execFileSync } = require('child_process');
const pgfalso = require('./pgfalso');
const db = require('../servidor/src/db'); db.usar(new pgfalso.Pool());
const S = require('../servidor/src/server');
const sql = function (q) { return execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-At', '-c', q], { encoding: 'utf8' }).trim(); };
sql('truncate usuarios cascade');
const tok = 'c'.repeat(48);
sql("insert into usuarios(email, refresh_token_cifrado, hoja_id) values ('ana@ejemplo.com', pgp_sym_encrypt('RT','k'), 'HOJA123'); insert into dispositivos(token_hash,email) values (digest('" + tok + "','sha256'),'ana@ejemplo.com')");
const realFetch = globalThis.fetch; const R = function (o) { return new Response(JSON.stringify(o), { status: 200 }); };
let ultimaPregunta = null;
globalThis.fetch = async function (url, op) {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, op);
  if (/oauth2/.test(url)) return R({ access_token: 'AT', expires_in: 3599 });
  if (/sheets/.test(url)) return R({});
  if (/generateContent/.test(url)) {
    ultimaPregunta = JSON.parse(op.body);
    const q = ultimaPregunta.contents[ultimaPregunta.contents.length - 1].parts[0].text;
    if (/listo/.test(q)) return R({ candidates: [{ content: { parts: [{ text: 'listo' }] } }] });
    return R({ candidates: [{ content: { parts: [{ text: 'Encontré estos precios mensuales del plan de fibra de 300 Mbps:\n\n- **Tu plan:** 30 USD\n- **Competidor A:** 45 USD (lo mencionó el cliente)\n- **Competidor B:** 38 USD\n\nTu plan es el más barato: úsalo como argumento, pero pregunta qué valora más el cliente.\n\n```grafico\n{"tipo":"barras","titulo":"Precio mensual del plan 300 Mbps","unidad":"USD","etiquetas":["Tu plan","Competidor A","Competidor B"],"series":[{"nombre":"Precio","valores":[30,45,38]}]}\n```' }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://www.ejemplo-telecom.pe/planes', title: 'ejemplo-telecom.pe' } }, { web: { uri: 'https://comparador.pe/fibra', title: 'comparador.pe' } }] } }] });
  }
  if (/chat\/completions/.test(url)) {
    const b = JSON.parse(op.body);
    if (b.messages[0].role === 'user') {
      const t = b.messages[0].content;
      const en = /expensive/.test(t);
      return R({ choices: [{ message: { content: JSON.stringify({ idioma: en ? 'en' : 'es', traduccion: en ? 'Es demasiado caro para nosotros' : null, alerta: /caro|expensive|precio/.test(t) ? 'precio' : 'ninguna', hay_compromiso: false }) } }] });
    }
    return R({ choices: [{ message: { content: 'ALERTA: precio - comparación\nDI AHORA: Entiendo, ¿con qué plan nos estás comparando?\nPREGUNTA AHORA: ¿Qué es lo más importante para ti?' } }] });
  }
  throw new Error('no simulada ' + url);
};
(async function () {
  await new Promise(function (r) { S.servidor.listen(0, '127.0.0.1', r); });
  const base = 'http://127.0.0.1:' + S.servidor.address().port;
  const URLCHAT = base + '/webhook/b7d2e9a4-0002-4c22-8b02-000000000002/chat';
  const { chromium } = require('playwright');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  fs.mkdirSync('/tmp/capturas', { recursive: true });
  const errores = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
  const pg = await ctx.newPage();
  pg.on('pageerror', function (e) { errores.push(e.message); });
  pg.on('console', function (m) { if (m.type() === 'error' && !/accounts\.google|gsi|Failed to load resource/.test(m.text())) errores.push('consola: ' + m.text()); });
  await pg.addInitScript(function (u) { if (!localStorage.getItem('copiloto.url')) localStorage.setItem('copiloto.url', u); }, URLCHAT);

  // 1) Usuario nuevo: la guia se abre sola en el paso 1
  await pg.goto(base + '/'); await pg.waitForTimeout(700);
  console.log('Guía abierta al entrar:', await pg.isVisible('#guia'), '· paso visible:', await pg.evaluate(function () { return document.querySelector('#guia [data-paso]:not([hidden])').getAttribute('data-paso'); }));
  console.log('Siguiente deshabilitado sin Google:', await pg.isDisabled('#gSiguiente'));
  await pg.screenshot({ path: '/tmp/capturas/1-guia-paso1.png' });

  // 2) Simula que Google ya se conecto (el popup real de Google no se puede usar aqui)
  await pg.evaluate(function (t) { localStorage.setItem('copiloto.cuenta.email', 'ana@ejemplo.com'); localStorage.setItem('copiloto.cuenta.hojaId', 'HOJA123'); localStorage.setItem('copiloto.cuenta.token', t); }, tok);
  await pg.reload(); await pg.waitForTimeout(700);
  console.log('Tras conectar Google, la guía pasa al paso:', await pg.evaluate(function () { return document.querySelector('#guia [data-paso]:not([hidden])').getAttribute('data-paso'); }));
  await pg.click('.opcion-ia[data-prov="gemini"]');
  await pg.fill('#gClave', 'gsk_esto-es-de-groq');
  console.log('Aviso clave equivocada:', await pg.innerText('#gEstado2'));
  await pg.fill('#gClave', 'AIzaSyPRUEBA123');
  await pg.click('#gProbar'); await pg.waitForFunction(function () { return /funciona|✗/.test(document.getElementById('gEstado2').textContent); });
  console.log('Probar mi IA:', await pg.innerText('#gEstado2'));
  await pg.screenshot({ path: '/tmp/capturas/2-guia-paso2.png' });
  await pg.click('#gSiguiente');
  await pg.click('#gChips button:has-text("Venta")');
  await pg.fill('#gObjetivo', 'Que contrate el plan de fibra de 300 Mbps');
  await pg.fill('#gContexto', 'Vendo internet de fibra, el plan de 300 Mbps cuesta 30 USD al mes');
  await pg.screenshot({ path: '/tmp/capturas/3-guia-paso3.png' });
  await pg.click('#gSiguiente');
  await pg.screenshot({ path: '/tmp/capturas/4-guia-listo.png' });
  await pg.click('#gSiguiente');
  console.log('Guía cerrada:', !(await pg.isVisible('#guia')), '· aviso pendiente oculto:', await pg.isHidden('#avisoGuia'), '· texto:', await pg.innerText('#avisoGuiaTxt'));
  console.log('Perfil guardado en Ajustes:', await pg.inputValue('#pfEscenario'), '|', await pg.inputValue('#pfObjetivo'));

  // 3) Pantalla principal
  await pg.evaluate(function () { window.scrollTo(0, 0); });
  await pg.screenshot({ path: '/tmp/capturas/5-principal.png' });

  // 4) Conversacion y transcripcion completa
  for (const t of ['CLIENTE: hola, estamos evaluando proveedores de internet', 'YO: perfecto, cuéntame qué usan hoy', 'CLIENTE: [John] it is too expensive for us', 'CLIENTE: el otro proveedor nos cobra 45 dólares']) {
    await pg.fill('#textoManual', t.replace(/^CLIENTE: |^YO: /, ''));
    await pg.evaluate(function (yo) { document.getElementById(yo ? 'btnYo' : 'btnCliente').click(); }, t.startsWith('YO:'));
    await pg.click('#formManual button[type=submit]'); await pg.waitForTimeout(500);
  }
  await pg.waitForTimeout(800);
  await pg.click('#atTranscripcion'); await pg.waitForTimeout(400);
  console.log('Transcripción:', await pg.innerText('#txTotal'));
  await pg.locator('#panelTx').screenshot({ path: '/tmp/capturas/6-transcripcion.png' });
  const [descarga] = await Promise.all([pg.waitForEvent('download'), pg.click('#txDescargar')]);
  console.log('Descarga:', descarga.suggestedFilename(), '·', fs.readFileSync(await descarga.path(), 'utf8').split('\n').slice(2, 4).join(' / '));

  // 5) Preguntale a tu IA con grafico y fuentes
  await pg.click('#atPreguntar'); await pg.waitForTimeout(300);
  await pg.click('#pSugeridas button:has-text("Busca precios")');
  await pg.waitForSelector('#pLista .grafico svg', { timeout: 10000 });
  const ctxIA = ultimaPregunta.contents[0].parts[0].text;
  console.log('La IA recibió la transcripción:', /otro proveedor nos cobra 45/.test(ctxIA), '· con traducción:', /Es demasiado caro para nosotros/.test(ctxIA), '· con perfil:', /Vendo internet de fibra/.test(ctxIA));
  console.log('Barras dibujadas:', await pg.locator('#pLista .grafico rect').count(), '· fuentes:', await pg.locator('#pLista .fuentes a').count());
  await pg.locator('#panelIA').screenshot({ path: '/tmp/capturas/7-pregunta-ia.png' });

  // 6) Boton Ver mi historial abre el Sheets
  const [pop] = await Promise.all([pg.waitForEvent('popup'), pg.click('#atHistorial')]);
  console.log('Ver mi historial abre:', pop.url().replace(/\?.*/, ''));
  await pop.close();

  // 7) En celular
  const cel = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const pc = await cel.newPage(); pc.on('pageerror', function (e) { errores.push('celular: ' + e.message); });
  await pc.addInitScript(function (u) { localStorage.setItem('copiloto.url', u); }, URLCHAT);
  await pc.goto(base + '/'); await pc.waitForTimeout(700);
  await pc.screenshot({ path: '/tmp/capturas/8-celular-guia.png' });
  console.log('Errores:', errores.length ? errores : 'ninguno');
  await b.close(); S.servidor.close(); process.exit(0);
})().catch(function (e) { console.error('FALLÓ', e); process.exit(1); });
