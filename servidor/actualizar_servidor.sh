#!/bin/sh
# Actualiza el servidor del Copiloto (codigo + app) sin tocar tus claves (.env).
# Uso (como root): sh actualizar_servidor.sh /home/ubuntu/copiloto-servidor-v3.zip
set -e
ZIP="$1"
[ -f "$ZIP" ] || { echo "Uso: sh actualizar_servidor.sh /ruta/al/copiloto-servidor-vX.zip"; exit 1; }
TMP=$(mktemp -d)
unzip -q "$ZIP" -d "$TMP"
RAIZ=$(dirname "$(find "$TMP" -path '*/src/server.js' | head -1)")
RAIZ=$(dirname "$RAIZ")
[ -f "$RAIZ/src/server.js" ] && [ -f "$RAIZ/public/index.html" ] || { echo "El zip no parece del Copiloto"; rm -rf "$TMP"; exit 1; }

# 1) copia de seguridad de lo que hay ahora
rm -rf /opt/copiloto/anterior && mkdir -p /opt/copiloto/anterior
cp -r /opt/copiloto/src /opt/copiloto/public /opt/copiloto/anterior/ 2>/dev/null || true

# 2) codigo y app nuevos (el .env y el certificado NO se tocan)
rm -rf /opt/copiloto/src /opt/copiloto/public
cp -r "$RAIZ/src" "$RAIZ/public" /opt/copiloto/
for f in Dockerfile package.json env.ejemplo actualizar_app.sh actualizar_servidor.sh LEEME.txt; do
  [ -f "$RAIZ/$f" ] && cp "$RAIZ/$f" /opt/copiloto/
done
chmod -R a+rX /opt/copiloto/public
rm -rf "$TMP"

# 3) ajuste para 100 personas: conexiones a Supabase 5 -> 10 (solo si sigue en 5)
grep -q '^DB_POOL_MAX=' /opt/copiloto/.env && sed -i 's/^DB_POOL_MAX=5$/DB_POOL_MAX=10/' /opt/copiloto/.env

# 4) reconstruir y reiniciar solo el copiloto (n8n y caddy siguen igual)
cd /opt/n8n && docker compose up -d --build copiloto
echo "Esperando a que arranque..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  R=$(docker compose exec -T copiloto wget -qO- http://127.0.0.1:3000/healthz 2>/dev/null || true)
  case "$R" in *ok*) echo "LISTO: $R"; echo "App: $(grep -o 'copiloto-v[0-9]*' /opt/copiloto/public/sw.js | head -1)"; exit 0;; esac
done
echo "No respondio bien. Mira el error con:  cd /opt/n8n && docker compose logs --tail 40 copiloto"
echo "Para volver a la version anterior:"
echo "  rm -rf /opt/copiloto/src /opt/copiloto/public && cp -r /opt/copiloto/anterior/* /opt/copiloto/ && cd /opt/n8n && docker compose up -d --build copiloto"
exit 1
