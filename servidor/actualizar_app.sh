#!/bin/sh
# Pone una version nueva de la app (sin gastar nada).
# Uso (como root): sh /opt/copiloto/actualizar_app.sh /home/ubuntu/copiloto-app-vXX.zip
set -e
ZIP="$1"
[ -f "$ZIP" ] || { echo "Uso: sh actualizar_app.sh /ruta/al/zip-de-la-app"; exit 1; }
TMP=$(mktemp -d)
unzip -q "$ZIP" -d "$TMP"
RAIZ=$(dirname "$(find "$TMP" -name index.html | head -1)")
[ -f "$RAIZ/index.html" ] && [ -f "$RAIZ/sw.js" ] || { echo "El zip no tiene index.html y sw.js"; rm -rf "$TMP"; exit 1; }
rm -rf /opt/copiloto/public.anterior
[ -d /opt/copiloto/public ] && mv /opt/copiloto/public /opt/copiloto/public.anterior
mkdir -p /opt/copiloto/public
cp -r "$RAIZ"/. /opt/copiloto/public/
chmod -R a+rX /opt/copiloto/public
rm -rf "$TMP"
cd /opt/n8n && docker compose restart copiloto >/dev/null
echo "App actualizada. Version: $(grep -o "copiloto-v[0-9]*" /opt/copiloto/public/sw.js | head -1)"
echo "Si algo sale mal, vuelve a la anterior con: rm -rf /opt/copiloto/public && mv /opt/copiloto/public.anterior /opt/copiloto/public && cd /opt/n8n && docker compose restart copiloto"
