// Coteja el corte semanal de la app (laboratorio) contra la pestaña Cortes del Excel real.
const fs = require('fs'), jwt = require('jsonwebtoken');
const SHEET = '1ORDeWCu6k6KTTvhC3fOQSUkGnrSg_fwu9bSkHF0d9OU';
const [DESDE, HASTA] = process.argv.slice(2);
const cr = JSON.parse(fs.readFileSync('/root/bunnyrabbit-staging/gcal-sa.json', 'utf8'));
const num = s => parseFloat(String(s || '0').replace(/[$,\s]/g, '')) || 0;
const fmt = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
(async () => {
  const now = Math.floor(Date.now() / 1000);
  const a = jwt.sign({ iss: cr.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }, cr.private_key, { algorithm: 'RS256' });
  const t = (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: a }) }).then(r => r.json())).access_token;
  const v = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values:batchGet?ranges=${encodeURIComponent("'Cortes'!J3:N3")}&ranges=${encodeURIComponent("'Cortes'!V5:W30")}&ranges=${encodeURIComponent("'Cortes'!X5:AG16")}&ranges=${encodeURIComponent("'Cortes'!X17:AA28")}&valueRenderOption=FORMATTED_VALUE`, { headers: { Authorization: 'Bearer ' + t } }).then(r => r.json());
  const [fechas, res, nom, pag] = v.valueRanges.map(x => x.values || []);
  console.log('Excel calculado para:', (fechas[0] || []).join(' '), '| App:', DESDE, 'a', HASTA);
  const X = {}; res.forEach(r => { if (r[0]) X[r[0].trim()] = num(r[1]); });

  const sec = ((fs.readFileSync('/root/bunnyrabbit-staging/.env', 'utf8').match(/^JWT_SECRET=(.*)$/m) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
  const tok = jwt.sign({ id: 2, rol: 'recepcionista', numero_id: '113038055214763', sucursal: 'Caralinda San Rafael', nombre: 'Vanessa Araceli Peña García' }, sec, { expiresIn: '10m' });
  const d = await fetch(`http://localhost:3001/api/corte/semana?desde=${DESDE}&hasta=${HASTA}`, { headers: { Authorization: 'Bearer ' + tok } }).then(r => r.json());
  if (!d.ok) { console.log('app error', d.error); process.exit(1); }
  const T = d.totales, f = d.fijos;
  const filas = [
    ['Total Semana', T.total_semana], ['Efectivo en Sucursal', T.efectivo], ['Total Tarjeta', T.tarjeta], ['Total Anticipos', T.anticipos],
    ['Transferencias', T.transferencias], ['Sueldos', T.sueldos], ['Total Gastos', T.gastos], ['Total Bonos', T.bonos], ['Total Comisiones', T.comisiones],
    ['Ant. Futuro Transfer', T.af_transfer], ['Ant. Futuro Tarjeta', T.af_tarjeta], ['Propinas Tarjeta', T.propina_tarjeta], ['Propinas Transfer', T.propina_transfer],
    ['Materia Prima', f.materia_prima], ['Impulso', f.impulso], ['Renta', f.renta], ['Corporativo', f.corporativo], ['Comisión BBVA', T.comision_banco], ['Utilidad', T.utilidad]
  ];
  let mal = 0;
  console.log('\nCONCEPTO'.padEnd(24), 'EXCEL'.padStart(14), 'APP'.padStart(14), '');
  filas.forEach(([k, app]) => { const ex = X[k]; const ok = ex !== undefined && Math.abs(ex - app) < 0.005; if (!ok) mal++; console.log(k.padEnd(23), fmt(ex ?? NaN).padStart(14), fmt(app).padStart(14), ok ? ' ✓' : '  ✗ diferencia ' + fmt(app - (ex || 0))); });
  console.log('\nNOMINA (Excel vs App)');
  const tot = {}; pag.slice(1).forEach(r => { if (r[0] && r[0].trim()) tot[r[0].trim().toLowerCase()] = { total: num(r[1]), pagado: num(r[2]), pendiente: num(r[3]) }; });
  nom.slice(1).filter(r => r[0] && r[0].trim()).forEach(r => {
    const nombre = r[0].trim(); const exCom = num(r[1]), exSub = num(r[9]);
    const app = d.nomina.find(n => n.nombre && (n.nombre.toLowerCase() === nombre.toLowerCase() || n.nombre.toLowerCase().startsWith(nombre.split(' ')[0].toLowerCase())));
    const tp = tot[nombre.toLowerCase()] || {};
    const okC = app && Math.abs(app.comisiones - exCom) < 0.005, okS = app && Math.abs(app.subtotal - exSub) < 0.005, okP = app && Math.abs(app.pagado - (tp.pagado || 0)) < 0.005;
    if (!okC || !okS || !okP) mal++;
    console.log('  ' + nombre.padEnd(22), 'comisión', fmt(exCom), '/', app ? fmt(app.comisiones) : '—', okC ? '✓' : '✗', '| subtotal', fmt(exSub), '/', app ? fmt(app.subtotal) : '—', okS ? '✓' : '✗', '| pagado', fmt(tp.pagado || 0), '/', app ? fmt(app.pagado) : '—', okP ? '✓' : '✗');
  });
  console.log(mal ? `\n${mal} renglón(es) con diferencia` : '\nTODO CUADRA ✓');
  process.exit(0);
})().catch(e => { console.log('ERROR', e.message); process.exit(1); });
