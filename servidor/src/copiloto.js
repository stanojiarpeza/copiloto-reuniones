'use strict';
// Logica del copiloto: la misma de los nodos de codigo del flujo de n8n v10.4, paso por paso.
// Cada funcion es pura (no habla con la base ni con la IA) para poder probarla sola.
const P = require('./prompts');
const F = require('./fechas');
const { peticionIA } = require('./externos');

// ===== CONFIGURACION (antes en el nodo "Registrar turno") =====
const ENFOQUE = 'descubrimiento';
const OBJETIVOS = {
  descubrimiento: 'Descubrir las necesidades del cliente, validar que entendi bien su problema y calificar la oportunidad (necesidad, presupuesto, decisor y plazo) antes de proponer nada',
  cierre: 'Cerrar la venta de un servicio de software y acordar una demo o una compra'
};
const MIN_PALABRAS = 3;         // minimo de palabras del CLIENTE para analizar
const TURNOS_RECIENTES = 4;     // turnos literales que ve el copiloto en vivo
const MAX_CARACTERES = 8000;    // limite de la transcripcion guardada por reunion
const CORTO_PALABRAS = 4;       // un turno del cliente de 4 palabras o menos cuenta como "corto"
const TURNOS_CORTOS_RIESGO = 3; // turnos cortos seguidos que activan la alerta de silencio
const FRASE_EN_IDIOMA_CLIENTE = false;

function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Chino, japones y coreano no separan palabras con espacios: se cuentan por caracteres
const CJK = /[぀-ヿ㐀-鿿가-힯]/g;
function contarPalabras(s) {
  const n = (s.match(CJK) || []).length;
  const resto = s.replace(CJK, ' ').split(/\s+/).filter(Boolean).length;
  return resto + Math.ceil(n / 2);
}

function textoRecordatorios(lista) {
  if (!lista.length) return 'ninguno';
  return lista.map(function (x, i) { return (i + 1) + '. ' + x.accion + ' | responsable: ' + x.responsable + ' | fecha: ' + x.fecha; }).join('\n');
}

/* ---------- Registrar turno ----------
   entrada = lo que manda la app { sessionId, chatInput, metadata: { ia, perfil, appToken } }
   fila    = { email, sesion, uso_hoy } leido de Supabase (o de la memoria del servidor)
   cfg     = { permitirSinCuenta, limiteDiario } */
