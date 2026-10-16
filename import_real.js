// Importa AL LABORATORIO los registros reales de una semana desde el Excel real del corte
// (solo lectura): servicios, egresos, pagos (Comisiones Externas) y gastos fijos.
// Quedan con sheet_estado='ok' para que la sincronizacion NO los vuelva a escribir.
// Uso: node import_real.js 2026-10-05 2026-10-11
const fs = require('fs'), jwt = require('jsonwebtoken'), sqlite3 = require('sqlite3');
const SHEET = '1ORDeWCu6k6KTTvhC3fOQSUkGnrSg_fwu9bSkHF0d9OU';
const [DESDE, HASTA] = process.argv.slice(2);
const NUM = '113038055214763', SUC = 'Caralinda San Rafael';
const db = new sqlite3.Database('/root/bunnyrabbit-staging/whatsapp.db');
db.configure('busyTimeout', 15000);   // si la app esta escribiendo, esperar en vez de fallar con SQLITE_BUSY
const all = (q, p) => new Promise((r, j) => db.all(q, p || [], (e, x) => e ? j(e) : r(x)));
const run = (q, p) => new Promise((r, j) => db.run(q, p || [], function (e) { e ? j(e) : r(this); }));
const cr = JSON.parse(fs.readFileSync('/root/bunnyrabbit-staging/gcal-sa.json', 'utf8'));
const n = v => { const x = typeof v === 'number' ? v : parseFloat(String(v || '').replace(/[$,\s]/g, '')); return isNaN(x) ? 0 : x; };
// Serial de Sheets (dias desde 1899-12-30, hora local de la hoja) -> 'YYYY-MM-DD HH:MM:SS'
const serialA = v => new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000)).toISOString().replace('T', ' ').slice(0, 19);
function fecha(v) {
  if (typeof v === 'number') return serialA(v);
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const p = x => String(x || 0).padStart(2, '0');
  return `${m[3]}-${p(m[2])}-${p(m[1])} ${p(m[4])}:${p(m[5])}:${p(m[6])}`;
}
async function token() {
  const now = Math.floor(Date.now() / 1000);
  const a = jwt.sign({ iss: cr.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }, cr.private_key, { algorithm: 'RS256' });
  return (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: a }) }).then(r => r.json())).access_token;
}
(async () => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DESDE || '') || !/^\d{4}-\d{2}-\d{2}$/.test(HASTA || '')) throw new Error('uso: node import_real.js AAAA-MM-DD AAAA-MM-DD');
  const t = await token();
  const rangos = ["'Respuestas de formulario 1'!A2:S", "'Egresos'!A2:D", "'Comisiones Externas'!A2:D", "'Egresos Fijos'!A2:F"];
  const v = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values:batchGet?` + rangos.map(r => 'ranges=' + encodeURIComponent(r)).join('&') + '&valueRenderOption=UNFORMATTED_VALUE', { headers: { Authorization: 'Bearer ' + t } }).then(r => r.json());
  if (v.error) throw new Error(v.error.message);
  const [resp, egr, pag, fij] = v.valueRanges.map(x => x.values || []);
  const enRango = f => f && f.slice(0, 10) >= DESDE && f.slice(0, 10) <= HASTA;

  // colaboradores de la hoja -> usuarios de la app (por nombre_corte)
  const us = await all('SELECT id, nombre, nombre_corte FROM usuarios WHERE nombre_corte IS NOT NULL');
  const mapa = {}; us.forEach(u => { mapa[u.nombre_corte.trim().toLowerCase()] = u; });
  const tasas = {}; (await all('SELECT tipo_servicio, tasa FROM corte_tasas WHERE sucursal IS NULL')).forEach(x => { tasas[x.tipo_servicio] = x.tasa; });

  // limpiar una importacion previa del mismo periodo
  await run("DELETE FROM servicios WHERE event_id LIKE 'real-%' AND date(fecha) BETWEEN date(?) AND date(?)", [DESDE, HASTA]);
  await run("DELETE FROM corte_egresos WHERE creado_por=-1 AND date(fecha) BETWEEN date(?) AND date(?)", [DESDE, HASTA]);
  await run("DELETE FROM corte_pagos WHERE creado_por=-1 AND date(fecha) BETWEEN date(?) AND date(?)", [DESDE, HASTA]);
  await run('DELETE FROM corte_ajustes WHERE periodo_inicio=? AND periodo_fin=?', [DESDE, HASTA]);

  let ns = 0, sinMapa = {};
  for (let i = 0; i < resp.length; i++) {
    const r = resp[i]; const f = fecha(r[0]);
    if (!enRango(f)) continue;
    const colab = String(r[6] || '').trim(); const u = mapa[colab.toLowerCase()];
    if (!u && colab) sinMapa[colab] = (sinMapa[colab] || 0) + 1;
    const tipo = String(r[2] || '').trim(); const precio = n(r[8]);
    const sk = 'servicio:' + String(r[7] || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const tasa = (sk in tasas) ? tasas[sk] : (tasas[tipo] || 0);
    await run(`INSERT INTO servicios (event_id, sucursal, numero_id, fecha, tecnica_id, tecnica_nombre, cliente, telefono, tipo_servicio, servicio, precio,
      pago_anticipo, pago_transfer, pago_tarjeta, pago_efectivo, af_transfer, af_tarjeta, propina_tarjeta, propina_transfer, pigmento, cartuchos, observaciones,
      comision, comision_tasa, creado_por, sheet_estado, sheet_range) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['real-' + (i + 2), SUC, NUM, f, u ? u.id : null, u ? u.nombre : colab, String(r[3] || '').trim(), String(r[1] || '').trim(), tipo, String(r[7] || '').trim(), precio,
        n(r[9]), n(r[10]), n(r[11]), n(r[12]), n(r[13]), n(r[14]), n(r[15]), n(r[16]), String(r[4] || ''), String(r[5] || ''), String(r[17] || '').replace(/^0$/, ''),
        Math.round(precio * tasa * 10000) / 10000, tasa, -1, 'ok', 'Respuestas de formulario 1!A' + (i + 2)]);
    ns++;
  }
  let ne = 0;
  for (let i = 0; i < egr.length; i++) {
    const r = egr[i]; const f = fecha(r[0]); if (!enRango(f)) continue;
    await run('INSERT INTO corte_egresos (sucursal, numero_id, fecha, concepto, cantidad, tipo, creado_por, sheet_estado, sheet_range) VALUES (?,?,?,?,?,?,?,?,?)',
      [SUC, NUM, f.slice(0, 10) + ' 12:00:00', String(r[1] || '').trim(), n(r[2]), String(r[3] || 'Efectivo').trim() || 'Efectivo', -1, 'ok', 'Egresos!A' + (i + 2)]);
    ne++;
  }
  let np = 0; const conceptos = {}; const otros = [];
  for (let i = 0; i < pag.length; i++) {
    const r = pag[i]; const f = fecha(r[0]); if (!enRango(f)) continue;
    const nom = String(r[1] || '').trim(); const u = mapa[nom.toLowerCase()]; const tipo = String(r[3] || '').trim(); const cant = n(r[2]);
    if (/^(pagado|comisi[oó]n)$/i.test(tipo)) {   // 'Comisión' tambien es dinero entregado (confirmado por el usuario)
      await run('INSERT INTO corte_pagos (sucursal, numero_id, fecha, colaborador_id, colaborador_nombre, cantidad, tipo, metodo, creado_por, sheet_estado, sheet_range) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [SUC, NUM, f.slice(0, 10) + ' 12:00:00', u ? u.id : null, u ? u.nombre : nom, cant, /^pagado$/i.test(tipo) ? 'Pagado' : 'Comisión', 'Efectivo', -1, 'ok', 'Comisiones Externas!A' + (i + 2)]);
      np++;
    } else if (u && /^(sueldo|bono semanal|bono mensual)$/i.test(tipo)) {
      const c = conceptos[u.id] = conceptos[u.id] || { u, sueldo: 0, bono_semanal: 0, bono_mensual: 0 };
      c[tipo.toLowerCase().replace(' ', '_')] += cant;
    } else otros.push(`${nom} ${tipo} $${cant}`);
  }
  for (const c of Object.values(conceptos))
    await run(`INSERT INTO corte_ajustes (sucursal, colaborador_id, colaborador_nombre, periodo_inicio, periodo_fin, sueldo, bono_semanal, bono_mensual) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(colaborador_id, periodo_inicio, periodo_fin) DO UPDATE SET sueldo=excluded.sueldo, bono_semanal=excluded.bono_semanal, bono_mensual=excluded.bono_mensual`,
      [SUC, c.u.id, c.u.nombre, DESDE, HASTA, c.sueldo, c.bono_semanal, c.bono_mensual]);
  if (otros.length) console.log('Conceptos de Comisiones Externas no importados (se toman del palomeo o falta definir):', otros.join(' | '));
  // Gastos fijos: semana ISO del lunes del periodo
  const d0 = new Date(DESDE + 'T12:00:00Z'); const th = new Date(d0); th.setUTCDate(d0.getUTCDate() + 3 - ((d0.getUTCDay() + 6) % 7));
  const semana = 1 + Math.round(((th - new Date(Date.UTC(th.getUTCFullYear(), 0, 4))) / 86400000 - 3 + ((new Date(Date.UTC(th.getUTCFullYear(), 0, 4)).getUTCDay() + 6) % 7)) / 7);
  const filaF = fij.find(r => n(r[0]) === th.getUTCFullYear() && n(r[1]) === semana);
  if (filaF) await run(`INSERT INTO corte_fijos (numero_id, periodo_inicio, periodo_fin, materia_prima, impulso, renta, corporativo) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(numero_id, periodo_inicio, periodo_fin) DO UPDATE SET materia_prima=excluded.materia_prima, impulso=excluded.impulso, renta=excluded.renta, corporativo=excluded.corporativo`,
    [NUM, DESDE, HASTA, n(filaF[2]), n(filaF[3]), n(filaF[4]), n(filaF[5])]);

  console.log(`Importado ${DESDE} a ${HASTA}: ${ns} servicios, ${ne} egresos, ${np} pagos | gastos fijos semana ${semana}: ${filaF ? JSON.stringify(filaF.slice(2, 6)) : 'no encontrada'}`);
  if (Object.keys(sinMapa).length) console.log('Colaboradores sin usuario en la app (se importan con su nombre):', JSON.stringify(sinMapa));
  // resumen por colaborador (como la hoja)
  const res = await all(`SELECT COALESCE(tecnica_nombre,'?') col, COUNT(*) n, ROUND(SUM(precio),2) costo, ROUND(SUM(pago_efectivo),2) efe, ROUND(SUM(pago_tarjeta),2) tar,
      ROUND(SUM(pago_anticipo),2) ant, ROUND(SUM(pago_transfer),2) tra, ROUND(SUM(comision),2) com FROM servicios WHERE event_id LIKE 'real-%' AND date(fecha) BETWEEN date(?) AND date(?) GROUP BY col`, [DESDE, HASTA]);
  res.forEach(x => console.log('  ', x.col.padEnd(34), 'serv', String(x.n).padStart(3), '| costo', x.costo, '| efe', x.efe, '| tar', x.tar, '| ant', x.ant, '| tra', x.tra, '| comision app', x.com));
  // servicios con tipo sin tasa (comision 0)
  const sinT = await all(`SELECT tipo_servicio, servicio, COUNT(*) n, SUM(precio) p FROM servicios WHERE event_id LIKE 'real-%' AND date(fecha) BETWEEN date(?) AND date(?) GROUP BY tipo_servicio, servicio ORDER BY n DESC`, [DESDE, HASTA]);
  console.log('Servicios por tipo:'); sinT.forEach(x => console.log('   ', (x.tipo_servicio || '(vacio)').padEnd(18), '|', String(x.servicio).padEnd(28), '| x' + x.n, '| $' + x.p));
  process.exit(0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
