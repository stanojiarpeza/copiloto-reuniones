'use strict';
// Servidor del Copiloto de Reuniones: sirve la app (lo que antes estaba en Netlify) y hace el trabajo
// de los 3 flujos de n8n (copiloto, conectar Google y desconectar), con las mismas direcciones.
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const C = require('./copiloto');
const X = require('./externos');

// ---------- Configuracion (variables de entorno, archivo .env) ----------
const cfg = {
  puerto: Number(process.env.PORT || 3000),
  publico: process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  claveCifrado: process.env.CLAVE_CIFRADO || '',
  maxCuentas: Number(process.env.MAX_CUENTAS || 120),
  limiteDiario: Number(process.env.LIMITE_DIARIO || 300),
  permitirSinCuenta: process.env.PERMITIR_SIN_CUENTA === 'true',
  origenes: String(process.env.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
  peticionesPorMinuto: Number(process.env.RATE_LIMIT_PER_MIN || 120),        // por persona (token de su equipo)
  peticionesPorIpMinuto: Number(process.env.RATE_LIMIT_IP_PER_MIN || 3000),  // por direccion: una oficina entera comparte la misma
  sheetsHistorialMs: Number(process.env.SHEETS_HISTORIAL_S === undefined ? 45 : process.env.SHEETS_HISTORIAL_S) * 1000,
  sheetsTxMs: Number(process.env.SHEETS_TX_S === undefined ? 90 : process.env.SHEETS_TX_S) * 1000,
  dbHost: process.env.DB_HOST, dbPort: Number(process.env.DB_PORT || 5432), dbName: process.env.DB_NAME || 'postgres',
  dbUser: process.env.DB_USER, dbPassword: process.env.DB_PASSWORD, dbCaFile: process.env.DB_CA_FILE || '',
  dbSsl: process.env.DB_SSL || 'on', dbMax: Number(process.env.DB_POOL_MAX || 10)
};

const RUTA_CHAT = '/webhook/b7d2e9a4-0002-4c22-8b02-000000000002/chat';
const RUTA_CONECTAR = '/webhook/copiloto-conectar';
const RUTA_DESCONECTAR = '/webhook/copiloto-desconectar';
const RUTA_PREGUNTAR = '/webhook/copiloto-preguntar';
const PESTANA_TX = 'Transcripción';
const ENCABEZADOS_TX = ['fecha', 'idReunion', 'quien', 'texto', 'traduccion'];

function log() { console.log.apply(console, [new Date().toISOString()].concat([].slice.call(arguments))); }

// ---------- Memoria de las reuniones en curso ----------
// Evita leer de Supabase toda la transcripcion en cada mensaje (ahorra transferencia del plan gratis).
// Se escribe siempre en Supabase; si el servidor se reinicia, se vuelve a leer de ahi.
const sesiones = new Map(); // sessionId -> { email, sesion, t }
const HORAS_MEMORIA = 3;
setInterval(function () {
  const limite = Date.now() - HORAS_MEMORIA * 3600 * 1000;
  sesiones.forEach(function (v, k) { if (v.t < limite) sesiones.delete(k); });
}, 10 * 60 * 1000).unref();

function recordarEnMemoria(sessionId, email, est, sugerencias) {
  if (sesiones.size > 5000) sesiones.delete(sesiones.keys().next().value);
  sesiones.set(sessionId, {
    email: email,
    t: Date.now(),
    sesion: {
      email: email, estado: est.estado || 'activa', transcripcion: est.transcripcion || [], turnos_cliente: est.turnosCliente || 0,
      cortos_seguidos: est.cortosSeguidos || 0, analisis: est.analisis || 0, recordatorios: est.recordatorios || [],
      sugerencias: sugerencias || []
    }
  });
}

// ---------- Accesos a Google Sheets (se reutilizan ~50 min en vez de pedir uno por fila) ----------
const accesos = new Map(); // email -> { token, hojaId, vence }

const renovando = new Map(); // email -> promesa en curso (dos filas a la vez = una sola renovacion)
function accesoSheets(email) {
  const a = accesos.get(email);
  if (a && a.vence > Date.now()) return Promise.resolve(a);
  if (renovando.has(email)) return renovando.get(email);
  const p = renovarAcceso(email).finally(function () { renovando.delete(email); });
  renovando.set(email, p);
  return p;
}
async function renovarAcceso(email) {
  const llave = await db.leerLlave(email, cfg.claveCifrado);
  if (!llave || !llave.rt) return null;
  const r = await X.postForm('https://oauth2.googleapis.com/token', {
    client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, refresh_token: llave.rt, grant_type: 'refresh_token'
  });
  if (!r.ok || !r.json.access_token) throw new Error('Google no renovó el acceso (' + (r.json.error || r.status) + ')');
  const nuevo = { token: r.json.access_token, hojaId: llave.hoja_id, vence: Date.now() + Math.max(60, (Number(r.json.expires_in) || 3600) - 600) * 1000 };
  accesos.set(email, nuevo);
  return nuevo;
}

async function agregarFilas(email, pestana, filas) {
  let creada = false;
  for (let intento = 0; intento < 3; intento++) {
    const a = await accesoSheets(email);
    if (!a) return;
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(a.hojaId) +
      '/values/' + encodeURIComponent(pestana + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
    const r = await X.googleJson('POST', url, a.token, { values: filas });
    if (r.ok) return;
    if (r.status === 401) { accesos.delete(email); continue; }
    // Google limita las escrituras por minuto de todo el proyecto: se espera y se reintenta
    if (r.status === 429 && intento < 2) { await new Promise(function (ok) { setTimeout(ok, 15000 * (intento + 1)); }); continue; }
    // Hojas creadas antes de esta version no tienen la pestaña "Transcripción": se crea sola
    if (r.status === 400 && pestana === PESTANA_TX && !creada && /parse range|Unable to parse/i.test(JSON.stringify(r.json))) {
      await crearPestana(a, PESTANA_TX, ENCABEZADOS_TX);
      creada = true; continue;
    }
    throw new Error('Sheets respondió ' + r.status);
  }
}


async function crearPestana(a, titulo, encabezados) {
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(a.hojaId);
  const r = await X.googleJson('POST', base + ':batchUpdate', a.token, {
    requests: [{ addSheet: { properties: { title: titulo, gridProperties: { frozenRowCount: 1 } } } }]
  });
  if (!r.ok && !/already exists|ya existe/i.test(JSON.stringify(r.json))) throw new Error('no se pudo crear la pestaña ' + titulo + ' (' + r.status + ')');
  await X.googleJson('PUT', base + '/values/' + encodeURIComponent(titulo + '!A1') + '?valueInputOption=RAW', a.token, { values: [encabezados] });
}

// ---------- Escrituras a Google Sheets por lotes ----------
// Google limita las escrituras por minuto de TODO el proyecto (todas las personas juntas). Con 100 personas
// a la vez, en vez de escribir una fila por mensaje, se juntan las de cada persona y se mandan cada pocos segundos:
// el historial cada 45 s y la transcripcion cada 90 s (o antes si se juntan 50 filas, o al cerrar la reunion).
function crearCola(pestana, intervaloMs) {
  const mapa = new Map(); // email -> { filas: [], timer }
  function enviar(email) {
    const p = mapa.get(email);
    if (!p) return Promise.resolve();
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    const filas = p.filas;
    mapa.delete(email);
    if (!filas.length) return Promise.resolve();
    return agregarFilas(email, pestana, filas).catch(function (e) { log('[sheets ' + pestana + ']', e.message); });
  }
  function agregar(email, filas) {
    if (!email || !filas.length) return Promise.resolve();
    let p = mapa.get(email);
    if (!p) { p = { filas: [], timer: null }; mapa.set(email, p); }
    p.filas = p.filas.concat(filas);
    if (!intervaloMs || p.filas.length >= 50) return enviar(email);
    if (!p.timer) p.timer = setTimeout(function () { enviar(email); }, intervaloMs);
    return Promise.resolve();
  }
  function enviarTodo() { const t = []; mapa.forEach(function (v, email) { t.push(enviar(email)); }); return Promise.all(t); }
  return { mapa: mapa, agregar: agregar, enviar: enviar, enviarTodo: enviarTodo };
}
const colaHistorial = crearCola('Historial', cfg.sheetsHistorialMs);
const colaTx = crearCola(PESTANA_TX, cfg.sheetsTxMs);
const transcripciones = colaTx.mapa;
function agregarFila(email, fila) { return colaHistorial.agregar(email, [fila]); }
function enviarTranscripcion(email) { return colaTx.enviar(email); }

// Transcripcion completa: cada intervencion va a la pestaña "Transcripción"
function anotarTranscripcion(d, ahora) {
  if (!d.email || !Array.isArray(d.turnosNuevos) || !d.turnosNuevos.length) return;
  const marca = require('./fechas').marcaLima(ahora);
  const filas = d.turnosNuevos.map(function (t) { return [marca, d.sessionId, t.etiqueta, t.cuerpo, '']; });
  if (d.traduccion) filas[filas.length - 1][4] = d.traduccion;
  colaTx.agregar(d.email, filas);
}

// ---------- Limite de peticiones: por persona (y uno alto por direccion, contra abusos) ----------
// Muchas personas de una misma oficina salen a internet con la MISMA direccion: por eso el limite principal es por persona.
const visitas = new Map(); // clave -> { n, desde }
setInterval(function () { visitas.clear(); }, 10 * 60 * 1000).unref();
function permitido(clave, limite) {
  const ahora = Date.now();
  let v = visitas.get(clave);
  if (!v || ahora - v.desde > 60000) { v = { n: 0, desde: ahora }; visitas.set(clave, v); }
  v.n++;
  return v.n <= limite;
}

// ---------- Utilidades HTTP ----------
function responderJson(res, status, obj, cabeceras) {
  const cuerpo = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cabeceras || {}));
  res.end(cuerpo);
}

