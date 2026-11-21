'use strict';
// Conexion a Supabase (PostgreSQL). Las mismas tablas y consultas que usaban los flujos de n8n.
const fs = require('fs');

let pool = null;

function crearPool(cfg) {
  const { Pool } = require('pg');
  const ssl = cfg.dbSsl === 'off' ? false : {
    rejectUnauthorized: true,
    ca: cfg.dbCaFile ? fs.readFileSync(cfg.dbCaFile, 'utf8') : undefined
  };
  pool = new Pool({
    host: cfg.dbHost, port: cfg.dbPort, database: cfg.dbName, user: cfg.dbUser, password: cfg.dbPassword,
    ssl: ssl, max: cfg.dbMax, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000
  });
  pool.on('error', function (e) { console.error('[db] conexion perdida:', e.message); });
  return pool;
}

// Permite cambiar la conexion en las pruebas
function usar(p) { pool = p; }

async function q(sql, params) {
  const r = await pool.query(sql, params || []);
  return r.rows;
}

// ---------- Copiloto ----------
// Quien es (por el token del equipo), cuanto uso hoy y, si se pide, la reunion guardada
async function leerContexto(sessionId, appToken, incluirSesion) {
  const rows = await q(
    `with yo as (select d.email from dispositivos d where d.token_hash = digest($2::text, 'sha256'))
     select
       (select email from yo) as email,
       case when $3::boolean then (select to_jsonb(s) from sesiones s where s.session_id = $1::text) end as sesion,
       coalesce((select u.analisis from uso_diario u
                 where u.email = (select email from yo)
                   and u.dia = (now() at time zone 'America/Lima')::date), 0) as uso_hoy`,
    [sessionId, appToken, !!incluirSesion]
  );
  return rows[0] || {};
}

async function guardarSesion(d) {
  const est = d.est || {};
  const rows = await q(
    `with s as (
       insert into sesiones (session_id, email, transcripcion, turnos_cliente, cortos_seguidos, analisis, recordatorios, estado, actualizado)
       select $1::text, nullif($2::text, ''), $3::jsonb, $4::int, $5::int, $6::int, $7::jsonb, $8::text, now()
       where $10::text <> 'si'
       on conflict (session_id) do update set
         email = coalesce(excluded.email, sesiones.email),
         transcripcion = excluded.transcripcion,
         turnos_cliente = excluded.turnos_cliente,
         cortos_seguidos = excluded.cortos_seguidos,
         analisis = excluded.analisis,
         recordatorios = excluded.recordatorios,
         estado = excluded.estado,
         actualizado = now()
       where sesiones.email is null or sesiones.email = excluded.email
       returning 1
     ),
     u as (
       insert into uso_diario (email, dia, analisis)
       select $2::text, (now() at time zone 'America/Lima')::date, 1
       where $9::text = 'si' and $2::text <> ''
       on conflict (email, dia) do update set analisis = uso_diario.analisis + 1
       returning 1
     )
     select (select count(*) from s) as sesion_guardada, (select count(*) from u) as uso_sumado`,
    [d.sessionId, d.email || '', JSON.stringify(est.transcripcion || []), est.turnosCliente || 0, est.cortosSeguidos || 0,
     est.analisis || 0, JSON.stringify(est.recordatorios || []), est.estado || 'activa',
     d.listo === true ? 'si' : 'no', d.noGuardar === true ? 'si' : 'no']
  );
  return { sesionGuardada: Number((rows[0] || {}).sesion_guardada || 0) > 0 };
}

// Guarda las ultimas 4 sugerencias, de la mas antigua a la mas nueva
// (en n8n quedaban al reves y el copiloto veia las mas viejas)
async function recordarSugerencia(sessionId, email, texto) {
  await q(
    `update sesiones set sugerencias = (
       select coalesce(jsonb_agg(x order by n), '[]'::jsonb) from (
         select x, n from jsonb_array_elements(coalesce(sugerencias, '[]'::jsonb) || jsonb_build_array($2::text))
           with ordinality t(x, n) order by n desc limit 4) y)
     where session_id = $1::text and (email is null or email = nullif($3::text, ''))`,
    [sessionId, texto, email || '']
  );
}

async function leerLlave(email, claveCifrado) {
  const rows = await q(
    `select hoja_id, pgp_sym_decrypt(refresh_token_cifrado, $2::text) as rt
     from usuarios where email = $1::text and refresh_token_cifrado is not null and hoja_id is not null`,
    [email, claveCifrado]
  );
  return rows[0] || null;
}

// ---------- Conectar Google ----------
async function buscarUsuario(email) {
  const rows = await q(
    `select (select count(*) from usuarios)::int as total,
            u.hoja_id, (u.refresh_token_cifrado is not null) as tiene_llave, (u.email is not null) as existe
     from (select 1) x left join usuarios u on u.email = $1::text`,
    [email]
  );
  return rows[0] || {};
}

async function guardarUsuario(email, refreshToken, claveCifrado, hojaId) {
  const rows = await q(
    `with t as (select encode(gen_random_bytes(24), 'hex') as tok),
     u as (
       insert into usuarios (email, refresh_token_cifrado, hoja_id, actualizado)
       values ($1::text, pgp_sym_encrypt(nullif($2::text, ''), $3::text), nullif($4::text, ''), now())
       on conflict (email) do update set
         refresh_token_cifrado = coalesce(excluded.refresh_token_cifrado, usuarios.refresh_token_cifrado),
         hoja_id = coalesce(excluded.hoja_id, usuarios.hoja_id),
         actualizado = now()
       returning email, hoja_id
     ),
     d as (
       insert into dispositivos (token_hash, email)
       select digest(t.tok, 'sha256'), u.email from t, u
       returning 1
     )
     select u.email, u.hoja_id, t.tok as app_token from u, t`,
    [email, refreshToken || '', claveCifrado, hojaId || '']
  );
  return rows[0] || null;
}

// ---------- Desconectar ----------
async function quitarEquipoOCuenta(appToken, borrarTodo) {
  const rows = await q(
    `with yo as (select email from dispositivos where token_hash = digest($1::text, 'sha256')),
     quita_equipo as (
       delete from dispositivos where token_hash = digest($1::text, 'sha256') and $2::text <> 'si' returning 1
     ),
     borra_cuenta as (
       delete from usuarios where $2::text = 'si' and email = (select email from yo) returning 1
     )
     select (select email from yo) as email,
            (select count(*) from quita_equipo) as equipos_quitados,
            (select count(*) from borra_cuenta) as cuentas_borradas`,
    [appToken || 'sin-token', borrarTodo ? 'si' : 'no']
  );
  return rows[0] || {};
}

// Una pregunta a la IA cuenta como un analisis del dia (protege el limite diario)
async function sumarUso(email) {
  await q(
    `insert into uso_diario (email, dia, analisis) values ($1::text, (now() at time zone 'America/Lima')::date, 1)
     on conflict (email, dia) do update set analisis = uso_diario.analisis + 1`,
    [email]
  );
}

async function ping() { await q('select 1'); }

module.exports = { crearPool, usar, leerContexto, guardarSesion, recordarSugerencia, leerLlave, buscarUsuario, guardarUsuario, quitarEquipoOCuenta, sumarUso, ping };
