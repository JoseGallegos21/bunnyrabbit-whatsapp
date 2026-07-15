const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();


const multer = require('multer');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(require('express').static('public'));

const multerStorage = multer.diskStorage({
  destination: function(req, file, cb){ cb(null, './public/uploads/'); },
  filename: function(req, file, cb){
    const ext = path.extname(file.originalname);
    cb(null, 'img_' + Date.now() + ext);
  }
});
const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function(req, file, cb){
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});


const db = new sqlite3.Database('./whatsapp.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY, nombre TEXT, email TEXT UNIQUE, password TEXT, numero_id TEXT, sucursal TEXT, rol TEXT DEFAULT 'recepcionista', telefono TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS mensajes (id INTEGER PRIMARY KEY, numero_id TEXT, contacto TEXT, mensaje TEXT, direccion TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, leido INTEGER DEFAULT 0, origen TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS numeros (id INTEGER PRIMARY KEY, nombre TEXT, sucursal TEXT, phone_number_id TEXT UNIQUE, token TEXT, waba_id TEXT, pixel_id TEXT, capi_token TEXT, capi_version TEXT DEFAULT 'v21.0', capi_test_code TEXT, capi_activo INTEGER DEFAULT 0, capi_triggers TEXT DEFAULT '[]')`);
  db.run(`CREATE TABLE IF NOT EXISTS contactos (id INTEGER PRIMARY KEY, telefono TEXT UNIQUE, nombre TEXT, notas TEXT, etapa TEXT DEFAULT 'Nuevo', prioridad TEXT DEFAULT 'Media', sucursal TEXT, numero_id TEXT, origen TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS etiquetas (id INTEGER PRIMARY KEY, nombre TEXT UNIQUE, color TEXT DEFAULT '#075e54', usuario_id INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS contacto_etiquetas (contacto_id INTEGER, etiqueta_id INTEGER, PRIMARY KEY (contacto_id, etiqueta_id))`);

  // Tablas adicionales que usa la app (antes no se creaban al arrancar)
  db.run(`CREATE TABLE IF NOT EXISTS plantillas (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, categoria TEXT DEFAULT 'General', contenido TEXT, phone_number_id TEXT, estado_meta TEXT DEFAULT 'pendiente', meta_template_id TEXT, idioma TEXT DEFAULT 'es', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS difusiones (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, mensaje TEXT, filtro_etapa TEXT, total INTEGER DEFAULT 0, enviados INTEGER DEFAULT 0, estado TEXT DEFAULT 'pendiente', phone_number_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS citas (id INTEGER PRIMARY KEY AUTOINCREMENT, contacto_id INTEGER, tecnica_id INTEGER, recepcionista_id INTEGER, numero_id TEXT, sucursal TEXT, fecha TEXT, hora_inicio TEXT, hora_fin TEXT, servicio TEXT, notas TEXT, estado TEXT DEFAULT 'pendiente', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS sucursales (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, direccion TEXT, phone_number_id TEXT, logo_url TEXT, activo INTEGER DEFAULT 1)`);
  db.run(`CREATE TABLE IF NOT EXISTS biblioteca_imagenes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, url TEXT, subido_por INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS respuestas_rapidas (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER, titulo TEXT, contenido TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS facebook_capi_config (id INTEGER PRIMARY KEY AUTOINCREMENT, pixel_id TEXT, access_token TEXT, test_event_code TEXT, api_version TEXT DEFAULT 'v21.0', triggers TEXT DEFAULT '[]', activo INTEGER DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS facebook_capi_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, contacto_nombre TEXT, contacto_telefono TEXT, evento_tipo TEXT, etapa TEXT, event_id TEXT, status_code INTEGER, respuesta TEXT, numero_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS google_calendar_config (id INTEGER PRIMARY KEY AUTOINCREMENT, sucursal TEXT UNIQUE, calendar_id TEXT, access_token TEXT, refresh_token TEXT, activo INTEGER DEFAULT 1)`);

  // Auto-reparar columnas faltantes en bases creadas con esquemas antiguos (idempotente)
  const ensureColumns = (tabla, columnas) => {
    db.all(`PRAGMA table_info(${tabla})`, [], (err, cols) => {
      if (err || !cols) return;
      const existentes = cols.map(c => c.name);
      columnas.forEach(([col, tipo]) => {
        if (!existentes.includes(col)) {
          db.run(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${tipo}`, [], () => {});
        }
      });
    });
  };
  ensureColumns('usuarios', [['telefono', 'TEXT']]);
  ensureColumns('plantillas', [['idioma', "TEXT DEFAULT 'es'"]]);
  ensureColumns('mensajes', [['origen', 'TEXT']]);
  ensureColumns('contactos', [['origen', 'TEXT']]);
  ensureColumns('etiquetas', [['usuario_id', 'INTEGER']]);
  ensureColumns('numeros', [
    ['waba_id', 'TEXT'],
    ['pixel_id', 'TEXT'], ['capi_token', 'TEXT'], ['capi_version', "TEXT DEFAULT 'v21.0'"],
    ['capi_test_code', 'TEXT'], ['capi_activo', 'INTEGER DEFAULT 0'], ['capi_triggers', "TEXT DEFAULT '[]'"]
  ]);
});

// Resuelve el número desde el que se envía.
// - recepcionista/técnica: siempre el suyo
// - admin/supervisor: el que indiquen, o el suyo, o el único configurado si solo hay uno
function resolverNumeroEnvio(req, numeroIdBody) {
  return new Promise((resolve) => {
    const mando = req.user.rol === 'supervisor' || req.user.rol === 'admin';
    const nid = mando ? (numeroIdBody || req.user.numero_id) : req.user.numero_id;
    if (nid) {
      db.get('SELECT * FROM numeros WHERE phone_number_id=?', [nid], (e, row) => resolve(row || null));
    } else if (mando) {
      db.all('SELECT * FROM numeros WHERE token IS NOT NULL AND token!=""', [], (e, rows) => {
        resolve(rows && rows.length === 1 ? rows[0] : null);
      });
    } else resolve(null);
  });
}

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); } catch { res.status(401).json({ error: 'Token inválido' }); }
};

app.post('/api/upload', auth, upload.single('imagen'), (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'No se subio ningun archivo' });
  const url = 'https://bunnyrabbit.lat/uploads/' + req.file.filename;
  res.json({ ok: true, url: url });
});


// ===== BIBLIOTECA DE IMÁGENES =====
const uploadBiblioteca = multer({
  storage: multer.diskStorage({
    destination: function(req, file, cb){ cb(null, './public/uploads/'); },
    filename: function(req, file, cb){
      const ext = require('path').extname(file.originalname);
      cb(null, 'bib_' + Date.now() + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function(req, file, cb){
    cb(null, /jpeg|jpg|png|gif|webp/.test(require('path').extname(file.originalname).toLowerCase()));
  }
});

app.post('/api/biblioteca', auth, uploadBiblioteca.single('imagen'), (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'No se subio imagen' });
  const url = 'https://bunnyrabbit.lat/uploads/' + req.file.filename;
  const nombre = req.body.nombre || req.file.originalname;
  db.run('INSERT INTO biblioteca_imagenes (nombre, url, subido_por) VALUES (?, ?, ?)',
    [nombre, url, req.user.id], function(err) {
      if(err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, id: this.lastID, url: url });
    });
});

app.get('/api/biblioteca', auth, (req, res) => {
  db.all('SELECT b.*, u.nombre as subido_por_nombre FROM biblioteca_imagenes b LEFT JOIN usuarios u ON b.subido_por=u.id ORDER BY b.created_at DESC', [], (err, rows) => {
    res.json(rows || []);
  });
});

app.delete('/api/biblioteca/:id', auth, (req, res) => {
  db.run('DELETE FROM biblioteca_imagenes WHERE id=?', [req.params.id], (err) => {
    res.json({ ok: !err });
  });
});


// ===== CONTACTOS =====
app.get('/api/contactos', auth, (req, res) => {
  const numero_id = req.user.rol === 'supervisor' ? req.query.numero_id || null : req.user.numero_id;
  const cond = [], params = [];
  if (numero_id) { cond.push('numero_id=?'); params.push(numero_id); }
  if (req.query.incluir_formulario !== '1') cond.push("(origen IS NULL OR origen != 'formulario_ads')");
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  db.all(`SELECT * FROM contactos ${where} ORDER BY nombre, telefono`, params, (err, rows) => res.json(rows || []));
});

app.put('/api/contactos/:id', auth, async (req, res) => {
  const { nombre, etapa, prioridad, notas } = req.body;
  db.get('SELECT etapa, telefono, nombre as nombre_actual FROM contactos WHERE id=?', [req.params.id], (err, contactoAnterior) => {
    db.run('UPDATE contactos SET nombre=?, etapa=?, prioridad=?, notas=? WHERE id=?',
      [nombre, etapa||'Nuevo', prioridad||'Media', notas||'', req.params.id],
      async (err2) => {
        if (!err2 && contactoAnterior && etapa && etapa !== contactoAnterior.etapa) {
          try {
            // Buscar triggers del numero del contacto
            const numeroId = contactoAnterior.numero_id;
            const numRow = await new Promise((resolve) => {
              db.get('SELECT capi_triggers, capi_activo, pixel_id FROM numeros WHERE phone_number_id=?', [numeroId], (e, row) => resolve(row));
            });
            let matched = false;
            if (numRow && numRow.capi_activo && numRow.pixel_id) {
              const triggers = JSON.parse(numRow.capi_triggers || '[]');
              const match = triggers.find(t => t.etapa === etapa && t.activo);
              if (match) {
                await sendCapiEvent(match.evento, {
                  nombre: nombre || contactoAnterior.nombre_actual,
                  telefono: contactoAnterior.telefono,
                  etapa: etapa,
                  numero_id: numeroId
                });
                matched = true;
              }
            }
            // Fallback a config global si no hay config por numero
            if (!matched) {
              const config = await new Promise((resolve, reject) => {
                db.get('SELECT triggers, activo FROM facebook_capi_config WHERE activo=1 LIMIT 1', [], (e, row) => {
                  if (e || !row) reject('sin config'); else resolve(row);
                });
              });
              const triggers = JSON.parse(config.triggers || '[]');
              const match = triggers.find(t => t.etapa === etapa && t.activo);
              if (match) {
                await sendCapiEvent(match.evento, {
                  nombre: nombre || contactoAnterior.nombre_actual,
                  telefono: contactoAnterior.telefono,
                  etapa: etapa,
                  numero_id: numeroId
                });
              }
            }
          } catch(e2) {}
        }
        res.json({ ok: !err2, error: err2?.message });
      });
  });
});

app.delete('/api/contactos/:id', auth, (req, res) => {
  db.run('DELETE FROM contactos WHERE id=?', [req.params.id], (err) => res.json({ ok: !err }));
});

// ===== IMPORTAR CSV =====
const uploadCSV = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024 } });

app.post('/api/contactos/importar', auth, uploadCSV.single('csv'), async (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'No se subio archivo' });
  const numero_id = req.user.numero_id;
  const text = req.file.buffer.toString('utf-8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  let importados = 0, errores = 0;
  for(let i=1; i<lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g,''));
    const telefono = cols[0]?.replace(/[^0-9]/g,'');
    const nombre = cols[1] || '';
    const etapa = cols[2] || 'Nuevo';
    if(!telefono || telefono.length < 10) { errores++; continue; }
    await new Promise(resolve => {
      db.run('INSERT OR IGNORE INTO contactos (telefono, nombre, etapa, numero_id) VALUES (?,?,?,?)',
        [telefono, nombre, etapa, numero_id], (err) => {
          if(!err) importados++;
          else errores++;
          resolve();
        });
    });
  }
  res.json({ ok: true, importados, errores, total: lines.length-1 });
});


// ===== ETIQUETAS POR USUARIO =====
app.get('/api/etiquetas', auth, (req, res) => {
  db.all('SELECT * FROM etiquetas WHERE usuario_id=? ORDER BY nombre', [req.user.id], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/etiquetas', auth, (req, res) => {
  const { nombre, color } = req.body;
  db.run('INSERT INTO etiquetas (nombre, color, usuario_id) VALUES (?,?,?)',
    [nombre, color||'#075e54', req.user.id], function(err) {
      if(err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, id: this.lastID });
    });
});

app.delete('/api/etiquetas/:id', auth, (req, res) => {
  db.run('DELETE FROM etiquetas WHERE id=? AND usuario_id=?', [req.params.id, req.user.id], (err) => {
    res.json({ ok: !err });
  });
});

app.post('/api/contactos/:id/etiquetas', auth, (req, res) => {
  const { etiqueta_id } = req.body;
  db.run('INSERT OR IGNORE INTO contacto_etiquetas (contacto_id, etiqueta_id) VALUES (?,?)',
    [req.params.id, etiqueta_id], (err) => res.json({ ok: !err }));
});

app.delete('/api/contactos/:id/etiquetas/:eid', auth, (req, res) => {
  db.run('DELETE FROM contacto_etiquetas WHERE contacto_id=? AND etiqueta_id=?',
    [req.params.id, req.params.eid], (err) => res.json({ ok: !err }));
});

app.get('/api/contactos/:id/etiquetas', auth, (req, res) => {
  db.all(`SELECT e.* FROM etiquetas e 
          JOIN contacto_etiquetas ce ON e.id=ce.etiqueta_id 
          WHERE ce.contacto_id=?`, [req.params.id], (err, rows) => {
    res.json(rows || []);
  });
});


app.delete('/api/mensajes/:tel', auth, (req, res) => {
  db.run('DELETE FROM mensajes WHERE contacto=? AND numero_id=?',
    [req.params.tel, req.user.numero_id || req.query.numero_id],
    (err) => res.json({ ok: !err }));
});


// ===== RESPUESTAS RAPIDAS =====
app.get('/api/respuestas', auth, (req, res) => {
  db.all('SELECT * FROM respuestas_rapidas WHERE usuario_id=? ORDER BY titulo', [req.user.id], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/respuestas', auth, (req, res) => {
  const { titulo, contenido } = req.body;
  if(!titulo||!contenido) return res.status(400).json({ error: 'Titulo y contenido requeridos' });
  db.run('INSERT INTO respuestas_rapidas (usuario_id, titulo, contenido) VALUES (?,?,?)',
    [req.user.id, titulo, contenido], function(err) {
      if(err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, id: this.lastID });
    });
});

app.put('/api/respuestas/:id', auth, (req, res) => {
  const { titulo, contenido } = req.body;
  db.run('UPDATE respuestas_rapidas SET titulo=?, contenido=? WHERE id=? AND usuario_id=?',
    [titulo, contenido, req.params.id, req.user.id], (err) => res.json({ ok: !err }));
});

app.delete('/api/respuestas/:id', auth, (req, res) => {
  db.run('DELETE FROM respuestas_rapidas WHERE id=? AND usuario_id=?',
    [req.params.id, req.user.id], (err) => res.json({ ok: !err }));
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM usuarios WHERE email = ?', [email], async (err, user) => {
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const token = jwt.sign({ id: user.id, rol: user.rol, numero_id: user.numero_id, sucursal: user.sucursal, nombre: user.nombre }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, usuario: { id: user.id, nombre: user.nombre, rol: user.rol, sucursal: user.sucursal, numero_id: user.numero_id } });
  });
});

app.get('/api/mensajes', auth, (req, res) => {
  const numero_id = req.user.rol === 'supervisor' ? req.query.numero_id : req.user.numero_id;
  const cond = [], params = [];
  if (numero_id) { cond.push('numero_id = ?'); params.push(numero_id); }
  // Los leads autogenerados por anuncios se ocultan salvo que se pidan con ?incluir_formulario=1
  if (req.query.incluir_formulario !== '1') cond.push("(origen IS NULL OR origen != 'formulario_ads')");
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const limit = numero_id ? 100 : 200;
  db.all(`SELECT * FROM mensajes ${where} ORDER BY timestamp DESC LIMIT ${limit}`, params, (err, rows) => res.json(rows || []));
});

app.get('/api/numeros', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  db.all('SELECT id, nombre, sucursal, phone_number_id FROM numeros', [], (err, rows) => res.json(rows || []));
});

app.get('/api/metricas', auth, (req, res) => {
  const numero_id = req.user.rol === 'supervisor' ? req.query.numero_id || null : req.user.numero_id;
  const where = numero_id ? 'WHERE numero_id = ?' : '';
  const params = numero_id ? [numero_id] : [];
  db.get(`SELECT COUNT(*) as total, SUM(CASE WHEN direccion='entrante' THEN 1 ELSE 0 END) as entrantes, SUM(CASE WHEN direccion='saliente' THEN 1 ELSE 0 END) as salientes, SUM(CASE WHEN leido=0 AND direccion='entrante' THEN 1 ELSE 0 END) as no_leidos FROM mensajes ${where}`, params, (err, row) => res.json(row || {}));
});

app.post('/api/enviar', auth, async (req, res) => {
  const { telefono, mensaje, numero_id } = req.body;
  const num = await resolverNumeroEnvio(req, numero_id);
  if (!num) return res.status(404).json({ error: 'No hay un número de WhatsApp configurado para enviar. Asigna uno en el panel de administración.' });
  if (!num.token) return res.status(400).json({ error: 'El número ' + num.phone_number_id + ' no tiene token de WhatsApp configurado.' });
  const nid = num.phone_number_id;
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${nid}/messages`, { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: mensaje } }, { headers: { Authorization: `Bearer ${num.token}` } });
    db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion) VALUES (?, ?, ?, ?)', [nid, telefono, mensaje, 'saliente']);
    res.json({ ok: true });
  } catch (e) { console.error('Error enviar:', JSON.stringify(e.response?.data || e.message)); res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

app.get('/api/contactos', auth, (req, res) => {
  const numero_id = req.user.rol === 'supervisor' ? req.query.numero_id || null : req.user.numero_id;
  const where = numero_id ? 'WHERE c.numero_id = ?' : '';
  const params = numero_id ? [numero_id] : [];
  db.all(`SELECT c.*, GROUP_CONCAT(e.nombre) as etiquetas, GROUP_CONCAT(e.color) as etiqueta_colores FROM contactos c LEFT JOIN contacto_etiquetas ce ON c.id = ce.contacto_id LEFT JOIN etiquetas e ON ce.etiqueta_id = e.id ${where} GROUP BY c.id ORDER BY c.created_at DESC`, params, (err, rows) => res.json(rows || []));
});

app.get('/api/contactos/:telefono', auth, (req, res) => {
  db.get('SELECT * FROM contactos WHERE telefono = ?', [req.params.telefono], (err, contacto) => {
    if (!contacto) return res.json({ telefono: req.params.telefono, nombre: null, notas: null, etapa: 'Nuevo', prioridad: 'Media', etiquetas: [] });
    db.all('SELECT e.* FROM etiquetas e JOIN contacto_etiquetas ce ON e.id = ce.etiqueta_id WHERE ce.contacto_id = ?', [contacto.id], (err, etiquetas) => {
      res.json({ ...contacto, etiquetas: etiquetas || [] });
    });
  });
});

app.put('/api/contactos/:telefono', auth, (req, res) => {
  const { nombre, notas, etapa, prioridad, etiquetas } = req.body;
  const numero_id = req.user.numero_id || req.body.numero_id;
  db.run(`INSERT INTO contactos (telefono, nombre, notas, etapa, prioridad, numero_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(telefono) DO UPDATE SET nombre=excluded.nombre, notas=excluded.notas, etapa=excluded.etapa, prioridad=excluded.prioridad`,
    [req.params.telefono, nombre, notas, etapa, prioridad, numero_id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT id FROM contactos WHERE telefono = ?', [req.params.telefono], (err, c) => {
        if (!c) return res.json({ ok: true });
        db.run('DELETE FROM contacto_etiquetas WHERE contacto_id = ?', [c.id], () => {
          if (etiquetas && etiquetas.length > 0) {
            const stmt = db.prepare('INSERT OR IGNORE INTO contacto_etiquetas (contacto_id, etiqueta_id) VALUES (?, ?)');
            etiquetas.forEach(eid => stmt.run(c.id, eid));
            stmt.finalize();
          }
          res.json({ ok: true });
        });
      });
    });
});

app.get('/api/etiquetas', auth, (req, res) => {
  db.all('SELECT * FROM etiquetas', [], (err, rows) => res.json(rows || []));
});

app.post('/api/etiquetas', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const { nombre, color } = req.body;
  db.run('INSERT INTO etiquetas (nombre, color) VALUES (?, ?)', [nombre, color || '#075e54'], function(err) {
    if (err) return res.status(400).json({ error: 'Etiqueta ya existe' });
    res.json({ id: this.lastID, nombre, color });
  });
});


app.put('/api/leer/:contacto', auth, (req, res) => {
  const numero_id = req.user.rol === 'supervisor' ? req.query.numero_id : req.user.numero_id;
  db.run('UPDATE mensajes SET leido = 1 WHERE contacto = ? AND direccion = ?', [req.params.contacto, 'entrante'], () => res.json({ ok: true }));
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.WEBHOOK_VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
  res.status(403).send('Token inválido');
});

// Detecta mensajes autogenerados por anuncios con formulario (Meta los redacta por el lead).
// Señal principal: `referral` (Meta lo incluye cuando el chat nace de un anuncio).
// Respaldo: el texto de plantilla que Meta usa al enviarlos.
function origenDelMensaje(msg, texto) {
  if (msg.referral) return 'formulario_ads';
  if (/Complet[eé] el formulario|I filled out your form/i.test(texto || '')) return 'formulario_ads';
  return null;
}

app.post('/webhook', (req, res) => {
  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  if (entry?.messages) {
    const msg = entry.messages[0];
    const numero_id = entry.metadata.phone_number_id;
    const telefono = msg.from;
    const texto = msg.text?.body || '[media]';
    const origen = origenDelMensaje(msg, texto);
    db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion, origen) VALUES (?, ?, ?, ?, ?)', [numero_id, telefono, texto, 'entrante', origen]);
    db.run(`INSERT INTO contactos (telefono, numero_id, etapa, prioridad, origen) VALUES (?, ?, 'Nuevo', 'Media', ?) ON CONFLICT(telefono) DO NOTHING`, [telefono, numero_id, origen]);
  }
  res.sendStatus(200);
});

app.post('/api/usuarios', auth, async (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const { nombre, email, password, numero_id, sucursal, rol, telefono } = req.body;
  const hash = await bcrypt.hash(password, 10);
  db.run('INSERT INTO usuarios (nombre, email, password, numero_id, sucursal, rol, telefono) VALUES (?, ?, ?, ?, ?, ?, ?)', [nombre, email, hash, numero_id, sucursal, rol || 'recepcionista', telefono || null], function(err) {
    if (err) return res.status(400).json({ error: 'Email ya existe' });
    res.json({ id: this.lastID });
  });
});


app.get('/api/usuarios', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const query = req.user.rol === 'supervisor' ? "SELECT id, nombre, email, sucursal, numero_id, rol FROM usuarios WHERE rol != 'admin' AND sucursal = ?" : "SELECT id, nombre, email, sucursal, numero_id, rol FROM usuarios";
  const params = req.user.rol === 'supervisor' ? [req.user.sucursal] : [];
  db.all(query, params, (err, rows) => res.json(rows || []));
});

