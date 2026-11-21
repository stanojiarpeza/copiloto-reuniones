'use strict';
// Prueba de punta a punta del servidor con Postgres local, Google e IA simulados.
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.SHEETS_HISTORIAL_S = '0'; process.env.SHEETS_TX_S = '0';
process.env.GOOGLE_CLIENT_ID = 'cliente-prueba.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secreto-prueba';
process.env.CLAVE_CIFRADO = 'clave-cifrado-prueba';
process.env.ALLOWED_ORIGINS = 'https://otra-app.example.com';
process.env.PUBLIC_DIR = process.env.PUBLIC_DIR || require('path').join(__dirname, '../servidor/public');
process.env.LIMITE_DIARIO = '8';
process.env.MAX_CUENTAS = '2';
process.env.RATE_LIMIT_PER_MIN = '1000';

const SRV = require('path').join(__dirname, '../servidor/src/') + '/';
const pgfalso = require('./pgfalso');
const db = require(SRV + 'db');
db.usar(new pgfalso.Pool());
const { servidor, sesiones, accesos } = require(SRV + 'server');

function sql(q) { return execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', 'postgres', '-At', '-c', q], { encoding: 'utf8' }).trim(); }
sql('truncate usuarios cascade');

// ---------- Google e IA simulados ----------
const realFetch = globalThis.fetch;
const registro = { ia: [], filas: [], tokens: 0, refrescos: 0, hojas: 0 };
function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function resp(status, obj) { return new Response(JSON.stringify(obj), { status: status, headers: { 'Content-Type': 'application/json' } }); }

globalThis.fetch = async function (url, op) {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, op);
  if (url === 'https://oauth2.googleapis.com/token') {
    const p = new URLSearchParams(op.body);
    if (p.get('grant_type') === 'authorization_code') {
      registro.tokens++;
      const code = p.get('code');
      if (code === 'malo') return resp(400, { error: 'invalid_grant', error_description: 'Bad Request' });
      const email = code.split('|')[0];
      const sinDrive = code.includes('sindrive');
      return resp(200, {
        access_token: 'AT-' + email, expires_in: 3599, refresh_token: code.includes('sinrt') ? undefined : 'RT-' + email,
        scope: 'openid https://www.googleapis.com/auth/userinfo.email' + (sinDrive ? '' : ' https://www.googleapis.com/auth/drive.file'),
        id_token: b64({ alg: 'none' }) + '.' + b64({ aud: process.env.GOOGLE_CLIENT_ID, email: email, email_verified: true }) + '.firma'
      });
    }
    registro.refrescos++;
    assert.ok(p.get('refresh_token').startsWith('RT-'), 'se descifra la llave guardada');
    return resp(200, { access_token: 'AT2-' + p.get('refresh_token'), expires_in: 3599 });
  }
  if (url === 'https://sheets.googleapis.com/v4/spreadsheets') { registro.hojas++; return resp(200, { spreadsheetId: 'HOJA-' + registro.hojas }); }
  if (/\/values\/Historial!A1:F1/.test(url) || /Transcripci%C3%B3n!A1\?valueInputOption/.test(url)) return resp(200, {});
  if (/Transcripci%C3%B3n!A1:append/.test(url)) return resp(200, {});
  if (/:append\?/.test(url)) { registro.filas.push({ url: url, auth: op.headers.Authorization, fila: JSON.parse(op.body).values[0] }); return resp(200, {}); }
  if (/chat\/completions/.test(url)) {
    const body = JSON.parse(op.body);
    const clave = op.headers.Authorization.replace('Bearer ', '');
    registro.ia.push({ url: url, clave: clave, body: body });
    if (clave === 'MALA') return resp(401, { error: { message: 'Invalid API Key', type: 'invalid_request_error' } });
    if (clave === 'LIMITE') return resp(429, { error: { message: 'Rate limit reached for model', type: 'tokens' } });
    if (body.messages[0].role === 'user') {
      const t = body.messages[0].content;
      const txt = t.split('TEXTO: """')[1].split('"""')[0];
      let c = { idioma: 'es', traduccion: null, alerta: 'ninguna', motivo: null, hay_compromiso: false, accion: null, responsable: null, fecha: null, hora: null, confianza: 0 };
      if (/caro|descuento/i.test(txt)) c.alerta = 'precio';
      if (/Preis/.test(txt)) { c.idioma = 'de'; c.traduccion = 'El precio es demasiado alto'; c.alerta = 'precio'; }
      if (/viernes/i.test(txt)) { c.hay_compromiso = true; c.accion = 'Enviar la propuesta'; c.responsable = 'YO'; c.fecha = '2099-11-20'; c.hora = '15:00'; c.confianza = 0.9; }
      return resp(200, { choices: [{ message: { content: 'Aqui va: ' + JSON.stringify(c) } }] });
    }
    const modo = /MODO: (\w+)/.exec(body.messages[1].content)[1];
    return resp(200, { choices: [{ message: { content: 'DI AHORA: respuesta ' + modo + ' #' + registro.ia.length } }] });
  }
  throw new Error('URL no simulada: ' + url);
};

