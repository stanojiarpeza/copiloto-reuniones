'use strict';
// Peru no tiene horario de verano: Lima es siempre UTC-5.
const OFFSET_MS = -5 * 60 * 60 * 1000;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']; // igual que Luxon en n8n

function p2(n) { return String(n).padStart(2, '0'); }

// Partes de la fecha/hora de Lima para un instante (ms desde 1970)
function partesLima(ms) {
  const d = new Date(ms + OFFSET_MS);
  return {
    anio: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(),
    hora: d.getUTCHours(), minuto: d.getUTCMinutes(), segundo: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(), diaSemana: d.getUTCDay()
  };
}

function fechaLima(ms) { const p = partesLima(ms); return p.anio + '-' + p2(p.mes) + '-' + p2(p.dia); }

// "jueves 2026-11-19 15:30" (lo que ve la IA para calcular fechas relativas)
function textoHoyLima(ms) {
  const p = partesLima(ms);
  return DIAS[p.diaSemana] + ' ' + fechaLima(ms) + ' ' + p2(p.hora) + ':' + p2(p.minuto);
}

// "2026-11-19 15:30:05" (columna fecha de Google Sheets)
function marcaLima(ms) {
  const p = partesLima(ms);
  return fechaLima(ms) + ' ' + p2(p.hora) + ':' + p2(p.minuto) + ':' + p2(p.segundo);
}

// ISO con zona de Lima, igual que el de n8n/Luxon: 2026-11-20T09:00:00.000-05:00
function isoLima(ms) {
  const p = partesLima(ms);
  return fechaLima(ms) + 'T' + p2(p.hora) + ':' + p2(p.minuto) + ':' + p2(p.segundo) + '.' + String(p.ms).padStart(3, '0') + '-05:00';
}

// "2026-11-20" + "15:00" (hora de Lima) -> ms; null si no es valido
function msDesdeLima(fecha, hora) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha || '');
  const h = /^(\d{1,2}):(\d{2})$/.exec(hora || '');
  if (!m || !h) return null;
  const anio = +m[1], mes = +m[2], dia = +m[3], hh = +h[1], mm = +h[2];
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || hh > 23 || mm > 59) return null;
  const ms = Date.UTC(anio, mes - 1, dia, hh, mm) - OFFSET_MS;
  const p = partesLima(ms);
  if (p.anio !== anio || p.mes !== mes || p.dia !== dia) return null; // 31 de febrero, etc.
  return ms;
}

// Proxima hora en punto despues de "ahora + 1 h" (en Lima)
function enUnaHoraEnPunto(ms) {
  const base = ms + 60 * 60 * 1000;
  return base - (base % (60 * 60 * 1000)); // Lima es UTC-5 exacto: la hora en punto coincide con UTC
}

module.exports = { textoHoyLima, marcaLima, isoLima, msDesdeLima, enUnaHoraEnPunto, fechaLima };
