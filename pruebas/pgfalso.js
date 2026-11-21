'use strict';
// Sustituto de "pg" solo para pruebas: ejecuta la consulta con psql contra el Postgres local.
const { execFileSync } = require('child_process');
function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function parseCsv(txt) {
  const filas = []; let fila = []; let campo = ''; let q = false; let i = 0; let citado = false;
  while (i < txt.length) {
    const ch = txt[i];
    if (q) {
      if (ch === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else q = false; }
      else campo += ch;
    } else if (ch === '"') { q = true; citado = true; }
    else if (ch === ',') { fila.push({ v: campo, c: citado }); campo = ''; citado = false; }
    else if (ch === '\n') { fila.push({ v: campo, c: citado }); filas.push(fila); fila = []; campo = ''; citado = false; }
    else campo += ch;
    i++;
  }
  if (campo !== '' || fila.length) { fila.push({ v: campo, c: citado }); filas.push(fila); }
  return filas;
}
function convertir(f) {
  const v = f.v;
  if (!f.c && v === '<NULL>') return null;
  if (!f.c && (v === 't' || v === 'f')) return v === 't';
  if (/^[\[{]/.test(v)) { try { return JSON.parse(v); } catch (e) {} }
  return v;
}
let llamadas = [];
class Pool {
  constructor() {}
  on() {}
  async query(sql, params) {
    const texto = sql.replace(/\$(\d+)/g, function (_, n) { return literal(params[Number(n) - 1]); });
    llamadas.push({ sql: sql, params: params });
    const out = execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '--csv', '-P', 'null=<NULL>', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      { input: texto + ';\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const filas = parseCsv(out.replace(/\n$/, '\n'));
    if (!filas.length) return { rows: [] };
    const cab = filas[0].map(function (c) { return c.v; });
    const rows = filas.slice(1).filter(function (f) { return f.length === cab.length; }).map(function (f) {
      const o = {}; cab.forEach(function (k, i) { o[k] = convertir(f[i]); }); return o;
    });
    return { rows: rows };
  }
}
module.exports = { Pool, llamadas: function () { return llamadas; }, limpiar: function () { llamadas = []; } };