function registrar(entrada, fila, cfg) {
  const metadata = entrada.metadata || {};
  const perfilApp = metadata.perfil || {};
  const ENFOQUE_FINAL = (perfilApp.enfoque === 'cierre' || perfilApp.enfoque === 'descubrimiento') ? perfilApp.enfoque : ENFOQUE;
  const ESCENARIO = String(perfilApp.escenario || '').trim() || 'Venta';
  const OBJETIVO = String(perfilApp.objetivo || '').trim() || OBJETIVOS[ENFOQUE_FINAL] || OBJETIVOS.descubrimiento;
  const CONTEXTO = String(perfilApp.contexto || '').trim() || 'No se indico contexto. Si falta informacion, pidela en una linea.';
  const ESTILO = String(perfilApp.estilo || '').trim() || 'consultivo, curioso, amable y seguro';

  fila = fila || {};
  const email = fila.email || '';
  const sessionId = entrada.sessionId || 'sin-sesion';
  const texto = String(entrada.chatInput || '').trim();
  const normal = normalizar(texto).replace(/[.!?¿¡]/g, '').trim();

  // reunion cerrada = empieza de cero; una reunion de otra persona nunca se lee
  const s = (fila.sesion && fila.sesion.estado !== 'cerrada' && (!fila.sesion.email || fila.sesion.email === email)) ? fila.sesion : null;
  const est = {
    transcripcion: (s && Array.isArray(s.transcripcion)) ? s.transcripcion.slice() : [],
    turnosCliente: (s && s.turnos_cliente) || 0,
    cortosSeguidos: (s && s.cortos_seguidos) || 0,
    analisis: (s && s.analisis) || 0,
    recordatorios: (s && Array.isArray(s.recordatorios)) ? s.recordatorios.slice() : [],
    estado: 'activa'
  };

  const comun = {
    sessionId: sessionId,
    email: email,
    est: est,
    sugerencias: (s && Array.isArray(s.sugerencias)) ? s.sugerencias : [],
    enfoque: ENFOQUE_FINAL,
    escenario: ESCENARIO,
    objetivo: OBJETIVO,
    contexto: CONTEXTO,
    estilo: ESTILO,
    fraseIdiomaCliente: FRASE_EN_IDIOMA_CLIENTE ? 'si' : 'no',
    minPalabras: MIN_PALABRAS,
    turnosRecientes: TURNOS_RECIENTES,
    recordatorios: textoRecordatorios(est.recordatorios),
    recordatorioNuevo: 'ninguno',
    alerta: 'ninguna',
    motivoRiesgo: '',
    idioma: 'es',
    nombreIdioma: 'espanol',
    traduccion: '',
    clasificar: false,
    listo: false,
    modo: 'en_vivo',
    chatInput: texto
  };

  // ===== Control de acceso y limite diario =====
  if (!email && !cfg.permitirSinCuenta) {
    return Object.assign({}, comun, { noGuardar: true, output: 'Para usar el copiloto, primero conecta tu cuenta de Google con el botón "Conectar con Google" (arriba). Es una sola vez.' });
  }
  const iaCfg = metadata.ia || {};
  if (!iaCfg.clave) {
    return Object.assign({}, comun, { noGuardar: true, output: 'Falta configurar tu IA: en Ajustes → Tu IA elige tu proveedor (Groq, Gemini, OpenAI o Claude) y pega tu clave.' });
  }
  const usoHoy = Number(fila.uso_hoy || 0);
  if (email && usoHoy >= cfg.limiteDiario && normal !== 'recordatorios') {
    return Object.assign({}, comun, { noGuardar: true, output: 'Llegaste al límite de ' + cfg.limiteDiario + ' análisis por hoy. Se reinicia a medianoche.' });
  }

  const comandos = {
    'analiza': 'en_vivo',
    'resumen': 'resumen',
    'objeciones': 'objeciones',
    'siguiente paso': 'siguiente',
    'cierra reunion': 'cierre',
    'cierra la reunion': 'cierre',
    'cerrar reunion': 'cierre'
  };

  // 1) Comando "recordatorios": responde directo, sin IA
  if (normal === 'recordatorios') {
    return Object.assign({}, comun, { output: 'Recordatorios de la reunion:\n' + textoRecordatorios(est.recordatorios) });
  }

  // 2) Otros comandos
  const modoComando = comandos[normal];
  if (modoComando) {
    if (est.transcripcion.length === 0) {
      return Object.assign({}, comun, { output: 'Todavia no hay conversacion registrada. Escribe primero lo que dijo el cliente.' });
    }
    est.analisis = (est.analisis || 0) + 1;
    const salida = Object.assign({}, comun, {
      listo: true,
      modo: modoComando,
      numeroAnalisis: est.analisis,
      recientes: est.transcripcion.slice(-TURNOS_RECIENTES).join('\n'),
      transcripcion: est.transcripcion.join('\n')
    });
    if (modoComando === 'cierre') {
      // reunion terminada: se marca cerrada y se borra la transcripcion guardada (el resumen ya se armo)
      salida.est = { transcripcion: [], turnosCliente: 0, cortosSeguidos: 0, analisis: est.analisis, recordatorios: [], estado: 'cerrada' };
    }
    return salida;
  }

  // 3) Mensaje normal: puede traer varias lineas "YO: ..." / "CLIENTE: ..."
  const lineas = texto.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
  const turnos = [];
  lineas.forEach(function (l) {
    const mm = l.match(/^\s*(yo|cliente)\s*:\s*([\s\S]*)$/i);
    const et = mm ? mm[1].toUpperCase() : 'CLIENTE';
    const cu = (mm ? mm[2] : l).trim();
    if (cu) turnos.push({ etiqueta: et, cuerpo: cu });
  });
  if (!turnos.length) {
    return Object.assign({}, comun, { output: 'No recibi texto. Escribe lo que dijo la otra persona.' });
  }

  let silencio = false;
  let palabrasCliente = 0;
  turnos.forEach(function (t) {
    est.transcripcion.push(t.etiqueta + ': ' + t.cuerpo);
    if (t.etiqueta === 'CLIENTE') {
      const p = contarPalabras(t.cuerpo);
      palabrasCliente += p;
      est.turnosCliente += 1;
      if (p <= CORTO_PALABRAS) est.cortosSeguidos = (est.cortosSeguidos || 0) + 1;
      else est.cortosSeguidos = 0;
      if (est.cortosSeguidos >= TURNOS_CORTOS_RIESGO) { silencio = true; est.cortosSeguidos = 0; }
    }
  });
  while (est.transcripcion.join('\n').length > MAX_CARACTERES && est.transcripcion.length > 1) {
    est.transcripcion.shift();
  }

  const hayCliente = turnos.some(function (t) { return t.etiqueta === 'CLIENTE'; });
  const varios = turnos.length > 1;
  return Object.assign({}, comun, {
    clasificar: true,
    hablante: varios ? 'VARIOS (cada linea del TEXTO indica quien habla: YO o CLIENTE)' : turnos[0].etiqueta,
    hayCliente: hayCliente,
    lineas: turnos.length,
    textoCompromiso: varios ? turnos.map(function (t) { return t.etiqueta + ': ' + t.cuerpo; }).join('\n') : turnos[0].cuerpo,
    turnosNuevos: turnos, // para la transcripcion completa (pestaña "Transcripción" del Sheets)
    palabras: palabrasCliente,
    silencio: silencio,
    turnosCliente: est.turnosCliente
  });
}