app.put('/api/usuarios/:id', auth, async (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const { nombre, sucursal, numero_id, rol, password } = req.body;
  if (password) {
    const hash = await require('bcryptjs').hash(password, 10);
    db.run('UPDATE usuarios SET nombre=?, sucursal=?, numero_id=?, rol=?, password=? WHERE id=?', [nombre, sucursal, numero_id, rol, hash, req.params.id], (err) => res.json({ ok: !err }));
  } else {
    db.run('UPDATE usuarios SET nombre=?, sucursal=?, numero_id=?, rol=? WHERE id=?', [nombre, sucursal, numero_id, rol, req.params.id], (err) => res.json({ ok: !err }));
  }
});

app.delete('/api/usuarios/:id', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  db.run('DELETE FROM usuarios WHERE id=?', [req.params.id], (err) => res.json({ ok: !err }));
});

app.get('/api/plantillas', auth, (req, res) => {
  if (req.user.rol === 'supervisor' || req.user.rol === 'admin') {
    db.all('SELECT * FROM plantillas ORDER BY categoria, nombre', [], (err, rows) => res.json(rows || []));
  } else {
    db.all('SELECT * FROM plantillas WHERE phone_number_id=? OR phone_number_id IS NULL ORDER BY categoria, nombre', [req.user.numero_id], (err, rows) => res.json(rows || []));
  }
});

