'use strict';
// Llamadas a la IA de cada persona y a Google (OAuth y Sheets). Nunca se guardan ni se registran las claves.

const PROVEEDORES = {
  groq:   { url: 'https://api.groq.com/openai/v1/chat/completions', modelo: 'openai/gpt-oss-20b', extra: { reasoning_effort: 'low' } },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', modelo: 'gemini-3.5-flash-lite', extra: { reasoning_effort: 'low' } },
  openai: { url: 'https://api.openai.com/v1/chat/completions', modelo: 'gpt-4.1-mini', extra: {} },
  claude: { url: 'https://api.anthropic.com/v1/chat/completions', modelo: 'claude-haiku-5-5', extra: {} }
};

function peticionIA(ia, mensajes, maxTokens, temperatura) {
  ia = ia || {};
  const prov = PROVEEDORES[ia.proveedor] || PROVEEDORES.groq;
  const modelo = String(ia.modelo || '').trim() || prov.modelo;
  return {
    url: prov.url,
    clave: ia.clave || '',
    body: Object.assign({ model: modelo, messages: mensajes, max_tokens: maxTokens, temperature: temperatura }, prov.extra)
  };
}

// Como el nodo HTTP de n8n con "never error": siempre devuelve un objeto, nunca lanza
async function llamarIA(pet, timeoutMs) {
  try {
    const res = await fetch(pet.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pet.clave },
      body: JSON.stringify(pet.body),
      signal: AbortSignal.timeout(timeoutMs || 25000)
    });
    const texto = await res.text();
    let j;
    try { j = JSON.parse(texto); } catch (e) { j = { message: texto.slice(0, 300) }; }
    if (Array.isArray(j)) j = j[0] || {};
    if (!res.ok && j && typeof j === 'object') j.status = res.status;
    return j || {};
  } catch (e) {
    return { message: e && e.name === 'TimeoutError' ? 'la IA tardó demasiado en responder' : 'no se pudo contactar a la IA (' + (e && e.message || 'error') + ')' };
  }
}

async function postForm(url, datos, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(datos).toString(),
    signal: AbortSignal.timeout(timeoutMs || 15000)
  });
  let j = {};
  try { j = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, json: j || {} };
}

async function googleJson(metodo, url, token, cuerpo, timeoutMs) {
  const res = await fetch(url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(timeoutMs || 15000)
  });
  let j = {};
  try { j = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, json: j || {} };
}

// ---------- Preguntale a tu IA: con o sin busqueda en internet ----------
// Cada proveedor busca en internet de forma distinta. Si la busqueda falla (por ejemplo, el plan gratis
// de Gemini no la incluye), se responde igual sin buscar y se avisa.
async function pedirJson(url, cabeceras, cuerpo, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, cabeceras),
      body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(timeoutMs || 45000)
    });
    const t = await res.text();
    let j; try { j = JSON.parse(t); } catch (e) { j = { message: t.slice(0, 300) }; }
    if (Array.isArray(j)) j = j[0] || {};
    return { ok: res.ok, status: res.status, json: j || {} };
  } catch (e) {
    return { ok: false, status: 0, json: { message: e && e.name === 'TimeoutError' ? 'la IA tardó demasiado en responder' : 'no se pudo contactar a la IA' } };
  }
}