/* ---------- Preparar clasificacion ---------- */
function prepararClasificacion(d, ia, ahoraMs) {
  const prompt = P.promptClasificacion(d, F.textoHoyLima(ahoraMs));
  return peticionIA(ia, [{ role: 'user', content: prompt }], 700, 0.1);
}

/* ---------- Procesar turno ---------- */
const IDIOMAS = { es: 'espanol', en: 'ingles', zh: 'chino', ru: 'ruso', de: 'aleman', fr: 'frances', pt: 'portugues', it: 'italiano', ja: 'japones', ko: 'coreano', ar: 'arabe', hi: 'hindi', tr: 'turco', nl: 'neerlandes', pl: 'polaco', uk: 'ucraniano', sv: 'sueco', he: 'hebreo', vi: 'vietnamita', th: 'tailandes', id: 'indonesio' };

function procesarTurno(orig, resIA, ahoraMs) {
  const est = orig.est ? JSON.parse(JSON.stringify(orig.est)) : null;
  resIA = resIA || {};
  const bruto = String((resIA.choices && resIA.choices[0] && resIA.choices[0].message && resIA.choices[0].message.content) || resIA.text || resIA.output || '');
  let c = null;
  try {
    const mm = bruto.match(/\{[\s\S]*\}/);
    c = mm ? JSON.parse(mm[0]) : null;
  } catch (e) {
    c = null;
  }
  c = c || {}; // si la IA fallo, el turno sigue sin alerta ni compromiso

  const idioma = String(c.idioma || 'es').toLowerCase().slice(0, 2);
  const nombreIdioma = IDIOMAS[idioma] || idioma;
  const esCliente = orig.hablante === 'CLIENTE' || orig.hayCliente === true;
  const traduccion = (idioma !== 'es' && c.traduccion && c.traduccion !== 'null') ? String(c.traduccion) : '';

  if (est && traduccion && est.transcripcion.length) {
    if ((orig.lineas || 1) > 1) {
      est.transcripcion.push('(traduccion al espanol del bloque anterior, en ' + nombreIdioma + '): ' + traduccion);
    } else {
      est.transcripcion[est.transcripcion.length - 1] =
        orig.hablante + ' [' + nombreIdioma + ']: ' + orig.textoCompromiso + ' (en espanol: ' + traduccion + ')';
    }
  }

  // ---- Alerta ----
  const VALIDAS = ['precio', 'competencia', 'cierre', 'riesgo'];
  let alerta = (esCliente && VALIDAS.indexOf(c.alerta) >= 0) ? c.alerta : 'ninguna';
  let motivoRiesgo = '';
  if (alerta === 'riesgo') {
    motivoRiesgo = 'el cliente dijo: "' + (traduccion || orig.textoCompromiso) + '"' + (c.motivo ? ' (' + c.motivo + ')' : '');
    if (est) est.cortosSeguidos = 0;
  } else if (alerta === 'ninguna' && orig.silencio) {
    alerta = 'riesgo';
    motivoRiesgo = 'varios turnos cortos seguidos del cliente, poco compromiso';
  }

  // ---- Compromiso ----
  let recordatorioNuevo = 'ninguno';
  let tieneFecha = false;
  let recAccion = '', recResponsable = '', recFecha = '', recInicio = '', recFin = '';

  if (c.hay_compromiso === true && c.accion) {
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(c.fecha || '')) ? String(c.fecha) : null;
    const hora = /^\d{1,2}:\d{2}$/.test(String(c.hora || '')) ? String(c.hora).padStart(5, '0') : null;
    const conf = Number(c.confianza);
    const seguro = isNaN(conf) || conf >= 0.7;
    const rec = {
      accion: String(c.accion),
      responsable: String(c.responsable || 'por definir'),
      fecha: fecha ? fecha + (hora ? ' ' + hora : '') : 'sin fecha',
      hablante: orig.hablante,
      texto: orig.textoCompromiso + (traduccion ? ' (en espanol: ' + traduccion + ')' : '')
    };
    recAccion = rec.accion;
    recResponsable = rec.responsable;
    recFecha = rec.fecha;

    let repetido = false;
    if (est) {
      repetido = est.recordatorios.some(function (x) { return x.accion === rec.accion && x.fecha === rec.fecha; });
      if (!repetido) est.recordatorios.push(rec);
    }

    if (!repetido) {
      recordatorioNuevo = rec.accion + ' | ' + rec.responsable + ' | ' + rec.fecha;
      if (fecha && seguro) {
        let inicio = F.msDesdeLima(fecha, hora || '09:00');
        if (inicio !== null) {
          if (inicio < ahoraMs) inicio = F.enUnaHoraEnPunto(ahoraMs); // ya paso: en 1 hora
          recInicio = F.isoLima(inicio);
          recFin = F.isoLima(inicio + 30 * 60 * 1000);
          tieneFecha = true;
        }
      }
      // Los recordatorios con fecha se agregan desde la app (enlace a Google, Outlook o .ics)
      if (!tieneFecha) {
        recordatorioNuevo += ' (PENDIENTE: ' + (fecha ? 'compromiso poco claro' : 'no se dijo fecha') + ', no se agendo en Calendar)';
      }
    }
  }

  const listo = esCliente && (orig.palabras >= orig.minPalabras || alerta !== 'ninguna');

  const salida = Object.assign({}, orig, {
    idioma: idioma,
    nombreIdioma: nombreIdioma,
    traduccion: esCliente ? traduccion : '',
    alerta: alerta,
    motivoRiesgo: motivoRiesgo,
    recordatorioNuevo: recordatorioNuevo,
    recAccion: recAccion,
    recResponsable: recResponsable,
    recFecha: recFecha,
    recInicio: recInicio,
    recFin: recFin,
    listo: listo
  });

  salida.est = est;
  if (est) salida.recordatorios = textoRecordatorios(est.recordatorios);

  if (listo && est) {
    est.analisis = (est.analisis || 0) + 1;
    salida.numeroAnalisis = est.analisis;
    salida.recientes = est.transcripcion.slice(-orig.turnosRecientes).join('\n');
    salida.transcripcion = est.transcripcion.join('\n');
  } else {
    let msg = esCliente
      ? 'Escuchando... frase muy corta. Escribe "analiza" si quieres un consejo ahora.'
      : 'Anotado lo que dijiste. Sigo atento al cliente.';
    if (salida.traduccion) msg = 'TRADUCCION (' + nombreIdioma + '): ' + salida.traduccion + '\n' + msg;
    if (recordatorioNuevo !== 'ninguno') msg += '\nRECORDATORIO GUARDADO: ' + recordatorioNuevo;
    if (recInicio && recAccion) msg += '\nRECORDATORIO FECHA: ' + recInicio + ' | ' + recFin + ' | ' + recAccion + ' | ' + recResponsable;
    salida.output = msg;
  }
  return salida;
}