app.post('/api/plantillas', auth, async (req, res) => {
  const { nombre, categoria, contenido, phone_number_id } = req.body;
  const numId = phone_number_id || req.user.numero_id;
  db.run('INSERT INTO plantillas (nombre, categoria, contenido, phone_number_id, estado_meta) VALUES (?, ?, ?, ?, ?)',
    [nombre, categoria || 'General', contenido, numId, 'pendiente'], async function(err) {
      if (err) return res.json({ ok: false, error: err.message });
      const plantillaId = this.lastID;
      // Enviar a Meta para aprobacion
      try {
        const numRow = await new Promise((resolve, reject) => {
          db.get('SELECT * FROM numeros WHERE phone_number_id=?', [numId], (e, row) => e ? reject(e) : resolve(row));
        });
        // Meta exige el WABA ID (no el phone_number_id) para el edge message_templates
        if (numRow && numRow.token && numRow.waba_id) {
          const metaRes = await require('axios').post(
            `https://graph.facebook.com/v18.0/${numRow.waba_id}/message_templates`,
            {
              name: nombre.toLowerCase().replace(/\s+/g, '_'),
              category: categoria === 'Marketing' ? 'MARKETING' : 'UTILITY',
              language: 'es',
              components: [{ type: 'BODY', text: contenido }]
            },
            { headers: { Authorization: 'Bearer ' + numRow.token } }
          );
          const metaId = metaRes.data?.id || null;
          db.run('UPDATE plantillas SET meta_template_id=?, estado_meta=? WHERE id=?', [metaId, 'enviada', plantillaId]);
        }
      } catch(e) {
        db.run('UPDATE plantillas SET estado_meta=? WHERE id=?', ['error_envio', plantillaId]);
      }
      res.json({ ok: true, id: plantillaId });
  });
});

app.put('/api/plantillas/:id', auth, (req, res) => {
  const { nombre, categoria, contenido } = req.body;
  db.run('UPDATE plantillas SET nombre=?, categoria=?, contenido=? WHERE id=?', [nombre, categoria, contenido, req.params.id], (err) => res.json({ ok: !err }));
});

app.delete('/api/plantillas/:id', auth, (req, res) => {
  db.run('DELETE FROM plantillas WHERE id=?', [req.params.id], (err) => res.json({ ok: !err }));
});

// ===== SINCRONIZAR ESTADO DE PLANTILLAS CON META =====
// Mapea los estados de Meta a los que usa el frontend
const META_STATUS_MAP = {
  APPROVED: 'aprobada', PENDING: 'pendiente', REJECTED: 'rechazada',
  PAUSED: 'pausada', DISABLED: 'deshabilitada', IN_APPEAL: 'en_apelacion',
  PENDING_DELETION: 'pendiente_baja', DELETED: 'eliminada', LIMIT_EXCEEDED: 'limite_excedido'
};