function unicas(fuentes) {
  const vistas = {};
  return fuentes.filter(function (f) {
    if (!f || !f.url || !/^https?:\/\//.test(f.url) || vistas[f.url]) return false;
    vistas[f.url] = 1; return true;
  }).slice(0, 8).map(function (f) { return { titulo: String(f.titulo || f.url).slice(0, 160), url: String(f.url) }; });
}

const BUSCADORES = {
  gemini: async function (ia, sistema, mensajes) {
    const modelo = String(ia.modelo || '').trim() || PROVEEDORES.gemini.modelo;
    const r = await pedirJson('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelo) + ':generateContent',
      { 'x-goog-api-key': ia.clave }, {
        systemInstruction: { parts: [{ text: sistema }] },
        contents: mensajes.map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }; }),
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1500, temperature: 0.4 }
      });
    const cand = r.json.candidates && r.json.candidates[0];
    const texto = cand && cand.content && (cand.content.parts || []).map(function (p) { return p.text || ''; }).join('').trim();
    if (!r.ok || !texto) return { error: r.json, status: r.status };
    const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
    return { texto: texto, fuentes: unicas(chunks.map(function (c) { return c.web && { titulo: c.web.title, url: c.web.uri }; })) };
  },
  // Groq retiró groq/compound-mini (sep. 2026); ahora se busca con la herramienta browser_search de los modelos gpt-oss
  groq: async function (ia, sistema, mensajes) {
    // Todo en un solo mensaje: browser_search de Groq rechaza (400) algunas conversaciones por turnos
    const partes = [sistema];
    mensajes.forEach(function (m, i) {
      const ultimo = i === mensajes.length - 1;
      partes.push((ultimo ? 'PREGUNTA ACTUAL DEL USUARIO' : (m.role === 'assistant' ? 'TU RESPUESTA ANTERIOR' : 'USUARIO')) + ':\n' + m.content);
    });
    const r = await pedirJson(PROVEEDORES.groq.url, { Authorization: 'Bearer ' + ia.clave }, {
      model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: partes.join('\n\n').slice(-60000) }],
      tools: [{ type: 'browser_search' }], tool_choice: 'required', reasoning_effort: 'low', max_completion_tokens: 2500, temperature: 0.4
    });
    const msg = r.json.choices && r.json.choices[0] && r.json.choices[0].message;
    if (!r.ok || !msg || !msg.content) return { error: r.json, status: r.status };
    // Quita las marcas de cita internas de gpt-oss, p. ej. 【1†L13-L18】
    msg.content = String(msg.content).replace(/\s*【[^】]*】/g, '');
    const fuentes = [];
    (msg.executed_tools || []).forEach(function (t) {
      const res = (t.search_results && (t.search_results.results || t.search_results)) || [];
      if (Array.isArray(res)) res.forEach(function (x) { if (x && x.url) fuentes.push({ titulo: x.title || x.url, url: x.url }); });
      if (!fuentes.length && typeof t.output === 'string') {
        (t.output.match(/https?:\/\/[^\s)\]"'<>]+/g) || []).slice(0, 6).forEach(function (u) { fuentes.push({ titulo: u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], url: u }); });
      }
    });
    return { texto: String(msg.content).trim(), fuentes: unicas(fuentes) };
  },
  openai: async function (ia, sistema, mensajes) {
    const modelo = String(ia.modelo || '').trim() || PROVEEDORES.openai.modelo;
    const r = await pedirJson('https://api.openai.com/v1/responses', { Authorization: 'Bearer ' + ia.clave }, {
      model: modelo, instructions: sistema, input: mensajes, tools: [{ type: 'web_search' }], max_tool_calls: 2, max_output_tokens: 1500
    });
    const textos = []; const fuentes = [];
    (r.json.output || []).forEach(function (o) {
      if (o.type !== 'message') return;
      (o.content || []).forEach(function (c) {
        if (c.type === 'output_text') {
          textos.push(c.text || '');
          (c.annotations || []).forEach(function (a) { if (a.type === 'url_citation') fuentes.push({ titulo: a.title, url: a.url }); });
        }
      });
    });
    const texto = textos.join('\n').trim();
    if (!r.ok || !texto) return { error: r.json, status: r.status };
    return { texto: texto, fuentes: unicas(fuentes) };
  },
  claude: async function (ia, sistema, mensajes) {
    const modelo = String(ia.modelo || '').trim() || PROVEEDORES.claude.modelo;
    const r = await pedirJson('https://api.anthropic.com/v1/messages', { 'x-api-key': ia.clave, 'anthropic-version': '2023-06-01' }, {
      model: modelo, max_tokens: 1500, system: sistema, messages: mensajes,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]
    });
    const textos = []; const fuentes = [];
    (r.json.content || []).forEach(function (b) {
      if (b.type === 'text') {
        textos.push(b.text || '');
        (b.citations || []).forEach(function (c) { if (c.url) fuentes.push({ titulo: c.title, url: c.url }); });
      }
    });
    const texto = textos.join('').trim();
    if (!r.ok || !texto) return { error: r.json, status: r.status };
    return { texto: texto, fuentes: unicas(fuentes) };
  }
};

