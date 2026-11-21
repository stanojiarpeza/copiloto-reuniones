'use strict';
// Ajustes para 100 personas: limite por persona (no por IP) y escrituras a Sheets por lotes
const assert = require('assert');
const { execFileSync } = require('child_process');
process.env.GOOGLE_CLIENT_ID = 'c'; process.env.GOOGLE_CLIENT_SECRET = 'x'; process.env.CLAVE_CIFRADO = 'k';
process.env.PUBLIC_DIR = require('path').join(__dirname, '../servidor/public'); process.env.RATE_LIMIT_PER_MIN = '5'; process.env.RATE_LIMIT_IP_PER_MIN = '1000';
process.env.SHEETS_HISTORIAL_S = '20'; process.env.SHEETS_TX_S = '25';
const pgfalso = require('./pgfalso');
const db = require('../servidor/src/db'); db.usar(new pgfalso.Pool());
const S = require('../servidor/src/server');
const sql = function (q) { return execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-At', '-c', q], { encoding: 'utf8' }).trim(); };
sql('truncate usuarios cascade');
const toks = [];
for (let i = 0; i < 30; i++) { const t = String(i).padStart(2, '0').repeat(24); toks.push(t);
  sql("insert into usuarios(email, refresh_token_cifrado, hoja_id) values ('u" + i + "@x.com', pgp_sym_encrypt('RT" + i + "','k'), 'H" + i + "'); insert into dispositivos(token_hash,email) values (digest('" + t + "','sha256'),'u" + i + "@x.com')"); }
const realFetch = globalThis.fetch; const R = function (s, o) { return new Response(JSON.stringify(o), { status: s }); };
const escrituras = []; let primera429 = true;
globalThis.fetch = async function (url, op) {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, op);
  if (/oauth2/.test(url)) return R(200, { access_token: 'AT-' + new URLSearchParams(op.body).get('refresh_token'), expires_in: 3599 });
  if (/:append/.test(url)) {
    if (/H7\//.test(url) && primera429) { primera429 = false; return R(429, { error: { message: 'Quota exceeded' } }); }
    escrituras.push({ hoja: /spreadsheets\/(H\d+)/.exec(url)[1], pestana: /Historial/.test(url) ? 'H' : 'T', n: JSON.parse(op.body).values.length }); return R(200, {});
  }
  if (/sheets/.test(url)) return R(200, {});
  const b = JSON.parse(op.body);
  if (b.messages[0].role === 'user') return R(200, { choices: [{ message: { content: '{"idioma":"es","alerta":"precio","hay_compromiso":false}' } }] });
  return R(200, { choices: [{ message: { content: 'DI AHORA: ok' } }] });
};
const ok = function (m) { console.log('  ✓ ' + m); };
(async function () {
  await new Promise(function (r) { S.servidor.listen(0, '127.0.0.1', r); });
  const URL = 'http://127.0.0.1:' + S.servidor.address().port + '/webhook/b7d2e9a4-0002-4c22-8b02-000000000002/chat';
  const chat = function (i, texto) { return realFetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'S' + i, chatInput: texto, metadata: { appToken: toks[i], ia: { proveedor: 'groq', clave: 'g' } } }) }).then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); }); };

  console.log('Límite por persona, no por dirección');
  const r1 = await Promise.all([0, 1, 2, 3, 4].map(function (k) { return chat(0, 'CLIENTE: me parece caro el plan número ' + k); }));
  const r6 = await chat(0, 'CLIENTE: y otra pregunta más sobre el precio');
  assert.ok(r1.every(function (r) { return r.status === 200; })); assert.strictEqual(r6.status, 429); ok('una persona que manda demasiado seguido se frena');
  const otros = await Promise.all([1, 2, 3].map(function (i) { return chat(i, 'CLIENTE: me parece caro el plan'); }));
  assert.ok(otros.every(function (r) { return r.status === 200 && /DI AHORA/.test(r.j.output); })); ok('las demás personas de la misma oficina (misma dirección) siguen sin problema');

  console.log('30 personas a la vez y escrituras por lotes');
  const t0 = Date.now();
  const lote = []; for (let i = 4; i < 30; i++) for (let k = 0; k < 3; k++) lote.push(chat(i, 'CLIENTE: necesitamos internet para ' + (k + 10) + ' personas en la oficina'));
  const res = await Promise.all(lote);
  assert.ok(res.every(function (r) { return r.status === 200 && /DI AHORA/.test(r.j.output); }), 'todas responden');
  ok(lote.length + ' mensajes de 26 personas respondidos en ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  assert.strictEqual(escrituras.length, 0); ok('todavía no escribe en Sheets: junta las filas');
  await new Promise(function (r) { setTimeout(r, 26000); });
  const hist = escrituras.filter(function (e) { return e.pestana === 'H'; }), tx = escrituras.filter(function (e) { return e.pestana === 'T'; });
  const filasH = hist.reduce(function (a, e) { return a + e.n; }, 0), filasT = tx.reduce(function (a, e) { return a + e.n; }, 0);
  ok('historial: ' + filasH + ' filas en ' + hist.length + ' escrituras · transcripción: ' + filasT + ' filas en ' + tx.length + ' escrituras (sin lotes serían ' + (filasH + filasT) + ')');
  assert.ok(hist.length <= 30 && tx.length <= 30);
  await new Promise(function (r) { setTimeout(r, 16000); });
  assert.ok(escrituras.some(function (e) { return e.hoja === 'H7'; })); ok('si Google dice "límite por minuto", espera y reintenta: la fila de la persona 7 llegó igual');
  console.log('\nTodo bien'); S.servidor.close(); process.exit(0);
})().catch(function (e) { console.error('FALLÓ', e && e.stack || e); process.exit(1); });