app.post('/api/plantillas/sync', auth, async (req, res) => {
  try {
    let importadas = 0, actualizadas = 0, errores = 0, sin_meta_id = 0;
    const avisos = [];
    const vistas = new Set(); // ids locales ya sincronizados desde el WABA

    // --- FASE 1: importar/actualizar desde el Administrador comercial (WABA) ---
    const wabas = await new Promise((resolve, reject) => {
      db.all(`SELECT phone_number_id, waba_id, token, nombre FROM numeros
              WHERE waba_id IS NOT NULL AND waba_id!='' AND token IS NOT NULL AND token!=''`,
        [], (e, rows) => e ? reject(e) : resolve(rows || []));
    });

    for (const n of wabas) {
      let next = `https://graph.facebook.com/v18.0/${n.waba_id}/message_templates?fields=id,name,status,category,language,components&limit=200`;
      try {
        while (next) {
          const r = await axios.get(next, { headers: { Authorization: 'Bearer ' + n.token } });
          for (const t of (r.data.data || [])) {
            const estado = META_STATUS_MAP[t.status] || String(t.status || '').toLowerCase() || 'pendiente';
            const body = (t.components || []).find(c => c.type === 'BODY');
            const contenido = (body && body.text) ? body.text : '';
            const categoria = t.category || 'General';

            // Enlazar por meta_template_id; si no, adoptar una local con el mismo nombre aún sin enlazar
            let fila = await new Promise(resolve =>
              db.get('SELECT id FROM plantillas WHERE meta_template_id=?', [t.id], (e, row) => resolve(row)));
            if (!fila) {
              fila = await new Promise(resolve =>
                db.get('SELECT id FROM plantillas WHERE nombre=? AND (meta_template_id IS NULL OR meta_template_id="")',
                  [t.name], (e, row) => resolve(row)));
            }

            if (fila) {
              await new Promise(resolve => db.run(
                `UPDATE plantillas SET meta_template_id=?, estado_meta=?, categoria=?, contenido=?, idioma=?,
                 phone_number_id=COALESCE(phone_number_id,?) WHERE id=?`,
                [t.id, estado, categoria, contenido, t.language || 'es', n.phone_number_id, fila.id], () => resolve()));
              vistas.add(fila.id);
              actualizadas++;
            } else {
              const nuevo = await new Promise(resolve => db.run(
                'INSERT INTO plantillas (nombre, categoria, contenido, phone_number_id, estado_meta, meta_template_id, idioma) VALUES (?,?,?,?,?,?,?)',
                [t.name, categoria, contenido, n.phone_number_id, estado, t.id, t.language || 'es'], function () { resolve(this.lastID); }));
              vistas.add(nuevo);
              importadas++;
            }
          }
          next = (r.data.paging && r.data.paging.next) ? r.data.paging.next : null;
        }
      } catch (e) {
        errores++;
        avisos.push((n.nombre || n.waba_id) + ': ' + (e.response?.data?.error?.message || e.message));
      }
    }

    // --- FASE 2: refrescar por ID las locales que no vinieron de un WABA ---
    const restantes = await new Promise((resolve, reject) => {
      db.all(`SELECT id, meta_template_id, phone_number_id FROM plantillas`, [], (e, rows) => e ? reject(e) : resolve(rows || []));
    });
    for (const p of restantes) {
      if (vistas.has(p.id)) continue;
      if (!p.meta_template_id) { sin_meta_id++; continue; }
      const num = await new Promise((resolve) => {
        if (p.phone_number_id) {
          db.get('SELECT token FROM numeros WHERE phone_number_id=? AND token IS NOT NULL AND token!=""', [p.phone_number_id], (e, r) => resolve(r));
        } else {
          db.get('SELECT token FROM numeros WHERE token IS NOT NULL AND token!="" LIMIT 1', [], (e, r) => resolve(r));
        }
      });
      if (!num || !num.token) continue;
      try {
        const r = await axios.get(`https://graph.facebook.com/v18.0/${p.meta_template_id}`, {
          params: { fields: 'name,status,category' },
          headers: { Authorization: 'Bearer ' + num.token }
        });
        const estado = META_STATUS_MAP[r.data.status] || String(r.data.status || '').toLowerCase() || 'pendiente';
        await new Promise((resolve) => db.run('UPDATE plantillas SET estado_meta=? WHERE id=?', [estado, p.id], () => resolve()));
        actualizadas++;
      } catch (e) { errores++; }
    }

    if (!wabas.length) avisos.push('Ningún número tiene WABA ID + token configurado — no se pudo leer tu Administrador comercial.');
    res.json({ ok: true, importadas, actualizadas, sin_meta_id, errores, wabas: wabas.length, avisos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/difusion', auth, async (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const { nombre, mensaje, filtro_etapa, numero_id } = req.body;
  let query = 'SELECT DISTINCT telefono FROM contactos WHERE 1=1';
  const params = [];
  if (filtro_etapa) { query += ' AND etapa=?'; params.push(filtro_etapa); }
  db.all(query, params, async (err, contactos) => {
    if (err) return res.status(500).json({ error: err.message });
    db.run('INSERT INTO difusiones (nombre, mensaje, filtro_etapa, total, estado, phone_number_id) VALUES (?, ?, ?, ?, ?, ?)',
      [nombre, mensaje, filtro_etapa, contactos.length, 'enviando', numero_id], function(difErr, difId) {
      const id = this.lastID;
      db.get('SELECT * FROM numeros WHERE phone_number_id=?', [numero_id], async (err2, num) => {
        if (!num) return res.status(404).json({ error: 'Numero no encontrado' });
        let enviados = 0;
        for (const c of contactos) {
          try {
            await require('axios').post('https://graph.facebook.com/v18.0/' + numero_id + '/messages',
              { messaging_product: 'whatsapp', to: c.telefono, type: 'text', text: { body: mensaje } },
              { headers: { Authorization: 'Bearer ' + num.token } });
            db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion) VALUES (?, ?, ?, ?)', [numero_id, c.telefono, mensaje, 'saliente']);
            enviados++;
          } catch(e) {}
          await new Promise(r => setTimeout(r, 500));
        }
        db.run('UPDATE difusiones SET enviados=?, estado=? WHERE id=?', [enviados, 'completado', id]);
      });
    });
    res.json({ ok: true, total: contactos.length });
  });
});

app.get('/api/difusiones', auth, (req, res) => {
  if (req.user.rol === 'supervisor') {
    db.all(`SELECT d.*, u.nombre as enviado_por FROM difusiones d 
            LEFT JOIN usuarios u ON d.phone_number_id = u.numero_id 
            ORDER BY d.created_at DESC LIMIT 50`, [], (err, rows) => res.json(rows || []));
  } else {
    db.all('SELECT * FROM difusiones WHERE phone_number_id=? ORDER BY created_at DESC LIMIT 20', [req.user.numero_id], (err, rows) => res.json(rows || []));
  }
});

app.get('/api/reportes', auth, (req, res) => {
  const dias = parseInt(req.query.dias) || 7;
  const numero_id = req.query.numero_id || null;
  db.all('SELECT date(timestamp) as dia, numero_id, COUNT(*) as total, SUM(CASE WHEN direccion=? THEN 1 ELSE 0 END) as entrantes, SUM(CASE WHEN direccion=? THEN 1 ELSE 0 END) as salientes FROM mensajes WHERE timestamp >= datetime("now", "-" || ? || " days") GROUP BY dia, numero_id ORDER BY dia DESC', ['entrante', 'saliente', dias], (err, rows) => res.json(rows || []));
});

app.get('/api/reportes/etapas', auth, (req, res) => {
  db.all('SELECT etapa, COUNT(*) as total FROM contactos GROUP BY etapa', [], (err, rows) => res.json(rows || []));
});

// app.listen moved to end

// ==================== FACEBOOK CONVERSIONS API ====================
const crypto = require('crypto');

function hashData(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

async function sendCapiEvent(eventName, contacto) {
  try {
    // Buscar config por numero_id del contacto primero, luego config global
    const config = await new Promise((resolve, reject) => {
      if (contacto.numero_id) {
        db.get('SELECT pixel_id, capi_token as access_token, capi_version as api_version, capi_test_code as test_event_code FROM numeros WHERE phone_number_id=? AND capi_activo=1 AND pixel_id IS NOT NULL', [contacto.numero_id], (err, row) => {
          if (row) resolve({ ...row, source: 'numero' });
          else {
            db.get('SELECT * FROM facebook_capi_config WHERE activo=1 LIMIT 1', [], (err2, row2) => {
              if (err2 || !row2) reject('Sin config CAPI para este numero');
              else resolve({ ...row2, source: 'global' });
            });
          }
        });
      } else {
        db.get('SELECT * FROM facebook_capi_config WHERE activo=1 LIMIT 1', [], (err, row) => {
          if (err || !row) reject('Sin config');
          else resolve({ ...row, source: 'global' });
        });
      }
    });

    const eventId = 'ev_' + Math.random().toString(36).substring(2, 9);
    const payload = {
      data: [{
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        user_data: {
          ph: [hashData(contacto.telefono)],
          fn: [hashData(contacto.nombre ? contacto.nombre.split(' ')[0] : null)],
          ln: [hashData(contacto.nombre && contacto.nombre.split(' ')[1] ? contacto.nombre.split(' ')[1] : null)]
        }
      }]
    };

    if (config.test_event_code) {
      payload.test_event_code = config.test_event_code;
    }

    const url = `https://graph.facebook.com/${config.api_version || 'v21.0'}/${config.pixel_id}/events?access_token=${config.access_token}`;
    const response = await require('axios').post(url, payload);

    db.run('INSERT INTO facebook_capi_logs (contacto_nombre, contacto_telefono, evento_tipo, etapa, event_id, status_code, respuesta, numero_id) VALUES (?,?,?,?,?,?,?,?)',
      [contacto.nombre, contacto.telefono, eventName, contacto.etapa, eventId, 200, JSON.stringify(response.data), contacto.numero_id || null]);

    return { ok: true, event_id: eventId, source: config.source };
  } catch(e) {
    const msg = e.response?.data?.error?.message || e.message || 'Error desconocido';
    db.run('INSERT INTO facebook_capi_logs (contacto_nombre, contacto_telefono, evento_tipo, etapa, event_id, status_code, respuesta, numero_id) VALUES (?,?,?,?,?,?,?,?)',
      [contacto.nombre, contacto.telefono, 'error', contacto.etapa, null, e.response?.status || 0, msg, contacto.numero_id || null]);
    return { ok: false, error: msg };
  }
}

// Guardar configuración CAPI
app.post('/api/facebook/config', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const { pixel_id, access_token, test_event_code, api_version, triggers } = req.body;
  db.get('SELECT id FROM facebook_capi_config LIMIT 1', [], (err, row) => {
    if (row) {
      db.run('UPDATE facebook_capi_config SET pixel_id=?, access_token=?, test_event_code=?, api_version=?, triggers=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        [pixel_id, access_token, test_event_code || null, api_version || 'v21.0', JSON.stringify(triggers || []), row.id],
        (e) => res.json({ ok: !e }));
    } else {
      db.run('INSERT INTO facebook_capi_config (pixel_id, access_token, test_event_code, api_version, triggers) VALUES (?,?,?,?,?)',
        [pixel_id, access_token, test_event_code || null, api_version || 'v21.0', JSON.stringify(triggers || [])],
        (e) => res.json({ ok: !e }));
    }
  });
});

// Obtener configuración CAPI
app.get('/api/facebook/config', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  db.get('SELECT * FROM facebook_capi_config LIMIT 1', [], (err, row) => {
    if (!row) return res.json({ configured: false });
    res.json({ configured: true, pixel_id: row.pixel_id, test_event_code: row.test_event_code, api_version: row.api_version, triggers: JSON.parse(row.triggers || '[]'), has_token: !!row.access_token });
  });
});

// Probar conexión CAPI
app.post('/api/facebook/test', auth, async (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const result = await sendCapiEvent('Lead', { nombre: 'Test BunnyRabbit', telefono: '5200000000000', etapa: 'test' });
  res.json(result);
});

// Logs CAPI
app.get('/api/facebook/logs', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const numero_id = req.query.numero_id || null;
  let query = `SELECT l.*, n.sucursal, n.nombre as num_nombre
    FROM facebook_capi_logs l
    LEFT JOIN numeros n ON l.numero_id = n.phone_number_id
    WHERE 1=1`;
  const params = [];
  if (numero_id) { query += ' AND l.numero_id=?'; params.push(numero_id); }
  query += ' ORDER BY l.created_at DESC LIMIT 100';
  db.all(query, params, (err, rows) => res.json(rows || []));
});

