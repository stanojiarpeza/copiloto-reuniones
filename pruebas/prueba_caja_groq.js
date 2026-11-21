'use strict';
process.env.GOOGLE_CLIENT_ID = 'c'; process.env.GOOGLE_CLIENT_SECRET = 'x'; process.env.CLAVE_CIFRADO = 'k';
process.env.PUBLIC_DIR = require('path').join(__dirname, '../servidor/public'); process.env.RATE_LIMIT_PER_MIN = '1000';
const { execFileSync } = require('child_process');
const pgfalso = require('./pgfalso'); const db = require('../servidor/src/db'); db.usar(new pgfalso.Pool());
const S = require('../servidor/src/server');
const sql = (q) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-At', '-c', q], { encoding: 'utf8' }).trim();
sql('truncate usuarios cascade');
const tok = 'e'.repeat(48);
sql("insert into usuarios(email, refresh_token_cifrado, hoja_id) values ('ana@gmail.com', pgp_sym_encrypt('RT','k'), 'H'); insert into dispositivos(token_hash,email) values (digest('" + tok + "','sha256'),'ana@gmail.com')");
const realFetch = globalThis.fetch; const R = (o, st) => new Response(JSON.stringify(o), { status: st || 200 });
const llamadas = [];
globalThis.fetch = async function (url, op) {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, op);
  if (/oauth2|sheets/.test(url)) return R({ access_token: 'AT', expires_in: 3599 });
  const b = JSON.parse(op.body);
  if (url.includes(':generateContent')) { llamadas.push('gemini-buscar'); return R({ error: { code: 400, message: 'Search Grounding is not supported' } }, 400); }
  if (url.includes('groq') && b.tools && b.tools[0].type === 'browser_search') { llamadas.push('groq-buscar:' + op.headers.Authorization.slice(7, 11)); return R({ choices: [{ message: { content: process.env.TABLA ? 'Hoy el dólar está en 3.75 soles. En Perú subió 0.8 % en 5 días.\n\n| Fecha | Soles por dólar |\n|---|---|\n| 16 nov | 3.72 |\n| 17 nov | 3.73 |\n| 20 nov | 3.75 |\n\n```grafico\n{"tipo":"lineas","titulo":"Dólar en Perú, últimos 5 días","unidad":"PEN","etiquetas":["16 nov","17 nov","18 nov","19 nov","20 nov"],"series":[{"nombre":"Cierre","valores":[3.72,3.73,3.71,3.74,3.75]}]}\n```' : 'Hoy el dólar está en 3.75 soles.', executed_tools: [{ search_results: { results: [{ title: 'Tipo de cambio hoy | BCRP', url: 'https://www.bcrp.gob.pe/x' }, { title: 'Precio del dólar hoy en Perú: tipo de cambio y conversor', url: 'https://dolar.pe/hoy' }, { title: 'Otro de BCRP', url: 'https://www.bcrp.gob.pe/y' }] } }] } }] }); }
  llamadas.push('gemini-normal'); return R({ choices: [{ message: { content: 'Sin buscar: no tengo datos de hoy.' } }] });
};
(async function () {
  await new Promise((r) => S.servidor.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + S.servidor.address().port;
  const { chromium } = require('playwright');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const pg = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errores = []; pg.on('pageerror', (e) => errores.push(e.message));
  await pg.addInitScript((a) => {
    if (localStorage.getItem('copiloto.url')) return;
    const s = (k, v) => localStorage.setItem('copiloto.' + k, v);
    s('url', a.u); s('cuenta.email', 'ana@gmail.com'); s('cuenta.hojaId', 'H'); s('cuenta.token', a.t);
    s('ia.proveedor', 'gemini'); s('ia.clave', 'AIza' + 'x'.repeat(30)); s('guia.vista', '1'); s('pf.escenario', 'Venta'); s('pf.objetivo', 'Cerrar');
  }, { u: base + '/webhook/b7d2e9a4-0002-4c22-8b02-000000000002/chat', t: tok });
  await pg.goto(base + '/'); await pg.waitForTimeout(700);
  await pg.click('#atPreguntar'); await pg.fill('#pTexto', 'precio del dólar hoy en Perú'); await pg.click('#pEnviar');
  await pg.waitForSelector('.caja-groq', { timeout: 8000 });
  console.log('1) sin clave de Groq aparece la caja:', await pg.isVisible('.caja-groq'), '· aviso:', (await pg.textContent('.aviso-ia')).slice(0, 60) + '…');
  console.log('   el botón abre:', await pg.getAttribute('.caja-groq-ir', 'href'));
  await pg.locator('.caja-groq').scrollIntoViewIfNeeded();
  await pg.screenshot({ path: '/tmp/capturas/caja_groq.png' });
  await pg.fill('.caja-groq input', 'AIzaMal'); await pg.click('.caja-groq button');
  console.log('2) clave equivocada:', await pg.textContent('.caja-groq-estado'));
  await pg.fill('.caja-groq input', 'gsk_' + 'y'.repeat(40)); await pg.click('.caja-groq button');
  await pg.waitForFunction(() => /3\.75/.test(document.getElementById('pLista').textContent), null, { timeout: 8000 });
  const burbujas = await pg.locator('#pLista .burbuja').allTextContents();
  console.log('3) vuelve a preguntar y busca con Groq:', burbujas.filter((t) => /3\.75/.test(t)).length === 1, '· caja quitada:', !(await pg.isVisible('.caja-groq')));
  console.log('   preguntas del usuario en pantalla:', burbujas.filter((t) => t === 'precio del dólar hoy en Perú').length, '(debe ser 1)');
  console.log('   aviso:', await pg.locator('.aviso-ia').last().textContent(), '· fuente:', await pg.locator('.fuentes a').last().textContent());
  console.log('   clave guardada en Ajustes:', await pg.evaluate(() => localStorage.getItem('copiloto.ia.audio').slice(0, 4)), '· llamadas:', llamadas.join(' → '));
  await pg.locator('#panelIA').scrollIntoViewIfNeeded(); await pg.screenshot({ path: '/tmp/capturas/caja_groq_ok.png' });
  console.log('errores:', errores.length ? errores : 'ninguno');
  await b.close(); S.servidor.close(); process.exit(0);
})();
