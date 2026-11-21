#!/bin/sh
id pgt >/dev/null 2>&1 || useradd -m pgt
NUEVA=0
if [ ! -f /tmp/pgdata/PG_VERSION ]; then rm -rf /tmp/pgdata; mkdir -p /tmp/pgdata; chown pgt /tmp/pgdata; su pgt -c "/usr/lib/postgresql/16/bin/initdb -D /tmp/pgdata -U postgres --auth=trust >/tmp/initdb.log 2>&1"; NUEVA=1; fi
psql -h /tmp -p 5433 -U postgres -Atc "select 1" >/dev/null 2>&1 && exit 0
rm -f /tmp/pgdata/postmaster.pid; chown -R pgt /tmp/pgdata
su pgt -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -o '-p 5433 -k /tmp -c listen_addresses=' -l /tmp/pg.log start" >/dev/null; sleep 2
if [ "$NUEVA" = 1 ]; then psql -h /tmp -p 5433 -U postgres -q <<'SQL'
create extension if not exists pgcrypto;
create table usuarios (email text primary key, refresh_token_cifrado bytea, hoja_id text, creado timestamptz default now(), actualizado timestamptz default now());
create table sesiones (session_id text primary key, email text references usuarios(email) on delete cascade, transcripcion jsonb default '[]'::jsonb, turnos_cliente int default 0, cortos_seguidos int default 0, analisis int default 0, recordatorios jsonb default '[]'::jsonb, estado text default 'activa', inicio timestamptz default now(), actualizado timestamptz default now(), sugerencias jsonb default '[]'::jsonb);
create table dispositivos (token_hash bytea primary key, email text not null references usuarios(email) on delete cascade, creado timestamptz default now());
create table uso_diario (email text not null references usuarios(email) on delete cascade, dia date not null, analisis int not null default 0, primary key (email, dia));
SQL
fi