// Stats CAPI
app.get('/api/facebook/stats', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  db.get('SELECT COUNT(*) as total, SUM(CASE WHEN status_code=200 THEN 1 ELSE 0 END) as exitosos, SUM(CASE WHEN status_code!=200 THEN 1 ELSE 0 END) as fallidos FROM facebook_capi_logs', [], (err, row) => res.json(row || { total: 0, exitosos: 0, fallidos: 0 }));
});


// ===== CAPI POR NUMERO =====
app.get('/api/numeros/capi', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  db.all('SELECT id, nombre, sucursal, phone_number_id, pixel_id, capi_version, capi_test_code, capi_activo, capi_triggers FROM numeros ORDER BY sucursal', [], (err, rows) => {
    res.json(rows || []);
  });
});

app.put('/api/numeros/:id/capi', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const { pixel_id, capi_token, capi_version, capi_test_code, capi_activo, sucursal, capi_triggers } = req.body;
  const triggersJson = JSON.stringify(capi_triggers || []);
  const query = capi_token
    ? 'UPDATE numeros SET pixel_id=?, capi_token=?, capi_version=?, capi_test_code=?, capi_activo=?, sucursal=?, capi_triggers=? WHERE id=?'
    : 'UPDATE numeros SET pixel_id=?, capi_version=?, capi_test_code=?, capi_activo=?, sucursal=?, capi_triggers=? WHERE id=?';
  const params = capi_token
    ? [pixel_id, capi_token, capi_version || 'v21.0', capi_test_code || null, capi_activo ? 1 : 0, sucursal || null, triggersJson, req.params.id]
    : [pixel_id, capi_version || 'v21.0', capi_test_code || null, capi_activo ? 1 : 0, sucursal || null, triggersJson, req.params.id];
  db.run(query, params, (err) => res.json({ ok: !err, error: err?.message }));
});

app.post('/api/numeros/:id/capi/test', auth, async (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  db.get('SELECT * FROM numeros WHERE id=?', [req.params.id], async (err, num) => {
    if (!num) return res.status(404).json({ error: 'Numero no encontrado' });
    if (!num.pixel_id || !num.capi_token) return res.status(400).json({ error: 'Configura Pixel ID y token primero' });
    // Usar test_event_code del numero para que aparezca en Meta Events Manager
    const eventId = 'ev_test_' + Math.random().toString(36).substring(2, 9);
    try {
      const crypto = require('crypto');
      const payload = {
        data: [{
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          action_source: 'website',
          user_data: {
            ph: [crypto.createHash('sha256').update('525512345678').digest('hex')],
            fn: [crypto.createHash('sha256').update('test').digest('hex')],
            ln: [crypto.createHash('sha256').update('bunnyrabbit').digest('hex')],
            ct: [crypto.createHash('sha256').update('mexico').digest('hex')],
            country: [crypto.createHash('sha256').update('mx').digest('hex')]
          }
        }]
      };
      if (num.capi_test_code) payload.test_event_code = num.capi_test_code;
      const url = `https://graph.facebook.com/${num.capi_version||'v21.0'}/${num.pixel_id}/events?access_token=${num.capi_token}`;
      const response = await require('axios').post(url, payload);
      db.run('INSERT INTO facebook_capi_logs (contacto_nombre, contacto_telefono, evento_tipo, etapa, event_id, status_code, respuesta, numero_id) VALUES (?,?,?,?,?,?,?,?)',
        ['Test BunnyRabbit', '5200000000000', 'Lead', 'test', eventId, 200, JSON.stringify(response.data), num.phone_number_id]);
      res.json({ ok: true, event_id: eventId, test_code: num.capi_test_code||null, message: num.capi_test_code ? 'Evento enviado con test_event_code — revisa Meta Events Manager' : 'Evento enviado — agrega un Test Event Code para verlo en Meta' });
    } catch(e) {
      const msg = e.response?.data?.error?.message || e.message;
      res.json({ ok: false, error: msg });
    }
  });
});

// ===== AGREGAR NUMERO NUEVO =====
app.post('/api/numeros/nuevo', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const { nombre, sucursal, phone_number_id, waba_id, pixel_id, capi_version, token: waToken, capi_token, capi_activo } = req.body;
  if (!nombre || !phone_number_id) return res.status(400).json({ error: 'Nombre y Phone Number ID son obligatorios' });
  db.run(
    'INSERT INTO numeros (nombre, sucursal, phone_number_id, token, waba_id, pixel_id, capi_token, capi_version, capi_activo, capi_triggers) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [nombre, sucursal||nombre, phone_number_id, waToken||null, waba_id||null, pixel_id||null, capi_token||null, capi_version||'v21.0', capi_activo?1:0, '[]'],
    function(err) {
      if (err) return res.status(400).json({ ok: false, error: err.message });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// ===== ENVIAR PLANTILLA DESDE CHAT =====
app.post('/api/enviar-plantilla', auth, async (req, res) => {
  const { telefono, plantilla_id, numero_id } = req.body;
  if (!telefono || !plantilla_id) return res.status(400).json({ error: 'Faltan datos' });
  db.get('SELECT * FROM plantillas WHERE id=?', [plantilla_id], async (err, plantilla) => {
    if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' });
    const num = await resolverNumeroEnvio(req, numero_id);
    if (!num) return res.status(404).json({ error: 'No hay un número de WhatsApp configurado para enviar. Asigna uno en el panel de administración.' });
    if (!num.token) return res.status(400).json({ error: 'El número ' + num.phone_number_id + ' no tiene token de WhatsApp configurado.' });
    try {
      await require('axios').post(
        'https://graph.facebook.com/v18.0/' + num.phone_number_id + '/messages',
        {
          messaging_product: 'whatsapp',
          to: telefono,
          type: 'template',
          template: {
            name: plantilla.nombre.toLowerCase().replace(/\s+/g, '_'),
            // Cada plantilla tiene su propio idioma en Meta (es, en_US...); usar el fijo hacía fallar el envío
            language: { code: plantilla.idioma || 'es' },
            components: []
          }
        },
        { headers: { Authorization: 'Bearer ' + num.token } }
      );
      db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion) VALUES (?,?,?,?)',
        [num.phone_number_id, telefono, '[Plantilla: ' + plantilla.nombre + ']', 'saliente']);
      res.json({ ok: true });
    } catch(e) {
      const msg = e.response?.data?.error?.message || e.message;
      res.json({ ok: false, error: msg });
    }
  });
});


// ============================================
// MIDDLEWARE DE ROLES
// ============================================
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'No autorizado' });
  if (!roles.includes(req.user.rol)) return res.status(403).json({ error: 'Sin permiso para esta acción' });
  next();
};

