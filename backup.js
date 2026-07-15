// Respaldo diario de la base. Uso: node backup.js
// Usa VACUUM INTO en vez de copiar el archivo: genera una copia consistente
// aunque la app este escribiendo en ese momento (un cp puede dar una base corrupta).
// Verifica el respaldo antes de darlo por bueno y rota los antiguos.
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const ORIGEN = process.env.DB_ORIGEN || '/root/bunnyrabbit-whatsapp/whatsapp.db';
const DEST = process.env.DB_DEST || '/root/backups-bunnyrabbit/db';
const DIAS_RETENCION = parseInt(process.env.DIAS_RETENCION || '14', 10);

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[${ts()}] ${m}`);

function pad(n) { return String(n).padStart(2, '0'); }
function sello() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

(async () => {
  if (!fs.existsSync(ORIGEN)) { log(`ERROR: no existe ${ORIGEN}`); process.exit(1); }
  fs.mkdirSync(DEST, { recursive: true });

  const tmp = path.join(DEST, `whatsapp_${sello()}.db`);

  // 1) Copia consistente
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(ORIGEN, sqlite3.OPEN_READONLY, (e) => { if (e) reject(e); });
    db.run(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`, (e) => {
      db.close();
      e ? reject(e) : resolve();
    });
  });

  // 2) Verificar que el respaldo sirve ANTES de fiarnos de el
  const filas = await new Promise((resolve, reject) => {
    const b = new sqlite3.Database(tmp, sqlite3.OPEN_READONLY, (e) => { if (e) reject(e); });
    b.get('PRAGMA integrity_check', (e, r) => {
      if (e) { b.close(); return reject(e); }
      const ok = r && (r.integrity_check === 'ok');
      if (!ok) { b.close(); return reject(new Error('integrity_check fallo: ' + JSON.stringify(r))); }
      b.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`, (e2, tablas) => {
        if (e2) { b.close(); return reject(e2); }
        b.get('SELECT (SELECT COUNT(*) FROM mensajes) m, (SELECT COUNT(*) FROM contactos) c, (SELECT COUNT(*) FROM numeros) n', (e3, cnt) => {
          b.close();
          e3 ? reject(e3) : resolve({ tablas: tablas.length, ...cnt });
        });
      });
    });
  });
  log(`copia verificada: ${filas.tablas} tablas, ${filas.m} mensajes, ${filas.c} contactos, ${filas.n} numeros`);

  // 3) Comprimir
  const gz = tmp + '.gz';
  await new Promise((resolve, reject) => {
    fs.createReadStream(tmp)
      .pipe(zlib.createGzip({ level: 9 }))
      .pipe(fs.createWriteStream(gz))
      .on('finish', resolve).on('error', reject);
  });
  fs.unlinkSync(tmp);
  const kb = (fs.statSync(gz).size / 1024).toFixed(1);
  log(`respaldo creado: ${path.basename(gz)} (${kb} KB)`);

  // 4) Rotar: borrar los mas viejos que DIAS_RETENCION
  const limite = Date.now() - DIAS_RETENCION * 24 * 3600 * 1000;
  let borrados = 0;
  for (const f of fs.readdirSync(DEST)) {
    if (!/^whatsapp_.*\.db\.gz$/.test(f)) continue;
    const p = path.join(DEST, f);
    if (fs.statSync(p).mtimeMs < limite) { fs.unlinkSync(p); borrados++; }
  }
  const quedan = fs.readdirSync(DEST).filter(f => /^whatsapp_.*\.db\.gz$/.test(f)).length;
  log(`rotacion: ${borrados} borrado(s), ${quedan} respaldo(s) en total (retencion ${DIAS_RETENCION} dias)`);
  process.exit(0);
})().catch(e => { log('ERROR: ' + e.message); process.exit(1); });
