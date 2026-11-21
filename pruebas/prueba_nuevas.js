'use strict';
// Pruebas de lo nuevo: Preguntale a tu IA (con y sin busqueda, 4 proveedores) y transcripcion completa en Sheets
const assert = require('assert');
const { execFileSync } = require('child_process');
process.env.SHEETS_HISTORIAL_S = '0';
process.env.GOOGLE_CLIENT_ID = 'cliente-prueba'; process.env.GOOGLE_CLIENT_SECRET = 'x'; process.env.CLAVE_CIFRADO = 'k';
process.env.PUBLIC_DIR = require('path').join(__dirname, '../servidor/public'); process.env.LIMITE_DIARIO = '50'; process.env.RATE_LIMIT_PER_MIN = '1000';
const pgfalso = require('./pgfalso');
const db = require('../servidor/src/db'); db.usar(new pgfalso.Pool());
const S = require('../servidor/src/server');
const sql = function (q) { return execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-At', '-c', q], { encoding: 'utf8' }).trim(); };
sql('truncate usuarios cascade');
const tok = 'b'.repeat(48);
sql("insert into usuarios(email, refresh_token_cifrado, hoja_id) values ('ana@gmail.com', pgp_sym_encrypt('RT','k'), 'HOJA-VIEJA'); insert into dispositivos(token_hash,email) values (digest('" + tok + "','sha256'),'ana@gmail.com')");

const realFetch = globalThis.fetch;
const reg = { llamadas: [], tx: [], hist: [], pestanas: [], encabezados: [], hojaTieneTx: false };
const R = function (st, o) { return new Response(JSON.stringify(o), { status: st }); };
globalThis.fetch = async function (url, op) {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, op);
  const body = op && op.body && typeof op.body === 'string' && op.body[0] === '{' ? JSON.parse(op.body) : null;
  reg.llamadas.push({ url: url, body: body, headers: op && op.headers });
  if (/oauth2/.test(url)) return R(200, { access_token: 'AT', expires_in: 3599 });
  if (/:batchUpdate$/.test(url)) { reg.pestanas.push(body.requests[0].addSheet.properties.title); reg.hojaTieneTx = true; return R(200, {}); }
  if (/values\/Transcripci%C3%B3n!A1\?valueInputOption/.test(url)) { reg.encabezados.push(body.values[0]); return R(200, {}); }
  if (/values\/Transcripci%C3%B3n!A1:append/.test(url)) {
    if (!reg.hojaTieneTx) return R(400, { error: { code: 400, message: 'Unable to parse range: Transcripción!A1' } });
    reg.tx = reg.tx.concat(body.values); return R(200, {});
  }
  if (/values\/Historial!A1:append/.test(url)) { reg.hist.push(body.values[0]); return R(200, {}); }
  // --- IA ---
  if (/generateContent/.test(url)) {
    if (op.headers['x-goog-api-key'] === 'GEMINI-GRATIS') return R(429, { error: { code: 429, message: 'Grounding with Google Search is not available on the free tier', status: 'RESOURCE_EXHAUSTED' } });
    assert.deepStrictEqual(body.tools, [{ google_search: {} }]);
    return R(200, { candidates: [{ content: { parts: [{ text: 'Según Google, el plan cuesta 30 USD.\n```grafico\n{"tipo":"barras","titulo":"Precios","unidad":"USD","etiquetas":["A","B"],"series":[{"nombre":"Precio","valores":[30,45]}]}\n```' }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://ejemplo.com/precios', title: 'ejemplo.com' } }, { web: { uri: 'https://ejemplo.com/precios', title: 'dup' } }] } }] });
  }
  if (/api\.groq\.com.*chat\/completions/.test(url) && body.model === 'openai/gpt-oss-120b' && body.tools && body.tools[0].type === 'browser_search') {
    return R(200, { choices: [{ message: { content: 'Groq buscó: hay 3 proveedores.', executed_tools: [{ type: 'search', search_results: { results: [{ title: 'Noticia', url: 'https://noticias.pe/x' }] } }] } }] });
  }
  if (/api\.openai\.com\/v1\/responses/.test(url)) {
    assert.deepStrictEqual(body.tools, [{ type: 'web_search' }]);
    return R(200, { output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: 'OpenAI encontró algo.', annotations: [{ type: 'url_citation', url: 'https://openai-fuente.com', title: 'Fuente OA' }] }] }] });
  }
  if (/api\.anthropic\.com\/v1\/messages/.test(url)) {
    assert.strictEqual(op.headers['x-api-key'], 'CLAUDE-K'); assert.strictEqual(body.tools[0].type, 'web_search_20250305');
    return R(200, { content: [{ type: 'server_tool_use' }, { type: 'text', text: 'Claude: ', citations: [] }, { type: 'text', text: 'dato citado.', citations: [{ url: 'https://claude-fuente.com', title: 'Fuente C' }] }] });
  }
  if (/chat\/completions/.test(url)) {
    if (body.messages[0].role === 'user') return R(200, { choices: [{ message: { content: '{"idioma":"en","traduccion":"Es muy caro","alerta":"precio","hay_compromiso":false}' } }] });
    if (/Eres el asistente personal/.test(body.messages[0].content)) return R(200, { choices: [{ message: { content: 'Respuesta sin buscar (' + body.model + ').' } }] });
    return R(200, { choices: [{ message: { content: 'DI AHORA: ok' } }] });
  }
  throw new Error('no simulada ' + url);
};

let base; let n = 0;
const ok = function (m) { n++; console.log('  ✓ ' + m); };
async function post(ruta, cuerpo) { const r = await realFetch(base + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) }); return { status: r.status, json: await r.json() }; }
const PREG = '/webhook/copiloto-preguntar';
const CHAT = '/webhook/b7d2e9a4-0002-4c22-8b02-000000000002/chat';
const pregunta = function (ia, extra) {
  return post(PREG, Object.assign({ sessionId: 'S1', appToken: tok, ia: ia, pregunta: '¿Cuánto cuesta la competencia?', buscar: true,
    transcripcion: 'CLIENTE: el otro proveedor cobra 45 dolares\nYO: entiendo', perfil: { escenario: 'Venta', objetivo: 'Cerrar', contexto: 'Vendo fibra' },
    historial: [{ rol: 'yo', texto: 'hola' }, { rol: 'ia', texto: 'hola, dime' }] }, extra || {}));
};

