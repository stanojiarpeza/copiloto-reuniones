'use strict';
process.env.GOOGLE_CLIENT_ID = 'c'; process.env.GOOGLE_CLIENT_SECRET = 'x'; process.env.CLAVE_CIFRADO = 'k';
process.env.PUBLIC_DIR = require('path').join(__dirname, '../servidor/public');
const pgfalso = require('./pgfalso'); const db = require('../servidor/src/db'); db.usar(new pgfalso.Pool());
const S = require('../servidor/src/server');
(async function () {
  await new Promise(function (r) { S.servidor.listen(0, '127.0.0.1', r); });
  const base = 'http://127.0.0.1:' + S.servidor.address().port;
  const { chromium } = require('playwright');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const errores = [];
  const pg = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  pg.on('pageerror', function (e) { errores.push(e.message); });
  await pg.goto(base + '/'); await pg.waitForTimeout(700);
  await pg.evaluate(function () { abrirGuiaPaso4(); }).catch(async function () {
    await pg.evaluate(function () { var g = document.getElementById('guia'); g.hidden = false; g.dataset.paso = '4'; });
  });
  // usar la funcion real si existe
  await pg.evaluate(function () { if (window.__copiloto && window.__copiloto.abrirGuia) window.__copiloto.abrirGuia(4); });
  await pg.waitForTimeout(300);
  console.log('sin extension -> caja visible:', await pg.isVisible('#gExtCaja'), '· ok visible:', await pg.isVisible('#gExtOk'));
  await pg.screenshot({ path: '/tmp/capturas/guia_paso4.png' });
  await pg.evaluate(function () { window.postMessage({ fuente: 'copiloto-extension', type: 'hola' }, '*'); });
  await pg.waitForTimeout(300);
  console.log('con extension -> caja visible:', await pg.isVisible('#gExtCaja'), '· ok visible:', await pg.isVisible('#gExtOk'));
  const p2 = await (await b.newContext({ viewport: { width: 900, height: 1000 } })).newPage();
  await p2.goto(base + '/instalar-extension.html');
  await p2.screenshot({ path: '/tmp/capturas/instalar_extension.png', fullPage: true });
  const r = await fetch(base + '/extension/copiloto-extension.zip');
  console.log('zip:', r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength, 'bytes');
  console.log('errores:', errores.length ? errores : 'ninguno');
  await b.close(); S.servidor.close(); process.exit(0);
})();