/* ---------- Preparar copiloto ---------- */
function prepararCopiloto(d, ia) {
  const enVivo = d.modo === 'en_vivo';
  const sistemaFinal = enVivo ? [P.VIVO_BASE, P.VIVO_ENFOQUE[d.enfoque] || P.VIVO_ENFOQUE.descubrimiento, P.VIVO_FORMATO].join('\n\n') : P.SISTEMA;
  let usuario = 'ENFOQUE: ' + d.enfoque + '\n' +
    'MODO: ' + d.modo + '\n' +
    'ALERTA: ' + (d.alerta || 'ninguna') + '\n' +
    'MOTIVO DE RIESGO: ' + (d.motivoRiesgo || 'ninguno') + '\n' +
    'IDIOMA DEL CLIENTE: ' + (d.nombreIdioma || 'espanol') + '\n' +
    'TRADUCCION DEL ULTIMO TURNO: ' + (d.traduccion || 'no aplica (hablo en espanol)') + '\n' +
    'FRASE EN IDIOMA DEL CLIENTE: ' + (d.fraseIdiomaCliente || 'no') + '\n' +
    'RECORDATORIO NUEVO: ' + (d.recordatorioNuevo || 'ninguno') + '\n' +
    (enVivo ? '' : 'RECORDATORIOS DE LA REUNION:\n' + (d.recordatorios || 'ninguno') + '\n') +
    'ESCENARIO: ' + d.escenario + '\n' +
    'OBJETIVO DE LA REUNION: ' + d.objetivo + '\n' +
    'CONTEXTO MIO: ' + String(d.contexto || '').slice(0, enVivo ? 600 : 3000) + '\n' +
    'ESTILO QUE QUIERO: ' + d.estilo + '\n\n' +
    (enVivo ? 'ULTIMOS TURNOS (YO = el usuario, CLIENTE = la otra parte):' : 'TRANSCRIPCION COMPLETA (YO = el usuario, CLIENTE = la otra parte):') + '\n' +
    (enVivo ? d.recientes : d.transcripcion);
  const previas = Array.isArray(d.sugerencias) ? d.sugerencias.filter(Boolean) : [];
  const cortePrevia = enVivo ? 150 : 400;
  const cuantas = enVivo ? 2 : 4;
  if (previas.length) {
    usuario += '\n\nTUS ULTIMAS SUGERENCIAS (no las repitas):\n' +
      previas.slice(-cuantas).map(function (s, i) { return (i + 1) + ') ' + String(s).slice(0, cortePrevia); }).join('\n');
  }
  const maxTok = enVivo ? 300 : 1500;
  return peticionIA(ia, [{ role: 'system', content: sistemaFinal }, { role: 'user', content: usuario }], maxTok, 0.5);
}