// ============================================
// ENDPOINTS DE USUARIOS / ROLES
// ============================================

// Obtener todos los usuarios (admin/supervisor)
app.get('/api/usuarios', auth, requireRole('admin', 'supervisor'), (req, res) => {
  const sucursal = req.user.rol === 'supervisor' ? req.user.sucursal : null;
  const query = sucursal
    ? `SELECT id, nombre, email, rol, sucursal, numero_id FROM usuarios WHERE sucursal = ?`
    : `SELECT id, nombre, email, rol, sucursal, numero_id FROM usuarios`;
  const params = sucursal ? [sucursal] : [];
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Crear usuario nuevo (solo admin)
app.post('/api/usuarios', auth, requireRole('admin'), (req, res) => {
  const { nombre, email, password, rol, sucursal, numero_id } = req.body;
  if (!nombre || !email || !password || !rol) return res.status(400).json({ error: 'Faltan campos requeridos' });
  const validRoles = ['admin', 'supervisor', 'recepcionista', 'tecnica'];
  if (!validRoles.includes(rol)) return res.status(400).json({ error: 'Rol inválido' });
  const bcrypt = require('bcrypt');
  bcrypt.hash(password, 10, (err, hash) => {
    if (err) return res.status(500).json({ error: err.message });
    db.run(
      `INSERT INTO usuarios (nombre, email, password, rol, sucursal, numero_id) VALUES (?,?,?,?,?,?)`,
      [nombre, email, hash, rol, sucursal || null, numero_id || null],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true, id: this.lastID });
      }
    );
  });
});

