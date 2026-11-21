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
  const errores = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', function (e) { errores.push(e.message); });
  await pg.addInitScript(function (a) {
    if (localStorage.getItem('copiloto.url')) return;
    localStorage.setItem('copiloto.url', a.u);
    localStorage.setItem('copiloto.cuenta.email', 'ana@ejemplo.com'); localStorage.setItem('copiloto.cuenta.hojaId', 'HOJA123'); localStorage.setItem('copiloto.cuenta.token', a.t);
    localStorage.setItem('copiloto.ia.proveedor', 'groq'); localStorage.setItem('copiloto.ia.clave', 'gsk_' + 'x'.repeat(40));
    localStorage.setItem('copiloto.guia.vista', '1'); localStorage.setItem('copiloto.pf.escenario', 'Venta'); localStorage.setItem('copiloto.pf.objetivo', 'Cerrar');
  }, { u: URLCHAT, t: tok });
  await pg.goto(base + '/'); await pg.waitForTimeout(800);
  const id1 = await pg.textContent('#sesion');
  await pg.fill('#textoManual', 'me parece caro, ¿tienen descuento?');
  await pg.press('#textoManual', 'Enter');
  await pg.waitForTimeout(2500);
  const lineas1 = await pg.evaluate(function () { return JSON.parse(localStorage.getItem('copiloto.tx.' + document.getElementById('sesion').textContent) || '[]').length; });
  await pg.reload(); await pg.waitForTimeout(800);
  const id2 = await pg.textContent('#sesion');
  const aviso = await pg.locator('#turnos .separador').allTextContents();
  console.log('misma reunión tras recargar:', id1 === id2, '· líneas antes:', lineas1, '· aviso:', aviso);
  console.log('panel transcripción:', await pg.textContent('#txTotal').catch(function () { return '?'; }));
  await pg.screenshot({ path: '/tmp/capturas/retomar.png' });
  await pg.click('#turnos .separador button');
  await pg.waitForTimeout(300);
  const id3 = await pg.textContent('#sesion');
  console.log('empezar una nueva cambia el ID:', id3 !== id2, '· aviso quitado:', (await pg.locator('#turnos .separador').allTextContents()));
  // simular 3 horas despues
  await pg.evaluate(function () { var g = JSON.parse(localStorage.getItem('copiloto.sesion.actual')); g.t -= 3 * 3600 * 1000; localStorage.setItem('copiloto.sesion.actual', JSON.stringify(g)); });
  await pg.reload(); await pg.waitForTimeout(800);
  console.log('después de 3 horas empieza otra:', (await pg.textContent('#sesion')) !== id3);
  console.log('errores:', errores.length ? errores : 'ninguno');
  await b.close(); S.servidor.close(); process.exit(0);
})();