// ---------- Ayudas ----------
let base;
async function post(ruta, cuerpo, cab) {
  const r = await realFetch(base + ruta, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, cab || {}), body: JSON.stringify(cuerpo) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t, headers: r.headers };
}
const CHAT = '/webhook/b7d2e9a4-0002-4c22-8b02-000000000002/chat';
function chat(sessionId, texto, token, ia, perfil) {
  return post(CHAT, { action: 'sendMessage', sessionId: sessionId, chatInput: texto, appToken: token, metadata: { appToken: token, ia: ia, perfil: perfil || {} } });
}
const espera = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let pasos = 0;
function ok(msg) { pasos++; console.log('  ✓ ' + msg); }

(async function () {
  await new Promise(function (r) { servidor.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + servidor.address().port;
  const IA = { proveedor: 'gemini', clave: 'AIza-PRUEBA', modelo: '' };

  console.log('Archivos de la app y salud');
  let r = await realFetch(base + '/'); let t = await r.text();
  assert.strictEqual(r.status, 200); assert.ok(/Copiloto de Reuniones/.test(t)); assert.strictEqual(r.headers.get('cache-control'), 'no-cache'); ok('sirve index.html sin caché');
  r = await realFetch(base + '/icon-192.png'); assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('content-type'), 'image/png'); ok('sirve íconos');
  r = await realFetch(base + '/../../etc/passwd'); assert.notStrictEqual(r.status, 200); ok('no deja salir de la carpeta de la app');
  r = await realFetch(base + '/healthz'); assert.deepStrictEqual(await r.json(), { status: 'ok' }); ok('/healthz responde ok');

  console.log('Conectar Google');
  r = await post('/webhook/copiloto-conectar', { code: 'malo' });
  assert.strictEqual(r.status, 400); assert.ok(/no aceptó el código/.test(r.json.error)); ok('código inválido -> error claro');
  r = await post('/webhook/copiloto-conectar', { code: 'ana@gmail.com|sindrive' });
  assert.strictEqual(r.status, 400); assert.ok(/permiso de Google Drive/.test(r.json.error)); ok('sin casilla de Drive -> aviso');
  r = await post('/webhook/copiloto-conectar', { code: 'Ana@Gmail.com|1' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ok, true); assert.strictEqual(r.json.email, 'ana@gmail.com'); assert.strictEqual(r.json.hojaId, 'HOJA-1');
  assert.ok(/^[0-9a-f]{48}$/.test(r.json.appToken)); const tokAna = r.json.appToken; ok('conecta, crea hoja y entrega token de equipo');
  assert.ok(!/RT-ana/.test(sql("select encode(refresh_token_cifrado,'escape') from usuarios where email='ana@gmail.com'"))); ok('la llave de Google queda cifrada en la base');
  r = await post('/webhook/copiloto-conectar', { code: 'ana@gmail.com|sinrt' });
  assert.strictEqual(r.json.ok, true); assert.strictEqual(r.json.hojaId, 'HOJA-1'); assert.strictEqual(registro.hojas, 1); const tokAna2 = r.json.appToken;
  ok('reconectar desde otro equipo reutiliza la hoja y la llave anterior');
  assert.strictEqual(sql("select count(*) from dispositivos where email='ana@gmail.com'"), '2'); ok('cada equipo tiene su propio token');
  r = await post('/webhook/copiloto-conectar', { code: 'beto@gmail.com|1' }); const tokBeto = r.json.appToken; assert.strictEqual(r.json.ok, true);
  r = await post('/webhook/copiloto-conectar', { code: 'carla@gmail.com|1' });
  assert.strictEqual(r.status, 400); assert.ok(/máximo de 2 cuentas/.test(r.json.error)); ok('respeta el cupo máximo de cuentas');

  console.log('Copiloto: accesos');
  r = await chat('S1', 'CLIENTE: hola', 'token-falso', IA);
  assert.ok(/conecta tu cuenta de Google/.test(r.json.output)); ok('sin cuenta -> pide conectar Google');
  r = await chat('S1', 'CLIENTE: hola', tokAna, { proveedor: 'gemini', clave: '' });
  assert.ok(/Falta configurar tu IA/.test(r.json.output)); ok('sin clave de IA -> pide configurarla');
  assert.strictEqual(sql("select count(*) from sesiones"), '0'); ok('esos casos no guardan nada');

  console.log('Copiloto: reunión normal');
  registro.ia = [];
  r = await chat('S1', 'CLIENTE: me parece caro, ¿tienen descuento?', tokAna, IA, { escenario: 'Venta de fibra', objetivo: 'Cerrar plan', contexto: 'Vendo internet', enfoque: 'cierre' });
  assert.strictEqual(r.status, 200);
  assert.ok(/^DI AHORA: respuesta en_vivo/.test(r.json.output), r.json.output); ok('responde la sugerencia en vivo');
  assert.strictEqual(registro.ia.length, 2); assert.ok(registro.ia[0].url.includes('generativelanguage')); assert.strictEqual(registro.ia[0].body.model, 'gemini-3.5-flash-lite');
  assert.strictEqual(registro.ia[0].clave, 'AIza-PRUEBA'); ok('usa la IA y la clave de la persona (Gemini Flash-Lite)');
  const vivo = registro.ia[1].body;
  assert.ok(/ENFOQUE cierre/.test(vivo.messages[0].content) && !/MODO cierre: la reunion termino/.test(vivo.messages[0].content)); assert.strictEqual(vivo.max_tokens, 300);
  assert.ok(/ALERTA: precio/.test(vivo.messages[1].content) && /ESCENARIO: Venta de fibra/.test(vivo.messages[1].content)); ok('en vivo manda las instrucciones cortas, con alerta y perfil');
  await espera(150);
  assert.strictEqual(registro.filas.length, 1); assert.strictEqual(registro.filas[0].fila[1], 'S1'); assert.strictEqual(registro.filas[0].fila[3], 'en_vivo');
  assert.ok(/HOJA-1/.test(registro.filas[0].url)); assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(registro.filas[0].fila[0])); ok('guarda la fila en el Sheets de la persona');
  assert.strictEqual(sql("select analisis from uso_diario where email='ana@gmail.com'"), '1'); ok('suma 1 al uso del día');
  assert.strictEqual(sql("select jsonb_array_length(sugerencias) from sesiones where session_id='S1'"), '1'); ok('recuerda la sugerencia');

  pgfalso.limpiar();
  r = await chat('S1', 'YO: entiendo, te envío la propuesta el viernes a las 3 pm', tokAna, IA);
  assert.ok(/Anotado lo que dijiste/.test(r.json.output)); assert.ok(/RECORDATORIO GUARDADO: Enviar la propuesta \| YO \| 2099-11-20 15:00/.test(r.json.output));
  assert.ok(/RECORDATORIO FECHA: 2099-11-20T15:00:00\.000-05:00 \| 2099-11-20T15:30:00\.000-05:00 \| Enviar la propuesta \| YO/.test(r.json.output), r.json.output);
  ok('compromiso de YO con fecha -> recordatorio con enlace a calendario (hora de Lima)');
  const leidas = pgfalso.llamadas().filter(function (c) { return /from dispositivos d/.test(c.sql); });
  assert.strictEqual(leidas.length, 1); assert.strictEqual(leidas[0].params[2], false); ok('la reunión en curso sale de la memoria (no relee la transcripción)');

  r = await chat('S1', 'CLIENTE: ok', tokAna, IA);
  assert.ok(/frase muy corta/.test(r.json.output)); ok('frase corta del cliente -> no gasta análisis');
  r = await chat('S1', 'CLIENTE: Der Preis ist zu hoch für uns', tokAna, IA);
  assert.ok(/^TRADUCCION \(aleman\): El precio es demasiado alto\n\nDI AHORA/.test(r.json.output)); ok('otro idioma -> traducción + sugerencia');
  const tr = JSON.parse(sql("select transcripcion from sesiones where session_id='S1'"));
  assert.ok(tr.some(function (x) { return /CLIENTE \[aleman\]: Der Preis.*\(en espanol: El precio es demasiado alto\)/.test(x); })); ok('la transcripción guarda original y traducción');

  await espera(100);
  registro.ia = [];
  r = await chat('S1', 'CLIENTE: y cuanto cuesta el plan anual completo', tokAna, IA);
  const prev = registro.ia[1].body.messages[1].content.split('TUS ULTIMAS SUGERENCIAS (no las repitas):\n')[1];
  assert.ok(/^1\) DI AHORA: respuesta en_vivo/.test(prev) && /\n2\) TRADUCCION \(aleman\)/.test(prev), prev);
  ok('pasa las 2 sugerencias más recientes, en orden, para no repetirse');
  await espera(150);
  const sugs = JSON.parse(sql("select sugerencias from sesiones where session_id='S1'"));
  assert.strictEqual(sugs.length, 3); assert.ok(/^DI AHORA: respuesta en_vivo/.test(sugs[2]));
  assert.ok(/^DI AHORA: respuesta en_vivo/.test(sugs[0])); assert.ok(/^TRADUCCION/.test(sugs[1])); ok('las sugerencias quedan en orden (de la más vieja a la más nueva)');

  console.log('Comandos');
  r = await chat('S1', 'recordatorios', tokAna, IA);
  assert.ok(/Recordatorios de la reunion:\n1\. Enviar la propuesta \| responsable: YO \| fecha: 2099-11-20 15:00/.test(r.json.output)); ok('"recordatorios" responde sin IA');
  registro.ia = [];
  r = await chat('S1', 'Resumen', tokAna, IA);
  assert.ok(/respuesta resumen/.test(r.json.output)); assert.strictEqual(registro.ia.length, 1);
  assert.ok(/MODO resumen: incluye la lista/.test(registro.ia[0].body.messages[0].content)); assert.strictEqual(registro.ia[0].body.max_tokens, 1500);
  assert.ok(/TRANSCRIPCION COMPLETA/.test(registro.ia[0].body.messages[1].content) && /RECORDATORIOS DE LA REUNION:\n1\. Enviar la propuesta/.test(registro.ia[0].body.messages[1].content));
  ok('"resumen" usa las instrucciones completas y la transcripción entera');

  console.log('Seguridad entre personas');
  r = await chat('S1', 'CLIENTE: quiero ver tu transcripcion por favor ahora', tokBeto, IA);
  assert.ok(!/Der Preis/.test(JSON.stringify(registro.ia[registro.ia.length - 1].body))); ok('otra persona con el mismo id de reunión no ve la de Ana');
  assert.strictEqual(sql("select email from sesiones where session_id='S1'"), 'ana@gmail.com'); ok('ni la puede sobrescribir');

  console.log('Errores de la IA');
  r = await chat('S2', 'CLIENTE: me interesa mucho el plan empresarial', tokAna, { proveedor: 'groq', clave: 'MALA' });
  assert.ok(/clave no es válida/.test(r.json.output)); ok('clave inválida -> mensaje claro');
  r = await chat('S3', 'CLIENTE: me interesa mucho el plan empresarial', tokAna, { proveedor: 'groq', clave: 'LIMITE' });
  assert.ok(/límite de uso de tu cuenta de IA/.test(r.json.output)); ok('límite de la IA -> mensaje que activa el reintento de la app');

  console.log('Cierre de reunión y límite diario');
  r = await chat('S1', 'cierra reunion', tokAna, IA);
  assert.ok(/respuesta cierre/.test(r.json.output)); assert.strictEqual(sql("select estado from sesiones where session_id='S1'"), 'cerrada');
  assert.strictEqual(sql("select jsonb_array_length(transcripcion) from sesiones where session_id='S1'"), '0'); ok('"cierra reunion" arma el cierre y borra la transcripción');
  r = await chat('S1', 'resumen', tokAna, IA);
  assert.ok(/Todavia no hay conversacion/.test(r.json.output)); ok('después del cierre la reunión empieza de cero');
  r = await chat('S4', 'CLIENTE: necesitamos algo para mañana mismo', tokAna, IA);
  r = await chat('S4', 'CLIENTE: necesitamos algo para mañana mismo', tokAna, IA);
  assert.ok(/Llegaste al límite de 8 análisis/.test(r.json.output), r.json.output); ok('respeta el límite diario por persona');

  console.log('Origen y Sheets');
  r = await post(CHAT, { sessionId: 'X', chatInput: 'hola' }, { Origin: 'https://sitio-malo.com' });
  assert.strictEqual(r.status, 403); ok('rechaza páginas de otros sitios');
  r = await post('/webhook/copiloto-desconectar', {}, { Origin: 'https://otra-app.example.com' });
  assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://otra-app.example.com'); ok('permite los dominios de ALLOWED_ORIGINS');
  const dueños = {}; registro.filas.forEach(function (f) { const k = f.auth.toLowerCase(); dueños[k] = (dueños[k] || 0) + 1; });
  assert.strictEqual(registro.refrescos, Object.keys(dueños).length, 'refrescos=' + registro.refrescos);
  ok('reutiliza el acceso a Sheets: ' + registro.refrescos + ' renovaciones para ' + registro.filas.length + ' filas de ' + Object.keys(dueños).length + ' personas');
  console.log('    filas por persona:', JSON.stringify(dueños));
  assert.ok(dueños['bearer at2-rt-ana@gmail.com'] >= 5 && dueños['bearer at2-rt-beto@gmail.com'] === 1); ok('cada fila va al Sheets de su dueño, con su propio acceso');
  assert.ok(registro.filas.filter(function (f) { return f.auth.includes('beto'); }).every(function (f) { return /HOJA-2/.test(f.url); })); ok('la fila de Beto va a la hoja de Beto');

  console.log('Desconectar');
  r = await post('/webhook/copiloto-desconectar', { appToken: tokAna2 });
  assert.deepStrictEqual(r.json, { ok: true, email: 'ana@gmail.com', cuentaBorrada: false });
  assert.strictEqual(sql("select count(*) from dispositivos where email='ana@gmail.com'"), '1'); ok('desconectar quita solo este equipo');
  r = await post('/webhook/copiloto-desconectar', { appToken: tokAna, borrarTodo: true });
  assert.strictEqual(r.json.cuentaBorrada, true);
  assert.strictEqual(sql("select count(*) from usuarios where email='ana@gmail.com'") + sql("select count(*) from sesiones where email='ana@gmail.com'") + sql("select count(*) from uso_diario where email='ana@gmail.com'"), '000');
  assert.ok(!accesos.has('ana@gmail.com')); ok('borrar cuenta elimina usuario, reuniones, uso y accesos en memoria');
  r = await chat('S9', 'CLIENTE: hola de nuevo amigos', tokAna, IA);
  assert.ok(/conecta tu cuenta de Google/.test(r.json.output)); ok('el token borrado ya no sirve');

  console.log('\nTodo bien: ' + pasos + ' comprobaciones');
  servidor.close(); process.exit(0);
})().catch(function (e) { console.error('\nFALLÓ:', e && e.stack || e); process.exit(1); });
