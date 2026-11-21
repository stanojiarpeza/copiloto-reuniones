-- Esquema de la base de datos del Copiloto de Reuniones (Supabase / PostgreSQL 15+)
-- Ejecutalo una vez en el editor SQL de Supabase.

create extension if not exists pgcrypto;

-- Una fila por cuenta de Google conectada. El refresh token va cifrado con CLAVE_CIFRADO (pgp_sym_encrypt).
create table if not exists usuarios (
  email text primary key,
  refresh_token_cifrado bytea,
  hoja_id text,                         -- Google Sheets propio de la persona
  creado timestamptz default now(),
  actualizado timestamptz default now()
);

-- Cada navegador conectado guarda un token; aqui solo se guarda su hash SHA-256.
create table if not exists dispositivos (
  token_hash bytea primary key,
  email text not null references usuarios(email) on delete cascade,
  creado timestamptz default now()
);

-- Estado de cada reunion en curso (se borra a las 24 horas).
create table if not exists sesiones (
  session_id text primary key,
  email text references usuarios(email) on delete cascade,
  transcripcion jsonb default '[]'::jsonb,
  turnos_cliente int default 0,
  cortos_seguidos int default 0,
  analisis int default 0,
  recordatorios jsonb default '[]'::jsonb,
  sugerencias jsonb default '[]'::jsonb,
  estado text default 'activa',
  inicio timestamptz default now(),
  actualizado timestamptz default now()
);
create index if not exists sesiones_actualizado on sesiones (actualizado);

-- Cupo diario de analisis por persona.
create table if not exists uso_diario (
  email text not null references usuarios(email) on delete cascade,
  dia date not null,
  analisis int not null default 0,
  primary key (email, dia)
);

-- Nadie entra por la API publica de Supabase: solo el servidor, con su usuario de base de datos.
alter table usuarios enable row level security;
alter table dispositivos enable row level security;
alter table sesiones enable row level security;
alter table uso_diario enable row level security;

-- Limpieza automatica todos los dias a las 3:00 a. m. de Lima (8:00 UTC).
create extension if not exists pg_cron;
select cron.unschedule('copiloto-limpieza') where exists (select 1 from cron.job where jobname = 'copiloto-limpieza');
select cron.schedule(
  'copiloto-limpieza',
  '0 8 * * *',
  $$ delete from sesiones where actualizado < now() - interval '24 hours';
     delete from uso_diario where dia < current_date - 30; $$
);