/* ---------- Leer respuesta ---------- */
function leerRespuesta(r) {
  r = r || {};
  const texto = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
  if (texto) return String(texto).trim();
  let motivo = (r.error && (r.error.message || r.error.type)) || r.message || 'sin respuesta';
  const todo = JSON.stringify(r);
  if (/api key|apikey|unauthorized|invalid.*key|authentication|401|permission/i.test(todo)) motivo = 'la clave no es válida o no tiene permiso';
  else if (/rate|quota|429|exhausted|limit/i.test(todo)) motivo = 'llegaste al límite de uso de tu cuenta de IA (espera un poco o revisa tu plan)';
  else if (/model/i.test(String(motivo))) motivo = 'el modelo no existe para tu proveedor (' + motivo + ')';
  return '⚠️ Tu IA no respondió: ' + motivo + '. Revisa tu proveedor y tu clave en Ajustes → Tu IA.';
}

/* ---------- Responder ---------- */
function responder(d, sugerencia) {
  const trad = d.traduccion ? 'TRADUCCION (' + d.nombreIdioma + '): ' + d.traduccion + '\n\n' : '';
  let extra = '';
  if (d.recInicio && d.recAccion) {
    extra = '\nRECORDATORIO FECHA: ' + d.recInicio + ' | ' + d.recFin + ' | ' + d.recAccion + ' | ' + (d.recResponsable || '');
  }
  return trad + (sugerencia || '') + extra;
}

/* ---------- Preparar fila (Google Sheets) ---------- */
function filaSheets(d, respuesta, ahoraMs) {
  return [F.marcaLima(ahoraMs), d.sessionId, d.numeroAnalisis || '', d.modo || 'en_vivo', d.chatInput || '', respuesta];
}

