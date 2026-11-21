const APP_URL = 'https://copiloto.example.com/';
const APPS = ['https://copiloto.example.com/*'];
const estado = document.getElementById('estado');
const nota = document.getElementById('nota');

document.getElementById('abrir').addEventListener('click', () => {
  chrome.tabs.query({ url: APPS }, (t) => {
    if (t && t.length) { chrome.tabs.update(t[0].id, { active: true }); chrome.windows.update(t[0].windowId, { focused: true }); }
    else chrome.tabs.create({ url: APP_URL });
  });
});

function pedirDiagnostico(alTerminar) {
  chrome.tabs.query({ active: true, currentWindow: true }, (t) => {
    if (!t || !t.length) return alTerminar(null);
    chrome.tabs.sendMessage(t[0].id, { tipo: 'diagnostico' }, (r) => {
      if (chrome.runtime.lastError) return alTerminar(null);
      alTerminar(r || null);
    });
  });
}

pedirDiagnostico((r) => {
  if (!r) {
    estado.innerHTML = 'Abre esta ventana <b>estando en la pestaña de la reunión</b> (Meet, Zoom web o Teams web).';
    return;
  }
  if (r.region) {
    estado.innerHTML = '<span class="ok">✓ ' + r.plataforma + ': leyendo subtítulos.</span><br>' +
      (r.personas.length ? 'Personas detectadas: ' + r.personas.map((p) => p.replace(/</g, '&lt;')).join(', ') : 'Aún nadie ha hablado.');
  } else {
    var COMO = {
      Meet: 'En la barra de abajo toca el botón <b>CC</b> (Activar subtítulos).',
      Zoom: 'En la barra de abajo toca <b>Subtítulos</b> (CC) → <b>Mostrar subtítulos</b>. Para ver nombres, abre también <b>Ver transcripción completa</b>.',
      Teams: 'Toca <b>Más (···)</b> → <b>Idioma y voz</b> → <b>Activar subtítulos en directo</b>.'
    };
    estado.innerHTML = '<span class="aviso">' + r.plataforma + ': no veo subtítulos.</span><br>' + (COMO[r.plataforma] || 'Actívalos en la reunión (botón CC o "Subtítulos").');
  }
});

document.getElementById('diag').addEventListener('click', () => {
  pedirDiagnostico(async (r) => {
    if (!r) { nota.textContent = 'Abre la pestaña de la reunión y vuelve a intentarlo.'; return; }
    try { await navigator.clipboard.writeText(r.texto); nota.textContent = '✓ Diagnóstico copiado. Pégalo en el chat (Ctrl + V).'; }
    catch (e) { nota.textContent = 'No se pudo copiar automáticamente.'; }
  });
});
