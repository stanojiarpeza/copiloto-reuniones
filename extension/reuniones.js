// Copiloto de Reuniones - lector de subtítulos (Meet, Zoom web, Teams web)
// Lee "quién habla + qué dice" de los subtítulos de la reunión y lo manda al Copiloto.
// Cada plataforma tiene su lector: primero busca la estructura conocida y, si cambió, usa una búsqueda general.
(() => {
  'use strict';
  if (window.__copilotoSubtitulos) return;
  window.__copilotoSubtitulos = true;

  const host = location.hostname;
  const PLATAFORMA = host.includes('meet.google') ? 'meet' : (host.includes('zoom') ? 'zoom' : 'teams');
  const NOMBRE_PLATAFORMA = { meet: 'Meet', zoom: 'Zoom', teams: 'Teams' }[PLATAFORMA];
  const ES_ARRIBA = window === window.top;

  const limpio = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const pareceNombre = (s) => !!s && s.length <= 60 && s.split(' ').length <= 6 && !/[.?!]$/.test(s);

  const ids = new WeakMap();
  let contador = 0;
  const idDe = (el) => { if (!ids.has(el)) ids.set(el, PLATAFORMA + '-' + Date.now().toString(36) + '-' + (++contador)); return ids.get(el); };

  /* ---------------- LECTORES ---------------- */

  function regionMeet() {
    return document.querySelector(
      '[role="region"][aria-label*="ubt" i], [role="region"][aria-label*="aption" i], [role="region"][aria-label*="egend" i]'
    );
  }

  // Como se activan los subtitulos en cada plataforma (lo muestra la insignia)
  const COMO_ACTIVAR = {
    meet: 'toca el botón CC (abajo) para activar los subtítulos',
    zoom: 'toca Subtítulos (CC) → Mostrar subtítulos',
    teams: 'Más (···) → Idioma y voz → Activar subtítulos en directo'
  };
  let sinNombre = false;

  const LECTORES = {
    meet() {
      const region = regionMeet();
      if (!region) return null;
      const out = [];
      // 1) Estructura conocida de Meet
      region.querySelectorAll('.nMcdL').forEach((b) => {
        const n = b.querySelector('.NWpY1d, .KcIKyf, .zs7s8d');
        const t = b.querySelector('.ygicle, .iTTPOb, .bh44bd');
        if (n && t && limpio(t.textContent)) out.push({ el: b, speaker: limpio(n.textContent), text: limpio(t.textContent) });
      });
      if (out.length) return out;
      // 2) Búsqueda general: cada foto de perfil marca el bloque de una persona
      const vistos = new Set();
      region.querySelectorAll('img').forEach((img) => {
        let nombreEl = img.parentElement;
        while (nombreEl && nombreEl !== region && !limpio(nombreEl.textContent)) nombreEl = nombreEl.parentElement;
        if (!nombreEl || nombreEl === region) return;
        const nombre = limpio(nombreEl.textContent);
        if (!pareceNombre(nombre)) return;
        let bloque = nombreEl.parentElement;
        while (bloque && bloque !== region && limpio(bloque.textContent).length <= nombre.length) bloque = bloque.parentElement;
        if (!bloque || vistos.has(bloque)) return;
        vistos.add(bloque);
        const todo = limpio(bloque.textContent);
        const texto = limpio(todo.startsWith(nombre) ? todo.slice(nombre.length) : todo.replace(nombre, ''));
        if (texto) out.push({ el: bloque, speaker: nombre, text: texto });
      });
      return out;
    },

    teams() {
      const textos = document.querySelectorAll('[data-tid="closed-caption-text"]');
      if (!textos.length) {
        return document.querySelector('[data-tid="closed-caption-renderer-wrapper"], [data-tid*="closed-caption"]') ? [] : null;
      }
      const out = [];
      textos.forEach((t) => {
        const cont = t.closest('[data-tid="closed-caption-message"], .fui-ChatMessageCompact, [role="listitem"], li') || t.parentElement;
        const autor = cont && cont.querySelector('[data-tid="author"], [data-tid="closed-caption-author"], .ui-chat__message__author');
        const texto = limpio(t.textContent);
        if (texto) out.push({ el: cont || t, speaker: limpio(autor ? autor.textContent : '') || 'Participante', text: texto });
      });
      return out;
    },

    zoom() {
      const out = [];
      // 1) Panel "Transcripción completa": trae nombre y texto
      let ultimoNombre = '';
      document.querySelectorAll('.lt-full-transcript__item').forEach((it) => {
        const n = it.querySelector('.lt-full-transcript__display-name, .lt-full-transcript__name');
        const m = it.querySelector('.lt-full-transcript__message, .lt-full-transcript__content, .lt-full-transcript__text');
        if (n && limpio(n.textContent)) ultimoNombre = limpio(n.textContent);
        const texto = limpio(m ? m.textContent : '');
        if (texto) out.push({ el: it, speaker: ultimoNombre || 'Participante', text: texto });
      });
      if (out.length) return out;
      // 2) Subtítulo que aparece sobre el video (a veces sin nombre)
      const sub = document.querySelector('#live-transcription-subtitle, .live-transcription-subtitle__box, [class*="live-transcription-subtitle"]');
      if (!sub) return null;
      const linea = limpio(sub.textContent);
      if (!linea) return [];
      const m = linea.match(/^([^:]{1,60}):\s*(.+)$/);      // "Nombre: texto"
      if (m && pareceNombre(limpio(m[1]))) return [{ el: sub, speaker: limpio(m[1]), text: limpio(m[2]) }];
      const activo = hablanteActivoZoom();
      sinNombre = !activo;
      return [{ el: sub, speaker: activo || 'Participante', text: linea }];
    }
  };

  function hablanteActivoZoom() {
    const el = document.querySelector('.speaker-active-container__video-frame .video-avatar__avatar-name, .speaker-bar-container__video-frame--active .video-avatar__avatar-name');
    return el ? limpio(el.textContent) : '';
  }

  /* ---------------- ENVÍO ---------------- */

  const enviados = new Map();   // blockId -> "speaker|text" del último envío
  let personas = new Set();
  let estado = { region: false, appAbierta: null, ultimo: 0 };

  function enviar(datos) {
    try {
      chrome.runtime.sendMessage(Object.assign({ destino: 'app', plataforma: PLATAFORMA }, datos), (r) => {
        if (chrome.runtime.lastError) return;
        if (r) estado.appAbierta = r.appAbierta;
      });
    } catch (e) { /* la extensión se recargó: hay que recargar la página */ }
  }

  function leer() {
    let bloques = null;
    try { bloques = LECTORES[PLATAFORMA](); } catch (e) { bloques = null; }
    estado.region = bloques !== null;
    if (estado.region && !ES_ARRIBA) { try { window.top.postMessage({ copilotoSubtitulosEnMarco: true }, '*'); } catch (e) {} }
    (bloques || []).forEach((b) => {
      if (!b.text) return;
      const id = idDe(b.el);
      const firma = b.speaker + '|' + b.text;
      if (enviados.get(id) === firma) return;
      enviados.set(id, firma);
      personas.add(b.speaker);
      estado.ultimo = Date.now();
      enviar({ type: 'caption', blockId: id, speaker: b.speaker, text: b.text, t: Date.now() });
    });
    if (enviados.size > 400) { const claves = Array.from(enviados.keys()); claves.slice(0, 200).forEach((k) => enviados.delete(k)); }
    pintarInsignia();
  }

  let pendiente = false;
  function programar() {
    if (pendiente) return;
    pendiente = true;
    setTimeout(() => { pendiente = false; leer(); }, 250);
  }
  new MutationObserver(programar).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  setInterval(leer, 1500);

  /* ---------------- INSIGNIA EN LA REUNIÓN ---------------- */

  let insignia = null;
  let subtitulosEnMarco = false;
  window.addEventListener('message', (e) => { if (e.data && e.data.copilotoSubtitulosEnMarco) subtitulosEnMarco = true; });

  function pintarInsignia() {
    const mostrar = estado.region || (ES_ARRIBA && !subtitulosEnMarco);
    if (!mostrar) { if (insignia) insignia.style.display = 'none'; return; }
    if (!insignia) {
      insignia = document.createElement('div');
      insignia.setAttribute('data-copiloto', 'insignia');
      insignia.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#0e1316;color:#e8eef1;' +
        'font:600 12px/1.35 system-ui,Segoe UI,sans-serif;padding:8px 10px;border-radius:10px;border:1px solid #5eead4;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:320px;cursor:default;opacity:.92';
      insignia.title = 'Copiloto de Reuniones';
      (document.body || document.documentElement).appendChild(insignia);
    }
    insignia.style.display = '';
    let txt, borde = '#5eead4';
    if (!estado.region) {
      txt = 'Copiloto · ' + NOMBRE_PLATAFORMA + ': ' + COMO_ACTIVAR[PLATAFORMA];
      borde = '#f5b84b';
    } else if (estado.appAbierta === false) {
      txt = 'Copiloto · subtítulos leídos, pero la app del Copiloto no está abierta';
      borde = '#ff7a59';
    } else {
      const n = personas.size;
      txt = 'Copiloto · ' + NOMBRE_PLATAFORMA + ': leyendo subtítulos' + (n ? ' (' + n + (n === 1 ? ' persona)' : ' personas)') : '');
      // En Zoom, el subtitulo sobre el video a veces no trae el nombre: el panel de transcripcion si
      if (PLATAFORMA === 'zoom' && sinNombre && !document.querySelector('.lt-full-transcript__item')) txt += ' · para ver nombres abre «Ver transcripción completa»';
    }
    if (insignia.textContent !== txt) insignia.textContent = txt;
    insignia.style.borderColor = borde;
  }

  /* ---------------- DIAGNÓSTICO (para ajustar el lector si la plataforma cambia) ---------------- */

  function diagnostico() {
    let bloques = null;
    try { bloques = LECTORES[PLATAFORMA](); } catch (e) { bloques = 'error: ' + e.message; }
    const candidatos = Array.from(document.querySelectorAll(
      '[role="region"][aria-label], [aria-live], [data-tid*="caption" i], [class*="caption" i], [class*="subtitle" i], [class*="transcript" i]'
    )).filter((el) => limpio(el.textContent)).slice(0, 6);
    const partes = candidatos.map((el, i) => {
      const html = el.outerHTML.replace(/<(svg|path|style|script)[\s\S]*?<\/\1>/gi, '').replace(/\s(src|srcset|href)="[^"]*"/gi, '');
      return '--- candidato ' + (i + 1) + ' ---\n' + html.slice(0, 6000);
    });
    return [
      'Copiloto · diagnóstico de subtítulos',
      'Plataforma: ' + NOMBRE_PLATAFORMA + ' · ' + location.origin + location.pathname,
      'Marco: ' + (ES_ARRIBA ? 'principal' : 'interno'),
      'Lector: ' + (bloques === null ? 'no encontró subtítulos' : (Array.isArray(bloques) ? bloques.length + ' bloques -> ' + JSON.stringify(bloques.slice(-3).map((b) => ({ quien: b.speaker, texto: b.text.slice(0, 80) }))) : bloques)),
      '',
      partes.join('\n\n') || '(no se encontraron elementos de subtítulos en esta página)'
    ].join('\n');
  }

  chrome.runtime.onMessage.addListener((msg, remitente, responder) => {
    if (msg && msg.tipo === 'diagnostico') {
      if (!ES_ARRIBA && !estado.region) return;   // en marcos internos solo responde si ahí están los subtítulos
      responder({ texto: diagnostico(), region: estado.region, plataforma: NOMBRE_PLATAFORMA, personas: Array.from(personas) });
    }
  });

  leer();
})();
