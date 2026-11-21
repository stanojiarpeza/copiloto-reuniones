#!/bin/sh
# Instala el servidor del Copiloto (Node.js) junto a Docker Compose y Caddy (carpeta /opt/n8n).
# Uso (como root):  cd /opt/copiloto && sh instalar.sh
set -e
DIR=/opt/copiloto
N8N=/opt/n8n
DOMINIO=${DOMINIO:-copiloto.example.com}
cd "$DIR"

echo "== 1/5 Revisando archivos"
[ -f "$DIR/supabase-ca.crt" ] || { echo "Falta $DIR/supabase-ca.crt (el certificado de Supabase). Copialo y vuelve a correr."; exit 1; }
grep -q "BEGIN CERTIFICATE" "$DIR/supabase-ca.crt" || { echo "supabase-ca.crt no parece un certificado."; exit 1; }
chmod 644 "$DIR/supabase-ca.crt"
[ -f "$N8N/docker-compose.yml" ] && [ -f "$N8N/Caddyfile" ] || { echo "No encuentro $N8N/docker-compose.yml o $N8N/Caddyfile."; exit 1; }

echo "== 2/5 Claves (se guardan solo en $DIR/.env)"
if [ ! -f "$DIR/.env" ]; then
  cp env.ejemplo .env
  printf "Pega el GOOGLE_CLIENT_SECRET y Enter: "; stty -echo; read SECRETO; stty echo; echo
  printf "Pega la CLAVE_CIFRADO (genera una con: openssl rand -hex 32) y Enter: "; stty -echo; read CLAVE; stty echo; echo
  printf "Pega la contrasena de la base de Supabase y Enter: "; stty -echo; read PASS; stty echo; echo
  [ -n "$SECRETO" ] && [ -n "$CLAVE" ] && [ -n "$PASS" ] || { rm -f .env; echo "Falta alguno de los 3 datos. Vuelve a correr."; exit 1; }
  python3 - "$SECRETO" "$CLAVE" "$PASS" <<'PY'
import sys
s=open('.env').read()
s=s.replace('PEGA_AQUI_EL_SECRETO_DEL_CLIENTE',sys.argv[1]).replace('PEGA_AQUI_LA_MISMA_CLAVE_QUE_USABAS_EN_N8N',sys.argv[2]).replace('PEGA_AQUI_LA_CONTRASENA_DE_SUPABASE',sys.argv[3])
open('.env','w').write(s)
PY
  chmod 600 .env
  echo "   .env creado."
else
  echo "   Ya existe .env: se usa el actual."
fi

echo "== 3/5 Agregando el servicio 'copiloto' a $N8N/docker-compose.yml"
if grep -q "^  copiloto:" "$N8N/docker-compose.yml"; then
  echo "   Ya estaba agregado."
else
  cp "$N8N/docker-compose.yml" "$N8N/docker-compose.yml.antes-copiloto"
  python3 - "$N8N/docker-compose.yml" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
bloque='''  copiloto:
    build: /opt/copiloto
    restart: unless-stopped
    env_file: /opt/copiloto/.env
    volumes:
      - /opt/copiloto/public:/app/public:ro
      - /opt/copiloto/supabase-ca.crt:/app/supabase-ca.crt:ro

'''
i=s.find('\nvolumes:')
if i==-1: raise SystemExit('No encontre la seccion volumes: en docker-compose.yml')
s=s[:i+1]+bloque+s[i+1:]
open(p,'w').write(s)
PY
  echo "   Agregado (copia de seguridad: docker-compose.yml.antes-copiloto)."
fi

echo "== 4/5 Agregando $DOMINIO al Caddyfile (candado HTTPS automatico)"
if grep -q "$DOMINIO" "$N8N/Caddyfile"; then
  echo "   Ya estaba."
else
  cp "$N8N/Caddyfile" "$N8N/Caddyfile.antes-copiloto"
  printf '\n%s {\n  encode gzip\n  reverse_proxy copiloto:3000\n}\n' "$DOMINIO" >> "$N8N/Caddyfile"
  echo "   Agregado."
fi

echo "== 5/5 Construyendo y arrancando (tarda 1-2 minutos la primera vez)"
cd "$N8N"
docker compose up -d --build copiloto
docker compose restart caddy
sleep 8
if docker compose exec -T copiloto wget -qO- http://127.0.0.1:3000/healthz 2>/dev/null | grep -q '"ok"'; then
  echo ""
  echo "LISTO: el servidor del Copiloto responde y llega a Supabase."
  echo "Abre https://$DOMINIO en tu navegador (el candado puede tardar 1 minuto la primera vez)."
else
  echo ""
  echo "El servidor arranco pero algo falla. Mira los mensajes con:"
  echo "  cd $N8N && docker compose logs --tail 50 copiloto"
fi
