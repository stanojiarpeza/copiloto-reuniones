// Recibe los subtítulos de la pestaña de la reunión y se los pasa a la pestaña del Copiloto
// Donde está abierta la app del Copiloto
const APP = ['https://copiloto.example.com/*'];

chrome.runtime.onMessage.addListener((msg, remitente, responder) => {
  if (!msg || msg.destino !== 'app') return;
  chrome.tabs.query({ url: APP }, (pestanas) => {
    (pestanas || []).forEach((t) => {
      chrome.tabs.sendMessage(t.id, msg, () => void chrome.runtime.lastError);
    });
    responder({ appAbierta: !!(pestanas && pestanas.length) });
  });
  return true; // respuesta asincrona
});