(async function () {
  await new Promise(function (r) { S.servidor.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + S.servidor.address().port;

  console.log('Pregúntale a tu IA');
  let r = await pregunta({ proveedor: 'gemini', clave: 'GEMINI-PAGO' });
  assert.strictEqual(r.json.ok, true); assert.ok(/30 USD/.test(r.json.respuesta) && /```grafico/.test(r.json.respuesta)); assert.strictEqual(r.json.busco, true);
  assert.deepStrictEqual(r.json.fuentes, [{ titulo: 'ejemplo.com', url: 'https://ejemplo.com/precios' }]); ok('Gemini busca en Google y devuelve fuentes (sin repetidas) y gráfico');
  const g = reg.llamadas.filter(function (c) { return /generateContent/.test(c.url); }).pop();
  assert.ok(/gemini-3\.5-flash-lite:generateContent/.test(g.url)); const ctx = g.body.contents[0].parts[0].text;
  assert.ok(/el otro proveedor cobra 45 dolares/.test(ctx) && /Vendo fibra/.test(ctx)); assert.strictEqual(g.body.contents[2].role, 'user'); assert.strictEqual(g.body.contents[3].role, 'model');
  assert.ok(/Cuánto cuesta la competencia/.test(g.body.contents[4].parts[0].text)); ok('le pasa la transcripción, el contexto y la conversación anterior');

  r = await pregunta({ proveedor: 'gemini', clave: 'GEMINI-GRATIS' });
  assert.strictEqual(r.json.ok, true); assert.strictEqual(r.json.busco, false); assert.ok(/agrega tu clave de Groq/.test(r.json.aviso) && r.json.necesita === "groq"); assert.ok(/Respuesta sin buscar \(gemini-3\.5-flash-lite\)/.test(r.json.respuesta));
  ok('Gemini gratis sin búsqueda -> responde igual y avisa');
  r = await pregunta({ proveedor: 'groq', clave: 'G' });
  assert.ok(/Groq buscó/.test(r.json.respuesta)); assert.strictEqual(r.json.fuentes[0].url, 'https://noticias.pe/x'); ok('Groq busca con browser_search (gpt-oss-120b)');
  r = await pregunta({ proveedor: 'openai', clave: 'O' });
  assert.strictEqual(r.json.respuesta, 'OpenAI encontró algo.'); assert.strictEqual(r.json.fuentes[0].titulo, 'Fuente OA'); ok('OpenAI usa web_search de la Responses API');
  r = await pregunta({ proveedor: 'claude', clave: 'CLAUDE-K' });
  assert.strictEqual(r.json.respuesta, 'Claude: dato citado.'); assert.strictEqual(r.json.fuentes[0].url, 'https://claude-fuente.com'); ok('Claude usa su herramienta web_search');
  r = await pregunta({ proveedor: 'groq', clave: 'G' }, { buscar: false });
  assert.ok(/Respuesta sin buscar \(openai\/gpt-oss-20b\)/.test(r.json.respuesta)); assert.strictEqual(r.json.busco, false); assert.strictEqual(r.json.aviso, ''); ok('sin "buscar en internet" usa el modelo normal');
  r = await pregunta({ proveedor: 'gemini', clave: '' });
  assert.strictEqual(r.json.ok, false); assert.ok(/Falta configurar tu IA/.test(r.json.error)); ok('sin clave -> pide configurarla');
  r = await post(PREG, { sessionId: 'S1', appToken: 'x', ia: { proveedor: 'groq', clave: 'G' }, pregunta: 'hola' });
  assert.ok(/conecta tu cuenta de Google/.test(r.json.error)); ok('sin cuenta -> pide conectar Google');
  await new Promise(function (ok2) { setTimeout(ok2, 200); });
  assert.strictEqual(sql("select analisis from uso_diario where email='ana@gmail.com'"), '6'); ok('cada pregunta cuenta en el límite diario');
  assert.strictEqual(reg.hist.filter(function (h) { return h[3] === 'pregunta'; }).length, 6);
  assert.ok(reg.hist.some(function (h) { return /Fuentes: https:\/\/ejemplo\.com\/precios/.test(h[5]); })); ok('las preguntas y respuestas quedan en el historial de Sheets, con fuentes');

  console.log('Transcripción completa');
  await post(CHAT, { sessionId: 'S1', chatInput: 'YO: buenos días\nCLIENTE: [John] it is too expensive', appToken: tok, metadata: { appToken: tok, ia: { proveedor: 'groq', clave: 'G' } } });
  await post(CHAT, { sessionId: 'S1', chatInput: 'CLIENTE: ok', appToken: tok, metadata: { appToken: tok, ia: { proveedor: 'groq', clave: 'G' } } });
  assert.strictEqual(reg.tx.length, 0); ok('junta las líneas y no escribe en cada mensaje');
  await post(CHAT, { sessionId: 'S1', chatInput: 'cierra reunion', appToken: tok, metadata: { appToken: tok, ia: { proveedor: 'groq', clave: 'G' } } });
  await new Promise(function (ok2) { setTimeout(ok2, 300); });
  assert.deepStrictEqual(reg.pestanas, ['Transcripción']); assert.deepStrictEqual(reg.encabezados[0], ['fecha', 'idReunion', 'quien', 'texto', 'traduccion']);
  ok('en una hoja vieja crea sola la pestaña "Transcripción" con encabezados');
  assert.strictEqual(reg.tx.length, 3);
  assert.deepStrictEqual(reg.tx.map(function (f) { return f.slice(1, 5); }), [['S1', 'YO', 'buenos días', ''], ['S1', 'CLIENTE', '[John] it is too expensive', 'Es muy caro'], ['S1', 'CLIENTE', 'ok', 'Es muy caro']]);
  ok('al cerrar la reunión manda toda la transcripción, en orden, con quién habló y la traducción');
  await post(CHAT, { sessionId: 'S2', chatInput: 'CLIENTE: hola de nuevo, otra reunión', appToken: tok, metadata: { appToken: tok, ia: { proveedor: 'groq', clave: 'G' } } });
  assert.strictEqual(S.transcripciones.get('ana@gmail.com').filas.length, 1);
  await S.enviarTranscripcion('ana@gmail.com');
  assert.strictEqual(reg.tx.length, 4); assert.deepStrictEqual(reg.pestanas, ['Transcripción']); ok('la siguiente vez ya no vuelve a crear la pestaña');
  await post(CHAT, { sessionId: 'S3', chatInput: 'CLIENTE: sin clave', appToken: tok, metadata: { appToken: tok, ia: { proveedor: 'groq', clave: '' } } });
  assert.ok(!S.transcripciones.has('ana@gmail.com')); ok('si el mensaje no se procesa (falta clave), no se anota');

  console.log('\nTodo bien: ' + n + ' comprobaciones');
  S.servidor.close(); process.exit(0);
})().catch(function (e) { console.error('\nFALLÓ:', e && e.stack || e); process.exit(1); });