// Motivo corto y entendible de por que fallo la busqueda con Groq
function motivoGroq(g) {
  const d = JSON.stringify((g && g.error) || {});
  if (g && g.status === 401 || /invalid.*key|api key|unauthorized/i.test(d)) return 'la clave de Groq no es válida: créala de nuevo';
  if (g && g.status === 429 || /rate|limit|quota|exhausted/i.test(d)) return 'llegaste al límite gratis de Groq por ahora; prueba en unos minutos';
  if (g && g.status === 413 || /too large/i.test(d)) return 'la reunión es muy larga para el plan gratis de Groq';
  const m = g && g.error && ((g.error.error && g.error.error.message) || g.error.message);
  return 'Groq respondió ' + (g && g.status ? g.status : 'con error') + (m ? ': ' + String(m).slice(0, 140) : '');
}

// Devuelve { texto, fuentes, busco, aviso, necesita } o { error } con un mensaje para la persona
async function preguntarIA(ia, sistema, mensajes, buscar) {
  ia = ia || {};
  let aviso = '', necesita = '';
  const buscador = BUSCADORES[ia.proveedor] || BUSCADORES.groq;
  if (buscar) {
    const r = await buscador(ia, sistema, mensajes);
    if (r.texto) return { texto: r.texto, fuentes: r.fuentes || [], busco: true, aviso: '' };
    const detalle = JSON.stringify(r.error || {});
    if (r.status === 401 || /api key|apikey|unauthorized|invalid.*key|authentication/i.test(detalle)) return { error: 'la clave no es válida o no tiene permiso' };
    // Plan B gratis: buscar con Groq si la persona tiene clave de Groq (la del audio)
    const claveGroq = ia.proveedor === 'groq' ? '' : String(ia.claveGroq || '').trim();
    if (/^gsk_/.test(claveGroq)) {
      const g = await BUSCADORES.groq({ clave: claveGroq }, sistema, mensajes);
      if (g.texto) return { texto: g.texto, fuentes: g.fuentes || [], busco: true, aviso: 'Busqué en internet con tu clave de Groq.' };
      aviso = 'Intenté buscar en internet con tu clave de Groq, pero no funcionó (' + motivoGroq(g) + '). Esta vez respondí con lo que ya sé.';
    } else if (ia.proveedor === 'groq') {
      aviso = 'No pude buscar en internet con tu clave de Groq (' + motivoGroq(r) + '), así que respondí con lo que ya sé.';
    } else {
      aviso = 'Para buscar en internet gratis, agrega tu clave de Groq aquí abajo. Esta vez respondí con lo que ya sé.';
      necesita = 'groq';
    }
  }
  const pet = peticionIA(ia, [{ role: 'system', content: sistema }].concat(mensajes), 1500, 0.4);
  const j = await llamarIA(pet, 45000);
  const texto = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (texto) return { texto: String(texto).trim(), fuentes: [], busco: false, aviso: aviso, necesita: necesita };
  const todo = JSON.stringify(j);
  if (/api key|apikey|unauthorized|invalid.*key|authentication|401|permission/i.test(todo)) return { error: 'la clave no es válida o no tiene permiso' };
  if (/rate|quota|429|exhausted|limit/i.test(todo)) return { error: 'llegaste al límite de uso de tu cuenta de IA (espera un poco o revisa tu plan)' };
  return { error: (j.error && j.error.message) || j.message || 'sin respuesta' };
}

module.exports = { PROVEEDORES, peticionIA, llamarIA, postForm, googleJson, preguntarIA };