// Actualizar usuario (solo admin)
app.put('/api/usuarios/:id', auth, requireRole('admin'), (req, res) => {
  const { nombre, email, rol, sucursal, numero_id } = req.body;
  db.run(
    `UPDATE usuarios SET nombre=?, email=?, rol=?, sucursal=?, numero_id=? WHERE id=?`,
    [nombre, email, rol, sucursal || null, numero_id || null, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

// Eliminar usuario (solo admin)
app.delete('/api/usuarios/:id', auth, requireRole('admin'), (req, res) => {
  db.run(`DELETE FROM usuarios WHERE id=?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ============================================
// ENDPOINTS DE CITAS
// ============================================

// Obtener citas (filtradas por rol)
app.get('/api/citas', auth, (req, res) => {
  const { fecha_inicio, fecha_fin } = req.query;
  const hoy = fecha_inicio || new Date().toISOString().split('T')[0];
  const fin = fecha_fin || hoy;

  let query, params;

  if (req.user.rol === 'admin') {
    query = `SELECT c.*, u.nombre as tecnica_nombre, u2.nombre as recepcionista_nombre, ct.nombre as contacto_nombre, ct.telefono
             FROM citas c
             LEFT JOIN usuarios u ON c.tecnica_id = u.id
             LEFT JOIN usuarios u2 ON c.recepcionista_id = u2.id
             LEFT JOIN contactos ct ON c.contacto_id = ct.id
             WHERE c.fecha BETWEEN ? AND ? ORDER BY c.fecha, c.hora_inicio`;
    params = [hoy, fin];
  } else if (req.user.rol === 'supervisor') {
    query = `SELECT c.*, u.nombre as tecnica_nombre, u2.nombre as recepcionista_nombre, ct.nombre as contacto_nombre, ct.telefono
             FROM citas c
             LEFT JOIN usuarios u ON c.tecnica_id = u.id
             LEFT JOIN usuarios u2 ON c.recepcionista_id = u2.id
             LEFT JOIN contactos ct ON c.contacto_id = ct.id
             WHERE c.sucursal = ? AND c.fecha BETWEEN ? AND ? ORDER BY c.fecha, c.hora_inicio`;
    params = [req.user.sucursal, hoy, fin];
  } else if (req.user.rol === 'tecnica') {
    query = `SELECT c.*, u.nombre as tecnica_nombre, ct.nombre as contacto_nombre, ct.telefono
             FROM citas c
             LEFT JOIN usuarios u ON c.tecnica_id = u.id
             LEFT JOIN contactos ct ON c.contacto_id = ct.id
             WHERE c.tecnica_id = ? AND c.fecha BETWEEN ? AND ? ORDER BY c.fecha, c.hora_inicio`;
    params = [req.user.id, hoy, fin];
  } else {
    // recepcionista — ve citas de su sucursal
    query = `SELECT c.*, u.nombre as tecnica_nombre, ct.nombre as contacto_nombre, ct.telefono
             FROM citas c
             LEFT JOIN usuarios u ON c.tecnica_id = u.id
             LEFT JOIN contactos ct ON c.contacto_id = ct.id
             WHERE c.sucursal = ? AND c.fecha BETWEEN ? AND ? ORDER BY c.fecha, c.hora_inicio`;
    params = [req.user.sucursal, hoy, fin];
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Crear cita
app.post('/api/citas', auth, requireRole('admin', 'supervisor', 'recepcionista'), (req, res) => {
  const { contacto_id, tecnica_id, fecha, hora_inicio, hora_fin, servicio, notas, numero_id } = req.body;
  if (!fecha || !hora_inicio) return res.status(400).json({ error: 'Fecha y hora son requeridas' });
  const sucursal = req.body.sucursal || req.user.sucursal;
  db.run(
    `INSERT INTO citas (contacto_id, tecnica_id, recepcionista_id, numero_id, sucursal, fecha, hora_inicio, hora_fin, servicio, notas, estado)
     VALUES (?,?,?,?,?,?,?,?,?,?,'pendiente')`,
    [contacto_id || null, tecnica_id || null, req.user.id, numero_id || null, sucursal, fecha, hora_inicio, hora_fin || null, servicio || null, notas || null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// Actualizar cita
app.put('/api/citas/:id', auth, requireRole('admin', 'supervisor', 'recepcionista'), (req, res) => {
  const { contacto_id, tecnica_id, fecha, hora_inicio, hora_fin, servicio, notas, estado } = req.body;
  db.run(
    `UPDATE citas SET contacto_id=?, tecnica_id=?, fecha=?, hora_inicio=?, hora_fin=?, servicio=?, notas=?, estado=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [contacto_id || null, tecnica_id || null, fecha, hora_inicio, hora_fin || null, servicio || null, notas || null, estado || 'pendiente', req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

// Cancelar / eliminar cita
app.delete('/api/citas/:id', auth, requireRole('admin', 'supervisor', 'recepcionista'), (req, res) => {
  db.run(`UPDATE citas SET estado='cancelada', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ============================================
// MÉTRICAS PARA SUPERVISOR / ADMIN
// ============================================
app.get('/api/metricas', auth, requireRole('admin', 'supervisor'), (req, res) => {
  const sucursal = req.user.rol === 'supervisor' ? req.user.sucursal : req.query.sucursal || null;

  const filtroSucursal = sucursal ? `WHERE u.sucursal = '${sucursal}'` : '';
  const filtroMensajes = sucursal ? `AND m.numero_id IN (SELECT numero_id FROM usuarios WHERE sucursal = '${sucursal}')` : '';

  const hoy = new Date().toISOString().split('T')[0];

  db.all(`
    SELECT
      u.id, u.nombre, u.sucursal,
      COUNT(DISTINCT c.id) as total_contactos,
      SUM(CASE WHEN m.timestamp >= datetime('now', '-1 day') THEN 1 ELSE 0 END) as mensajes_hoy,
      SUM(CASE WHEN m.timestamp >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as mensajes_semana
    FROM usuarios u
    LEFT JOIN mensajes m ON m.numero_id = u.numero_id AND m.direccion = 'saliente' ${filtroMensajes ? filtroMensajes.replace('AND ', 'AND ') : ''}
    LEFT JOIN citas c ON c.recepcionista_id = u.id
    WHERE u.rol = 'recepcionista' ${sucursal ? `AND u.sucursal = '${sucursal}'` : ''}
    GROUP BY u.id
  `, [], (err, recepcionistas) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(`
      SELECT
        COUNT(*) as total_citas_hoy,
        SUM(CASE WHEN estado = 'pendiente' THEN 1 ELSE 0 END) as pendientes,
        SUM(CASE WHEN estado = 'completada' THEN 1 ELSE 0 END) as completadas,
        SUM(CASE WHEN estado = 'cancelada' THEN 1 ELSE 0 END) as canceladas
      FROM citas WHERE fecha = ?
      ${sucursal ? `AND sucursal = '${sucursal}'` : ''}
    `, [hoy], (err2, citasHoy) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ recepcionistas, citasHoy });
    });
  });
});

// ============================================
// GOOGLE CALENDAR — Lectura de eventos
// ============================================
app.get('/api/google-calendar/eventos', auth, (req, res) => {
  const sucursal = req.user.rol === 'tecnica' || req.user.rol === 'recepcionista'
    ? req.user.sucursal
    : req.query.sucursal;

  if (!sucursal) return res.status(400).json({ error: 'Sucursal requerida' });

  db.get(`SELECT * FROM google_calendar_config WHERE sucursal = ? AND activo = 1`, [sucursal], async (err, config) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!config) return res.json({ eventos: [], configurado: false });

    const { fecha_inicio, fecha_fin } = req.query;
    const timeMin = fecha_inicio ? new Date(fecha_inicio).toISOString() : new Date().toISOString();
    const timeMax = fecha_fin
      ? new Date(fecha_fin + 'T23:59:59').toISOString()
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    try {
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendar_id)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${config.access_token}` }
      });
      const data = await response.json();
      if (data.error) return res.json({ eventos: [], error: data.error.message, configurado: true });
      res.json({ eventos: data.items || [], configurado: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Config Google Calendar (solo admin)
app.post('/api/google-calendar/config', auth, requireRole('admin'), (req, res) => {
  const { sucursal, calendar_id, access_token, refresh_token } = req.body;
  if (!sucursal || !calendar_id || !access_token) return res.status(400).json({ error: 'Faltan campos' });
  db.run(
    `INSERT INTO google_calendar_config (sucursal, calendar_id, access_token, refresh_token, activo)
     VALUES (?,?,?,?,1)
     ON CONFLICT(sucursal) DO UPDATE SET calendar_id=excluded.calendar_id, access_token=excluded.access_token, refresh_token=excluded.refresh_token, activo=1`,
    [sucursal, calendar_id, access_token, refresh_token || null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

// Técnicas disponibles por sucursal
app.get('/api/tecnicas', auth, (req, res) => {
  const sucursal = req.query.sucursal || req.user.sucursal;
  db.all(`SELECT id, nombre FROM usuarios WHERE rol='tecnica' AND sucursal=?`, [sucursal], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});


// ============================================
// CRON + NOTIFICACIONES WHATSAPP A TÉCNICAS
// ============================================
const cronJobs = require('node-cron');

async function enviarMensajeWhatsApp(phoneNumberId, token, telefono, mensaje) {
  try {
    const telefonoLimpio = telefono.replace(/\D/g, '');
    const telefonoFinal = telefonoLimpio.startsWith('52') ? telefonoLimpio : '52' + telefonoLimpio;
    const response = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: telefonoFinal,
        type: 'text',
        text: { body: mensaje }
      })
    });
    const data = await response.json();
    return { ok: !data.error, data };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

async function obtenerDatosSucursal(sucursalNombre) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT s.phone_number_id, n.token FROM sucursales s
            LEFT JOIN numeros n ON n.phone_number_id = s.phone_number_id
            WHERE s.nombre = ? AND s.activo = 1`, [sucursalNombre], (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

async function notificarTecnicaCitaNueva(citaId) {
  try {
    const cita = await new Promise((resolve, reject) => {
      db.get(`SELECT c.*, u.nombre as tecnica_nombre, u.email as tecnica_email,
              ct.nombre as contacto_nombre, ct.telefono as contacto_tel,
              u2.nombre as recepcionista_nombre
              FROM citas c
              LEFT JOIN usuarios u ON c.tecnica_id = u.id
              LEFT JOIN contactos ct ON c.contacto_id = ct.id
              LEFT JOIN usuarios u2 ON c.recepcionista_id = u2.id
              WHERE c.id = ?`, [citaId], (err, row) => {
        if (err) reject(err); else resolve(row);
      });
    });

    if (!cita || !cita.tecnica_id) return;

    // Obtener teléfono de la técnica desde contactos o email
    const tecnicaContacto = await new Promise((resolve) => {
      db.get(`SELECT telefono FROM contactos WHERE nombre LIKE ? LIMIT 1`,
        ['%' + (cita.tecnica_nombre || '') + '%'], (err, row) => resolve(row));
    });

    // Obtener número de la sucursal
    const sucursal = await obtenerDatosSucursal(cita.sucursal);
    if (!sucursal || !sucursal.phone_number_id || !sucursal.token) return;

    // Buscar teléfono de la técnica en usuarios
    const tecnicaUser = await new Promise((resolve) => {
      db.get(`SELECT telefono, numero_id FROM usuarios WHERE id = ?`, [cita.tecnica_id], (err, row) => resolve(row));
    });

    // Usar telefono personal o numero_id como fallback
    const telefonoTecnica = tecnicaUser?.telefono || tecnicaUser?.numero_id;
    if (!telefonoTecnica) {
      console.log(`[NOTIF] Técnica ${cita.tecnica_nombre} no tiene teléfono configurado`);
      return;
    }

    const fecha = new Date(cita.fecha + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    const mensaje = `🌸 *Nueva cita agendada*\n\nHola ${cita.tecnica_nombre}, tienes una nueva cita:\n\n📅 *Fecha:* ${fecha}\n🕐 *Hora:* ${cita.hora_inicio?.slice(0,5)}${cita.hora_fin ? ' – ' + cita.hora_fin.slice(0,5) : ''}\n👤 *Clienta:* ${cita.contacto_nombre || 'Sin nombre'}\n✂️ *Servicio:* ${cita.servicio || 'Sin especificar'}${cita.notas ? '\n📝 *Notas:* ' + cita.notas : ''}\n\nAgendada por: ${cita.recepcionista_nombre || 'Sistema'}`;

    await enviarMensajeWhatsApp(sucursal.phone_number_id, sucursal.token, telefonoTecnica, mensaje);
    console.log(`[NOTIF] Mensaje enviado a técnica ${cita.tecnica_nombre} por cita ${citaId}`);
  } catch(e) {
    console.error('[NOTIF] Error notificando técnica:', e.message);
  }
}

// CRON — Recordatorio día anterior a las 8pm
cronJobs.schedule('0 20 * * *', async () => {
  console.log('[CRON] Enviando recordatorios noche...');
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const fechaManana = manana.toISOString().split('T')[0];

  db.all(`SELECT c.*, u.nombre as tecnica_nombre, ct.nombre as contacto_nombre
          FROM citas c
          LEFT JOIN usuarios u ON c.tecnica_id = u.id
          LEFT JOIN contactos ct ON c.contacto_id = ct.id
          WHERE c.fecha = ? AND c.estado = 'pendiente' AND c.tecnica_id IS NOT NULL
          ORDER BY c.tecnica_id, c.hora_inicio`, [fechaManana], async (err, citas) => {
    if (err || !citas.length) return;

    // Agrupar por técnica
    const porTecnica = {};
    citas.forEach(c => {
      if (!porTecnica[c.tecnica_id]) porTecnica[c.tecnica_id] = { nombre: c.tecnica_nombre, sucursal: c.sucursal, citas: [] };
      porTecnica[c.tecnica_id].citas.push(c);
    });

    for (const [tecnicaId, data] of Object.entries(porTecnica)) {
      const tecnica = await new Promise(resolve => db.get(`SELECT telefono, numero_id FROM usuarios WHERE id=?`, [tecnicaId], (err,r) => resolve(r)));
      const telTecnica = tecnica?.telefono || tecnica?.numero_id;
      if (!telTecnica) continue;
      const sucursal = await obtenerDatosSucursal(data.sucursal);
      if (!sucursal?.phone_number_id || !sucursal?.token) continue;

      const fechaTexto = manana.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
      const listaCitas = data.citas.map((c, i) => `${i+1}. ${c.hora_inicio?.slice(0,5)} — ${c.contacto_nombre || 'Sin nombre'} (${c.servicio || 'Sin especificar'})`).join('\n');
      const mensaje = `🌙 *Recordatorio para mañana*\n\nHola ${data.nombre}, mañana *${fechaTexto}* tienes *${data.citas.length} cita${data.citas.length > 1 ? 's' : ''}*:\n\n${listaCitas}\n\n¡Que tengas una excelente jornada! 🌸`;

      await enviarMensajeWhatsApp(sucursal.phone_number_id, sucursal.token, telTecnica, mensaje);
    }
  });
}, { timezone: 'America/Mexico_City' });

// CRON — Recordatorio mismo día a las 7am
cronJobs.schedule('0 7 * * *', async () => {
  console.log('[CRON] Enviando recordatorios mañana...');
  const hoy = new Date().toISOString().split('T')[0];

  db.all(`SELECT c.*, u.nombre as tecnica_nombre, ct.nombre as contacto_nombre
          FROM citas c
          LEFT JOIN usuarios u ON c.tecnica_id = u.id
          LEFT JOIN contactos ct ON c.contacto_id = ct.id
          WHERE c.fecha = ? AND c.estado = 'pendiente' AND c.tecnica_id IS NOT NULL
          ORDER BY c.tecnica_id, c.hora_inicio`, [hoy], async (err, citas) => {
    if (err || !citas.length) return;

    const porTecnica = {};
    citas.forEach(c => {
      if (!porTecnica[c.tecnica_id]) porTecnica[c.tecnica_id] = { nombre: c.tecnica_nombre, sucursal: c.sucursal, citas: [] };
      porTecnica[c.tecnica_id].citas.push(c);
    });

    for (const [tecnicaId, data] of Object.entries(porTecnica)) {
      const tecnica = await new Promise(resolve => db.get(`SELECT telefono, numero_id FROM usuarios WHERE id=?`, [tecnicaId], (err,r) => resolve(r)));
      const telTecnica2 = tecnica?.telefono || tecnica?.numero_id;
      if (!telTecnica2) continue;
      const sucursal = await obtenerDatosSucursal(data.sucursal);
      if (!sucursal?.phone_number_id || !sucursal?.token) continue;

      const primera = data.citas[0];
      const listaCitas = data.citas.map((c, i) => `${i+1}. ${c.hora_inicio?.slice(0,5)} — ${c.contacto_nombre || 'Sin nombre'} (${c.servicio || 'Sin especificar'})`).join('\n');
      const mensaje = `🌸 *¡Buenos días ${data.nombre}!*\n\nHoy tienes *${data.citas.length} cita${data.citas.length > 1 ? 's' : ''}*:\n\n${listaCitas}\n\nTu primera cita es a las *${primera.hora_inicio?.slice(0,5)}*. ¡Mucho éxito hoy! ✨`;

      await enviarMensajeWhatsApp(sucursal.phone_number_id, sucursal.token, telTecnica2, mensaje);
    }
  });
}, { timezone: 'America/Mexico_City' });

// ============================================
// ENDPOINTS DE SUCURSALES
// ============================================

app.get('/api/sucursales', auth, (req, res) => {
  db.all(`SELECT s.*, n.token FROM sucursales s
          LEFT JOIN numeros n ON n.phone_number_id = s.phone_number_id
          WHERE s.activo = 1 ORDER BY s.nombre`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/sucursales', auth, requireRole('admin'), (req, res) => {
  const { nombre, direccion, phone_number_id, logo_url } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  db.run(`INSERT INTO sucursales (nombre, direccion, phone_number_id, logo_url) VALUES (?,?,?,?)`,
    [nombre, direccion || null, phone_number_id || null, logo_url || null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, id: this.lastID });
    });
});

app.put('/api/sucursales/:id', auth, requireRole('admin'), (req, res) => {
  const { nombre, direccion, phone_number_id, logo_url } = req.body;
  db.run(`UPDATE sucursales SET nombre=?, direccion=?, phone_number_id=?, logo_url=? WHERE id=?`,
    [nombre, direccion || null, phone_number_id || null, logo_url || null, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
});

app.delete('/api/sucursales/:id', auth, requireRole('admin'), (req, res) => {
  db.run(`UPDATE sucursales SET activo=0 WHERE id=?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// Usuarios por sucursal
app.get('/api/sucursales/:id/usuarios', auth, requireRole('admin', 'supervisor'), (req, res) => {
  db.get(`SELECT nombre FROM sucursales WHERE id=?`, [req.params.id], (err, suc) => {
    if (!suc) return res.status(404).json({ error: 'Sucursal no encontrada' });
    db.all(`SELECT id, nombre, email, rol, numero_id FROM usuarios WHERE sucursal=?`,
      [suc.nombre], (err, rows) => res.json(rows || []));
  });
});


// ============================================
// CRON + NOTIFICACIONES WHATSAPP A TÉCNICAS
// ============================================
const cron = require('node-cron');

async function enviarMensajeWhatsApp(phoneNumberId, token, telefono, mensaje) {
  try {
    const telefonoLimpio = telefono.replace(/\D/g, '');
    const telefonoFinal = telefonoLimpio.startsWith('52') ? telefonoLimpio : '52' + telefonoLimpio;
    const response = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: telefonoFinal,
        type: 'text',
        text: { body: mensaje }
      })
    });
    const data = await response.json();
    return { ok: !data.error, data };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

async function obtenerDatosSucursal(sucursalNombre) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT s.phone_number_id, n.token FROM sucursales s
            LEFT JOIN numeros n ON n.phone_number_id = s.phone_number_id
            WHERE s.nombre = ? AND s.activo = 1`, [sucursalNombre], (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

// CRON — Recordatorio día anterior a las 8pm
cron.schedule('0 20 * * *', async () => {
  console.log('[CRON] Enviando recordatorios noche...');
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const fechaManana = manana.toISOString().split('T')[0];

  db.all(`SELECT c.*, u.nombre as tecnica_nombre, ct.nombre as contacto_nombre
          FROM citas c
          LEFT JOIN usuarios u ON c.tecnica_id = u.id
          LEFT JOIN contactos ct ON c.contacto_id = ct.id
          WHERE c.fecha = ? AND c.estado = 'pendiente' AND c.tecnica_id IS NOT NULL
          ORDER BY c.tecnica_id, c.hora_inicio`, [fechaManana], async (err, citas) => {
    if (err || !citas.length) return;

    // Agrupar por técnica
    const porTecnica = {};
    citas.forEach(c => {
      if (!porTecnica[c.tecnica_id]) porTecnica[c.tecnica_id] = { nombre: c.tecnica_nombre, sucursal: c.sucursal, citas: [] };
      porTecnica[c.tecnica_id].citas.push(c);
    });

    for (const [tecnicaId, data] of Object.entries(porTecnica)) {
      const tecnica = await new Promise(resolve => db.get(`SELECT numero_id FROM usuarios WHERE id=?`, [tecnicaId], (err,r) => resolve(r)));
      if (!tecnica?.numero_id) continue;
      const sucursal = await obtenerDatosSucursal(data.sucursal);
      if (!sucursal?.phone_number_id || !sucursal?.token) continue;

      const fechaTexto = manana.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
      const listaCitas = data.citas.map((c, i) => `${i+1}. ${c.hora_inicio?.slice(0,5)} — ${c.contacto_nombre || 'Sin nombre'} (${c.servicio || 'Sin especificar'})`).join('\n');
      const mensaje = `🌙 *Recordatorio para mañana*\n\nHola ${data.nombre}, mañana *${fechaTexto}* tienes *${data.citas.length} cita${data.citas.length > 1 ? 's' : ''}*:\n\n${listaCitas}\n\n¡Que tengas una excelente jornada! 🌸`;

      await enviarMensajeWhatsApp(sucursal.phone_number_id, sucursal.token, tecnica.numero_id, mensaje);
    }
  });
}, { timezone: 'America/Mexico_City' });

// CRON — Recordatorio mismo día a las 7am
cron.schedule('0 7 * * *', async () => {
  console.log('[CRON] Enviando recordatorios mañana...');
  const hoy = new Date().toISOString().split('T')[0];

  db.all(`SELECT c.*, u.nombre as tecnica_nombre, ct.nombre as contacto_nombre
          FROM citas c
          LEFT JOIN usuarios u ON c.tecnica_id = u.id
          LEFT JOIN contactos ct ON c.contacto_id = ct.id
          WHERE c.fecha = ? AND c.estado = 'pendiente' AND c.tecnica_id IS NOT NULL
          ORDER BY c.tecnica_id, c.hora_inicio`, [hoy], async (err, citas) => {
    if (err || !citas.length) return;

    const porTecnica = {};
    citas.forEach(c => {
      if (!porTecnica[c.tecnica_id]) porTecnica[c.tecnica_id] = { nombre: c.tecnica_nombre, sucursal: c.sucursal, citas: [] };
      porTecnica[c.tecnica_id].citas.push(c);
    });

    for (const [tecnicaId, data] of Object.entries(porTecnica)) {
      const tecnica = await new Promise(resolve => db.get(`SELECT numero_id FROM usuarios WHERE id=?`, [tecnicaId], (err,r) => resolve(r)));
      if (!tecnica?.numero_id) continue;
      const sucursal = await obtenerDatosSucursal(data.sucursal);
      if (!sucursal?.phone_number_id || !sucursal?.token) continue;

      const primera = data.citas[0];
      const listaCitas = data.citas.map((c, i) => `${i+1}. ${c.hora_inicio?.slice(0,5)} — ${c.contacto_nombre || 'Sin nombre'} (${c.servicio || 'Sin especificar'})`).join('\n');
      const mensaje = `🌸 *¡Buenos días ${data.nombre}!*\n\nHoy tienes *${data.citas.length} cita${data.citas.length > 1 ? 's' : ''}*:\n\n${listaCitas}\n\nTu primera cita es a las *${primera.hora_inicio?.slice(0,5)}*. ¡Mucho éxito hoy! ✨`;

      await enviarMensajeWhatsApp(sucursal.phone_number_id, sucursal.token, tecnica.numero_id, mensaje);
    }
  });
}, { timezone: 'America/Mexico_City' });

// ============================================
// ENDPOINTS DE SUCURSALES
// ============================================

app.get('/api/sucursales', auth, (req, res) => {
  db.all(`SELECT s.*, n.token FROM sucursales s
          LEFT JOIN numeros n ON n.phone_number_id = s.phone_number_id
          WHERE s.activo = 1 ORDER BY s.nombre`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/sucursales', auth, requireRole('admin'), (req, res) => {
  const { nombre, direccion, phone_number_id, logo_url } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  db.run(`INSERT INTO sucursales (nombre, direccion, phone_number_id, logo_url) VALUES (?,?,?,?)`,
    [nombre, direccion || null, phone_number_id || null, logo_url || null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, id: this.lastID });
    });
});

app.put('/api/sucursales/:id', auth, requireRole('admin'), (req, res) => {
  const { nombre, direccion, phone_number_id, logo_url } = req.body;
  db.run(`UPDATE sucursales SET nombre=?, direccion=?, phone_number_id=?, logo_url=? WHERE id=?`,
    [nombre, direccion || null, phone_number_id || null, logo_url || null, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
});

app.delete('/api/sucursales/:id', auth, requireRole('admin'), (req, res) => {
  db.run(`UPDATE sucursales SET activo=0 WHERE id=?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// Usuarios por sucursal
app.get('/api/sucursales/:id/usuarios', auth, requireRole('admin', 'supervisor'), (req, res) => {
  db.get(`SELECT nombre FROM sucursales WHERE id=?`, [req.params.id], (err, suc) => {
    if (!suc) return res.status(404).json({ error: 'Sucursal no encontrada' });
    db.all(`SELECT id, nombre, email, rol, numero_id FROM usuarios WHERE sucursal=?`,
      [suc.nombre], (err, rows) => res.json(rows || []));
  });
});

app.listen(process.env.PORT, () => console.log(`Sistema WhatsApp corriendo en puerto ${process.env.PORT}`));
