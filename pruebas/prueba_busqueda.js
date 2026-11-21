'use strict';
const X = require('../servidor/src/externos');
const R = (o, st) => new Response(JSON.stringify(o), { status: st || 200 });
let llamadas = [];
globalThis.fetch = async function (url, op) {
  url = String(url); const b = JSON.parse(op.body); llamadas.push(url.includes('groq') ? 'groq:' + b.model : url.includes(':generateContent') ? 'gemini-buscar' : 'gemini-normal');
  if (url.includes(':generateContent')) return R({ error: { code: 400, message: 'Search Grounding is not supported for free tier', status: 'FAILED_PRECONDITION' } }, 400);
  if (url.includes('groq') && b.tools && b.messages.length !== 1) return R({ error: { message: 'messages must be a single user turn' } }, 400);
  if (url.includes('groq') && b.model === 'openai/gpt-oss-120b' && b.tools && b.tools[0].type === 'browser_search') return R({ choices: [{ message: { content: 'El plan más barato cuesta 30 USD.【1†L13-L18】', executed_tools: [{ search_results: { results: [{ title: 'comparador.pe', url: 'https://comparador.pe' }] } }] } }] });
  return R({ choices: [{ message: { content: 'Respuesta sin buscar.' } }] });
};
let fallas = 0; const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fallas++; };
(async () => {
  const msgs = [{ role: 'user', content: 'precios de fibra' }];
  llamadas = [];
  let r = await X.preguntarIA({ proveedor: 'gemini', clave: 'AIzaX', claveGroq: 'gsk_abc' }, 'sis', msgs, true);
  ok(r.busco && /30 USD\.$/.test(r.texto) && r.fuentes.length === 1 && /Groq/.test(r.aviso), 'Gemini gratis + clave de Groq: busca con Groq y muestra la fuente');
  ok(llamadas.join() === 'gemini-buscar,groq:openai/gpt-oss-120b', 'orden: primero intenta Gemini, luego Groq (' + llamadas.join(' → ') + ')');
  llamadas = [];
  r = await X.preguntarIA({ proveedor: 'gemini', clave: 'AIzaX' }, 'sis', msgs, true);
  ok(!r.busco && r.texto === 'Respuesta sin buscar.' && /clave de Groq/.test(r.aviso), 'Gemini gratis sin Groq: responde igual y explica cómo activar la búsqueda');
  llamadas = [];
  r = await X.preguntarIA({ proveedor: 'gemini', clave: 'AIzaX', claveGroq: 'gsk_abc' }, 'sis', msgs, false);
  ok(llamadas.join() === 'gemini-normal' && !r.aviso, 'sin «Buscar en internet»: no busca ni usa Groq');
  console.log(fallas ? '\nFALLAS: ' + fallas : '\nTodo bien'); process.exit(fallas ? 1 : 0);
})();
