'use strict';
// La app v17 en Chrome real, servida por el servidor Node.js (IA y Google simulados, Postgres local)
process.env.GOOGLE_CLIENT_ID = 'cliente-prueba'; process.env.GOOGLE_CLIENT_SECRET = 'x'; process.env.CLAVE_CIFRADO = 'k';
process.env.PUBLIC_DIR = require('path').join(__dirname, '../servidor/public');
const { execFileSync } = require('child_process');
const pgfalso = require('./pgfalso');
const db = require('../servidor/src/db'); db.usar(new pgfalso.Pool());
const { servidor } = require('../servidor/src/server');
const sql = function (q) { return execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-At', '-c', q], { encoding: 'utf8' }).trim(); };
sql('truncate usuarios cascade');
const tok = 'a'.repeat(48);
sql("insert into usuarios(email, refresh_token_cifrado, hoja_id) values ('ana@gmail.com', pgp_sym_encrypt('RT','k'), 'HOJA'); insert into dispositivos(token_hash,email) values (digest('" + tok + "','sha256'),'ana@gmail.com')");
const realFetch = globalThis.fetch;
globalThis.fetch = async function (url, op) {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, op);
  const r = function (o) { return new Response(JSON.stringify(o), { status: 200 }); };
  if (/chat\/completions/.test(url)) {
    const b = JSON.parse(op.body);
    if (b.messages[0].role === 'user') return r({ choices: [{ message: { content: '{"idioma":"es","alerta":"precio","hay_compromiso":false}' } }] });
    return r({ choices: [{ message: { content: 'ALERTA: precio - objeción inicial\nDI AHORA: Entiendo, ¿qué estás comparando?\nPREGUNTA AHORA: ¿Qué resultado esperas?' } }] });
  }
  if (/oauth2/.test(url)) return r({ access_token: 'AT', expires_in: 3599 });
  return r({});
};
(async function () {
  await new Promise(function (ok) { servidor.listen(0, '127.0.0.1', ok); });
  const base = 'http://127.0.0.1:' + servidor.address().port;
  const { chromium } = require('playwright');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const pg = await b.newPage(); const errores = [];
  pg.on('pageerror', function (e) { errores.push(e.message); });
  await pg.addInitScript(function (a) {
    localStorage.setItem('copiloto.cuenta.email', 'ana@gmail.com'); localStorage.setItem('copiloto.cuenta.hojaId', 'HOJA'); localStorage.setItem('copiloto.cuenta.token', a.tok);
    localStorage.setItem('copiloto.ia.proveedor', 'gemini'); localStorage.setItem('copiloto.ia.clave', 'AIza-PRUEBA');
    localStorage.setItem('copiloto.url', a.url);
    localStorage.setItem('copiloto.pf.escenario', 'Venta'); localStorage.setItem('copiloto.pf.objetivo', 'Cerrar');
  }, { tok: tok, url: base + '/webhook/b7d2e9a4-0002-4c22-8b02-000000000002/chat' });
  await pg.goto(base + '/');
  await pg.waitForTimeout(800);
  await pg.fill('#textoManual', 'CLIENTE: me parece caro, ¿tienen descuento?');
  await pg.click('#formManual button[type=submit]');
  await pg.waitForFunction(function () { return /DI AHORA/.test(document.getElementById('consejoCuerpo').innerText); }, null, { timeout: 15000 });
  const consejo = await pg.innerText('#consejoCuerpo');
  const envio = await pg.innerText('#envio');
  console.log('Consejo en pantalla:\n' + consejo.trim());
  console.log('Estado:', envio);
  console.log('Fila en Supabase:', sql("select analisis || ' análisis, ' || jsonb_array_length(transcripcion) || ' turnos' from sesiones"));
  console.log('Errores de la página:', errores.length ? errores : 'ninguno');
  await b.close(); servidor.close(); process.exit(0);
})().catch(function (e) { console.error('FALLÓ', e); process.exit(1); });
