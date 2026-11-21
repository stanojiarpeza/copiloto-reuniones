#!/bin/sh
# Respaldo diario de la base de datos de Supabase (usuarios, cuentas conectadas, sesiones, uso diario).
# Lee la conexion de /opt/copiloto/.env (no guarda ni muestra la contrasena).
# Guarda en /opt/respaldos/supabase-AAAA-MM-DD.dump y conserva los ultimos 14 dias.
set -e
ENV=/opt/copiloto/.env
DESTINO=/opt/respaldos
DIAS=14
val() { grep -m1 "^$1=" "$ENV" | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//'; }

HOST=$(val DB_HOST); PUERTO=$(val DB_PORT); BASE=$(val DB_NAME); USUARIO=$(val DB_USER)
PGPASSWORD=$(val DB_PASSWORD); export PGPASSWORD
[ -n "$HOST" ] && [ -n "$USUARIO" ] && [ -n "$PGPASSWORD" ] || { echo "Faltan datos de conexion en $ENV"; exit 1; }

mkdir -p "$DESTINO"; chmod 700 "$DESTINO"
ARCHIVO="supabase-$(date +%F).dump"

# pg_dump desde un contenedor (no hay que instalar nada); postgres:17 sirve para Supabase 15, 16 y 17
docker run --rm -e PGPASSWORD -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/ca.crt \
  -v /opt/copiloto/supabase-ca.crt:/ca.crt:ro -v "$DESTINO":/out \
  postgres:17-alpine pg_dump -h "$HOST" -p "${PUERTO:-5432}" -U "$USUARIO" -d "${BASE:-postgres}" \
  --schema=public --no-owner --no-privileges -Fc -f "/out/$ARCHIVO.tmp"

mv "$DESTINO/$ARCHIVO.tmp" "$DESTINO/$ARCHIVO"
chmod 600 "$DESTINO/$ARCHIVO"
find "$DESTINO" -name 'supabase-*.dump' -mtime +$DIAS -delete
echo "Respaldo listo: $DESTINO/$ARCHIVO ($(du -h "$DESTINO/$ARCHIVO" | cut -f1))"