/* ---------- Preguntale a tu IA ---------- */
const SISTEMA_PREGUNTAS = [
  'Eres el asistente personal del usuario durante una reunion. El usuario te escribe preguntas mientras la reunion sigue.',
  'Responde SIEMPRE en espanol, claro y directo: maximo 150 palabras, salvo que pida algo mas largo. Usa listas cortas cuando ayuden.',
  'Si la pregunta es sobre la reunion, usa la TRANSCRIPCION y el CONTEXTO DEL USUARIO. No inventes lo que no se dijo: si no esta en la transcripcion, dilo.',
  'Si buscaste en internet, usa datos actuales y menciona de donde salen. Nunca inventes cifras, precios ni nombres.',
  'Cuando un grafico ayude a entender numeros (comparar cosas o ver como cambian en el tiempo), agrega al FINAL un bloque exactamente asi:',
  '```grafico',
  '{"tipo": "barras", "titulo": "Titulo corto", "unidad": "USD", "etiquetas": ["A", "B", "C"], "series": [{"nombre": "Serie 1", "valores": [10, 20, 15]}]}',
  '```',
  'Reglas del grafico: usa "lineas" para cualquier valor a lo largo del tiempo (precios por dia, ventas por mes) y "barras" solo para comparar cosas distintas en un mismo momento; maximo 12 etiquetas y 3 series; cada serie con un valor numerico por etiqueta; solo numeros reales que conozcas, que se dijeron en la reunion o que encontraste. Si no tienes numeros reales, no hagas grafico.',
  'Si haces grafico, no repitas los mismos numeros en una tabla: escribe solo una o dos frases con lo importante (por ejemplo, cuanto subio o bajo). Si no hay grafico y una tabla ayuda, usa una tabla markdown corta.',
  'Si la pregunta depende del pais (moneda, precios, tipo de cambio, leyes, empresas) y el usuario no dice cual, usa el PAIS DEL USUARIO indicado en el contexto y dilo en tu respuesta.'
].join('\n');

function mensajesPregunta(p) {
  const perfil = p.perfil || {};
  const zona = String(p.zona || '').slice(0, 60);
  const PAISES = { 'America/Lima': 'Peru', 'America/Bogota': 'Colombia', 'America/Mexico_City': 'Mexico', 'America/Santiago': 'Chile', 'America/Argentina/Buenos_Aires': 'Argentina', 'America/Guayaquil': 'Ecuador', 'America/La_Paz': 'Bolivia', 'America/Caracas': 'Venezuela', 'Europe/Madrid': 'Espana', 'America/New_York': 'Estados Unidos', 'America/Los_Angeles': 'Estados Unidos', 'America/Chicago': 'Estados Unidos' };
  const pais = PAISES[zona] || (zona ? 'el pais de la zona horaria ' + zona : 'Peru');
  const contexto = 'CONTEXTO DEL USUARIO:\n' +
    'Pais del usuario: ' + pais + '\n' +
    'Escenario: ' + (String(perfil.escenario || '').trim() || 'no indicado') + '\n' +
    'Objetivo: ' + (String(perfil.objetivo || '').trim() || 'no indicado') + '\n' +
    'Sobre mi: ' + (String(perfil.contexto || '').trim().slice(0, 1500) || 'no indicado') + '\n\n' +
    'TRANSCRIPCION DE LA REUNION (YO = el usuario, CLIENTE = la otra parte):\n' +
    (String(p.transcripcion || '').trim().slice(-30000) || '(todavia no hay conversacion)');
  const msgs = [{ role: 'user', content: contexto }, { role: 'assistant', content: 'Entendido. ¿Qué quieres saber?' }];
  (Array.isArray(p.historial) ? p.historial : []).slice(-6).forEach(function (h) {
    if (!h || !h.texto) return;
    msgs.push({ role: h.rol === 'ia' ? 'assistant' : 'user', content: String(h.texto).slice(0, 4000) });
  });
  msgs.push({ role: 'user', content: String(p.pregunta || '').slice(0, 2000) });
  return msgs;
}

module.exports = { SISTEMA_PREGUNTAS, mensajesPregunta, registrar, prepararClasificacion, procesarTurno, prepararCopiloto, leerRespuesta, responder, filaSheets, contarPalabras };