function leerCuerpo(req, limite) {
  return new Promise(function (ok, mal) {
    let total = 0;
    const partes = [];
    req.on('data', function (c) {
      total += c.length;
      if (total > limite) { mal(Object.assign(new Error('demasiado grande'), { status: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', function () {
      const txt = Buffer.concat(partes).toString('utf8');
      if (!txt) return ok({});
      try { ok(JSON.parse(txt)); } catch (e) { mal(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', mal);
  });
}

// CORS: la app servida desde este mismo servidor no lo necesita; se permite la de Netlify mientras dure el cambio
function cabecerasCors(req) {
  const origen = req.headers.origin;
  if (!origen) return {};
  if (cfg.origenes.indexOf(origen) === -1) return null;
  return { 'Access-Control-Allow-Origin': origen, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' };
}
function mismoSitio(req) {
  const origen = req.headers.origin;
  if (!origen) return true;
  try { return new URL(origen).host === req.headers.host; } catch (e) { return false; }
}

// ---------- 1) Copiloto (antes: flujo "Copiloto de reuniones v10.4") ----------
async function rutaChat(entrada) {
  const ahora = Date.now();
  const metadata = entrada.metadata || {};
  const sessionId = String(entrada.sessionId || 'sin-sesion').slice(0, 200);
  const appToken = String(metadata.appToken || entrada.appToken || 'sin-token');
  entrada.sessionId = sessionId;

  // Leer sesion: la reunion en curso sale de la memoria si este servidor ya la tiene
  const enMemoria = sesiones.get(sessionId);
  const ctx = await db.leerContexto(sessionId, appToken, !enMemoria);
  let fila = { email: ctx.email || '', uso_hoy: ctx.uso_hoy, sesion: ctx.sesion || null };
  if (enMemoria) {
    if (enMemoria.email === fila.email) fila.sesion = enMemoria.sesion;
    else fila.sesion = (await db.leerContexto(sessionId, appToken, true)).sesion || null;
  }
  if (fila.sesion && typeof fila.sesion === 'string') { try { fila.sesion = JSON.parse(fila.sesion); } catch (e) { fila.sesion = null; } }

  // Registrar turno
  let d = C.registrar(entrada, fila, cfg);
  const ia = metadata.ia || {};

  // Hay que clasificar -> IA: clasificar -> Procesar turno
  if (d.clasificar) {
    const resIA = await X.llamarIA(C.prepararClasificacion(d, ia, ahora), 25000);
    d = C.procesarTurno(d, resIA, ahora);
  }

  // Transcripcion completa (solo de quien tiene cuenta y su IA configurada)
  if (!d.noGuardar) anotarTranscripcion(d, ahora);


  // Guardar sesion (y sumar el uso del dia si se va a analizar)
  if (!d.noGuardar) {
    const g = await db.guardarSesion(d);
    if (g.sesionGuardada && d.est) recordarEnMemoria(sessionId, d.email, d.est, d.sugerencias);
  }

  // Hay que analizar -> IA: copiloto -> Leer respuesta -> Responder
  if (!d.listo) return { output: d.output || '' };
  const resCopiloto = await X.llamarIA(C.prepararCopiloto(d, ia), 25000);
  const output = C.responder(d, C.leerRespuesta(resCopiloto));

  // Despues de responder: recordar la sugerencia y guardar la fila en el Sheets de la persona
  const cerrar = d.modo === 'cierre' && d.email;
  const m = sesiones.get(sessionId);
  if (m && m.email === d.email) m.sesion.sugerencias = (m.sesion.sugerencias || []).concat([output]).slice(-4);
  const despues = function () {
    db.recordarSugerencia(sessionId, d.email, output).catch(function (e) { log('[sugerencia]', e.message); });
    if (d.email) {
      agregarFila(d.email, C.filaSheets(d, output, ahora));
      if (cerrar) { colaHistorial.enviar(d.email); colaTx.enviar(d.email); }
    }
  };
  return { output: output, despues: despues };
}

// ---------- Preguntale a tu IA ----------
async function rutaPreguntar(body) {
  const ahora = Date.now();
  const ia = body.ia || {};
  const pregunta = String(body.pregunta || '').trim();
  const sessionId = String(body.sessionId || 'sin-sesion').slice(0, 200);
  if (!pregunta) return { ok: false, error: 'Escribe tu pregunta.' };
  const ctx = await db.leerContexto(sessionId, String(body.appToken || 'sin-token'), false);
  const email = ctx.email || '';
  if (!email && !cfg.permitirSinCuenta) return { ok: false, error: 'Primero conecta tu cuenta de Google (es una sola vez).' };
  if (!ia.clave) return { ok: false, error: 'Falta configurar tu IA en Ajustes → Tu IA.' };
  if (email && Number(ctx.uso_hoy || 0) >= cfg.limiteDiario) return { ok: false, error: 'Llegaste al límite de ' + cfg.limiteDiario + ' análisis por hoy. Se reinicia a medianoche.' };

  const r = await X.preguntarIA(ia, C.SISTEMA_PREGUNTAS, C.mensajesPregunta(body), body.buscar !== false);
  if (r.error) return { ok: false, error: 'Tu IA no respondió: ' + r.error + '. Revisa tu proveedor y tu clave en Ajustes → Tu IA.' };
  if (email) {
    db.sumarUso(email).catch(function (e) { log('[uso]', e.message); });
    const fuentes = (r.fuentes || []).map(function (f) { return f.url; }).join(' ');
    agregarFila(email, [require('./fechas').marcaLima(ahora), sessionId, '', 'pregunta', pregunta, r.texto + (fuentes ? '\nFuentes: ' + fuentes : '')]);
  }
  return { ok: true, respuesta: r.texto, fuentes: r.fuentes || [], busco: !!r.busco, aviso: r.aviso || '', necesita: r.necesita || '' };
}

// ---------- 2) Conectar Google (antes: flujo "Conectar Google v2") ----------
async function rutaConectar(body) {
  const fallo = function (msg) { return { status: 400, json: { ok: false, error: msg } }; };
  const code = body && body.code;
  if (!code) return fallo('Falta el código de Google.');

  // Canjear codigo
  const r = (await X.postForm('https://oauth2.googleapis.com/token', {
    code: code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, redirect_uri: 'postmessage', grant_type: 'authorization_code'
  })).json;

  // Validar respuesta
  if (!r.access_token || !r.id_token) {
    return fallo('Google no aceptó el código (' + (r.error_description || r.error || 'sin detalle') + ').');
  }
  let datos = {};
  try {
    const parte = r.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    datos = JSON.parse(Buffer.from(parte, 'base64').toString('utf8'));
  } catch (e) {
    return fallo('No se pudo leer la identidad de Google.');
  }
  if (datos.aud !== cfg.googleClientId) return fallo('El código no corresponde a esta app.');
  if (!datos.email || datos.email_verified === false) return fallo('La cuenta de Google no tiene un correo verificado.');
  if (!String(r.scope || '').includes('https://www.googleapis.com/auth/drive.file')) {
    return fallo('Falta el permiso de Google Drive. Vuelve a conectar y deja marcada esa casilla.');
  }
  const email = String(datos.email).toLowerCase();
  const refreshToken = r.refresh_token || '';

  // Buscar usuario y decidir hoja
  const u = await db.buscarUsuario(email);
  let hojaId = u.hoja_id || '';
  if (u.existe !== true && Number(u.total || 0) >= cfg.maxCuentas) {
    return fallo('La prueba ya alcanzó el máximo de ' + cfg.maxCuentas + ' cuentas. Habla con el encargado.');
  }
  if (!refreshToken && u.tiene_llave !== true) {
    return fallo('Google no entregó la autorización permanente. Quita el acceso de la app en myaccount.google.com/permissions y vuelve a conectar.');
  }

  // Crear hoja y poner encabezados (solo la primera vez)
  if (!hojaId) {
    const h = await X.googleJson('POST', 'https://sheets.googleapis.com/v4/spreadsheets', r.access_token, {
      properties: { title: 'Copiloto de reuniones - Historial', timeZone: 'America/Lima' },
      sheets: [{ properties: { title: 'Historial', gridProperties: { frozenRowCount: 1 } } },
               { properties: { title: PESTANA_TX, gridProperties: { frozenRowCount: 1 } } }]
    });
    if (!h.ok || !h.json.spreadsheetId) return fallo('No se pudo crear tu hoja de historial en Google Drive (' + h.status + ').');
    hojaId = h.json.spreadsheetId;
    const enc = await X.googleJson('PUT', 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(hojaId) + '/values/Historial!A1:F1?valueInputOption=RAW',
      r.access_token, { values: [['fecha', 'idReunion', 'numero', 'disparador', 'texto', 'analisis']] });
    if (!enc.ok) log('[conectar] no se pusieron encabezados:', enc.status);
    try {
      const enc2 = await X.googleJson('PUT', 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(hojaId) + '/values/' + encodeURIComponent(PESTANA_TX + '!A1') + '?valueInputOption=RAW',
        r.access_token, { values: [ENCABEZADOS_TX] });
      if (!enc2.ok) log('[conectar] no se pusieron encabezados de la transcripcion:', enc2.status);
    } catch (e) { log('[conectar] encabezados de la transcripcion:', e.message); }
  }

  // Guardar usuario (llave cifrada) y crear el token de este equipo
  const g = await db.guardarUsuario(email, refreshToken, cfg.claveCifrado, hojaId);
  if (!g) return fallo('No se pudo guardar tu cuenta. Intenta de nuevo.');
  accesos.delete(email);
  return { status: 200, json: { ok: true, email: g.email, hojaId: g.hoja_id, appToken: g.app_token } };
}

// ---------- 3) Desconectar (antes: flujo "Desconectar") ----------
async function rutaDesconectar(body) {
  const r = await db.quitarEquipoOCuenta((body && body.appToken) || 'sin-token', !!(body && body.borrarTodo === true));
  if (r.email && Number(r.cuentas_borradas || 0) > 0) {
    accesos.delete(r.email);
    sesiones.forEach(function (v, k) { if (v.email === r.email) sesiones.delete(k); });
  }
  return { ok: true, email: r.email || null, cuentaBorrada: Number(r.cuentas_borradas || 0) > 0 };
}

// ---------- Archivos de la app ----------
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip'
};
function servirArchivo(req, res, ruta) {
  let rel = decodeURIComponent(ruta.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.normalize(path.join(cfg.publico, rel));
  if (abs.indexOf(path.normalize(cfg.publico) + path.sep) !== 0) { res.writeHead(403); return res.end(); }
  fs.stat(abs, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    const ext = path.extname(abs).toLowerCase();
    // index.html y sw.js siempre frescos: asi cada version nueva de la app llega sola
    const sinCache = ext === '.html' || path.basename(abs) === 'sw.js' || ext === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': TIPOS[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': sinCache ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  });
}

// ---------- Servidor ----------
const servidor = http.createServer(async function (req, res) {
  const ruta = (req.url || '/').split('?')[0];
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (ruta === '/healthz') {
      try { await db.ping(); return responderJson(res, 200, { status: 'ok' }); }
      catch (e) { return responderJson(res, 503, { status: 'sin base de datos' }); }
    }

    const esApi = ruta === RUTA_CHAT || ruta === RUTA_CONECTAR || ruta === RUTA_DESCONECTAR || ruta === RUTA_PREGUNTAR;
    if (!esApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return servirArchivo(req, res, ruta);
    }

    let cors = {};
    if (!mismoSitio(req)) {
      cors = cabecerasCors(req);
      if (cors === null) return responderJson(res, 403, { ok: false, error: 'Origen no permitido' });
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method !== 'POST') return responderJson(res, 405, { ok: false, error: 'Usa POST' }, cors);
    if (!permitido('ip:' + ip, cfg.peticionesPorIpMinuto)) return responderJson(res, 429, { ok: false, error: 'Demasiadas peticiones. Espera un minuto.' }, cors);

    const body = await leerCuerpo(req, (ruta === RUTA_CHAT || ruta === RUTA_PREGUNTAR) ? 256 * 1024 : 16 * 1024);
    const quien = String((body.metadata && body.metadata.appToken) || body.appToken || body.code || ('ip:' + ip)).slice(0, 80);
    if (!permitido('p:' + quien, cfg.peticionesPorMinuto)) return responderJson(res, 429, { ok: false, error: 'Demasiadas peticiones. Espera un minuto.', output: '⚠️ Demasiadas peticiones seguidas. Espera un minuto.' }, cors);

    if (ruta === RUTA_CHAT) {
      const r = await rutaChat(body);
      responderJson(res, 200, { output: r.output }, cors);
      if (r.despues) setImmediate(r.despues);
      return;
    }
    if (ruta === RUTA_PREGUNTAR) {
      const r = await rutaPreguntar(body);
      return responderJson(res, 200, r, cors);
    }
    if (ruta === RUTA_CONECTAR) {
      const r = await rutaConectar(body);
      return responderJson(res, r.status, r.json, cors);
    }
    const r = await rutaDesconectar(body);
    return responderJson(res, 200, r, cors);
  } catch (e) {
    log('[error]', ruta, e.status || '', e.message);
    if (!res.headersSent) responderJson(res, e.status || 500, { ok: false, error: e.status ? e.message : 'Error interno del servidor', output: e.status ? undefined : '⚠️ El servidor del copiloto tuvo un problema. Intenta de nuevo en unos segundos.' });
  }
});

// Al apagar o reiniciar el servidor, manda lo que quede pendiente de las transcripciones
function apagar() {
  Promise.all([colaHistorial.enviarTodo(), colaTx.enviarTodo()]).finally(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 8000).unref();
}
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);

function iniciar() {
  const faltan = ['googleClientId', 'googleClientSecret', 'claveCifrado', 'dbHost', 'dbUser', 'dbPassword'].filter(function (k) { return !cfg[k]; });
  if (faltan.length) { console.error('Faltan variables en el .env:', faltan.join(', ')); process.exit(1); }
  db.crearPool(cfg);
  servidor.listen(cfg.puerto, function () { log('Copiloto escuchando en el puerto ' + cfg.puerto + ' · app en ' + cfg.publico); });
}

if (require.main === module) iniciar();

module.exports = { servidor, cfg, sesiones, accesos, transcripciones, enviarTranscripcion, colaHistorial, colaTx };
