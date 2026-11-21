// Corre dentro de la página del Copiloto: entrega a la app lo que llega de la reunión
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.destino === 'app') {
    window.postMessage(Object.assign({ fuente: 'copiloto-extension' }, msg), location.origin);
  }
});
// Avisa a la app que la extensión está instalada
window.postMessage({ fuente: 'copiloto-extension', type: 'lista', version: chrome.runtime.getManifest().version }, location.origin);
