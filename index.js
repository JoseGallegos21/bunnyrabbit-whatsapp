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
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY, nombre TEXT, email TEXT UNIQUE, password TEXT, numero_id TEXT, sucursal TEXT, rol TEXT DEFAULT 'recepcionista')`);
  db.run(`CREATE TABLE IF NOT EXISTS mensajes (id INTEGER PRIMARY KEY, numero_id TEXT, contacto TEXT, mensaje TEXT, direccion TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, leido INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS numeros (id INTEGER PRIMARY KEY, nombre TEXT, sucursal TEXT, phone_number_id TEXT UNIQUE, token TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS contactos (id INTEGER PRIMARY KEY, telefono TEXT UNIQUE, nombre TEXT, notas TEXT, etapa TEXT DEFAULT 'Nuevo', prioridad TEXT DEFAULT 'Media', sucursal TEXT, numero_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS etiquetas (id INTEGER PRIMARY KEY, nombre TEXT UNIQUE, color TEXT DEFAULT '#075e54')`);
  db.run(`CREATE TABLE IF NOT EXISTS contacto_etiquetas (contacto_id INTEGER, etiqueta_id INTEGER, PRIMARY KEY (contacto_id, etiqueta_id))`);
});

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
  if(numero_id) {
    db.all('SELECT * FROM contactos WHERE numero_id=? ORDER BY nombre, telefono', [numero_id], (err, rows) => res.json(rows || []));
  } else {
    db.all('SELECT * FROM contactos ORDER BY nombre, telefono', [], (err, rows) => res.json(rows || []));
  }
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
    const token = jwt.sign({ id: user.id, rol: user.rol, numero_id: user.numero_id }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, usuario: { nombre: user.nombre, rol: user.rol, sucursal: user.sucursal, numero_id: user.numero_id } });
  });
});

app.get('/api/mensajes', auth, (req, res) => {
  const numero_id = req.user.rol === 'supervisor' ? req.query.numero_id : req.user.numero_id;
  const query = numero_id ? 'SELECT * FROM mensajes WHERE numero_id = ? ORDER BY timestamp DESC LIMIT 100' : 'SELECT * FROM mensajes ORDER BY timestamp DESC LIMIT 200';
  const params = numero_id ? [numero_id] : [];
  db.all(query, params, (err, rows) => res.json(rows || []));
});

app.get('/api/numeros', auth, (req, res) => {
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
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
  const nid = req.user.rol === 'supervisor' ? numero_id : req.user.numero_id;
  db.get('SELECT * FROM numeros WHERE phone_number_id = ?', [nid], async (err, num) => {
    if (!num) return res.status(404).json({ error: 'Número no encontrado' });
    try {
      await axios.post(`https://graph.facebook.com/v18.0/${nid}/messages`, { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: mensaje } }, { headers: { Authorization: `Bearer ${num.token}` } });
      db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion) VALUES (?, ?, ?, ?)', [nid, telefono, mensaje, 'saliente']);
      res.json({ ok: true });
    } catch (e) { console.error('Error enviar:', JSON.stringify(e.response?.data || e.message)); res.status(500).json({ error: e.response?.data || e.message }); }
  });
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
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
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

app.post('/webhook', (req, res) => {
  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  if (entry?.messages) {
    const msg = entry.messages[0];
    const numero_id = entry.metadata.phone_number_id;
    const telefono = msg.from;
    db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion) VALUES (?, ?, ?, ?)', [numero_id, telefono, msg.text?.body || '[media]', 'entrante']);
    db.run(`INSERT INTO contactos (telefono, numero_id, etapa, prioridad) VALUES (?, ?, 'Nuevo', 'Media') ON CONFLICT(telefono) DO NOTHING`, [telefono, numero_id]);
  }
  res.sendStatus(200);
});

app.post('/api/usuarios', auth, async (req, res) => {
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  const { nombre, email, password, numero_id, sucursal, rol } = req.body;
  const hash = await bcrypt.hash(password, 10);
  db.run('INSERT INTO usuarios (nombre, email, password, numero_id, sucursal, rol) VALUES (?, ?, ?, ?, ?, ?)', [nombre, email, hash, numero_id, sucursal, rol || 'recepcionista'], function(err) {
    if (err) return res.status(400).json({ error: 'Email ya existe' });
    res.json({ id: this.lastID });
  });
});


app.get('/api/usuarios', auth, (req, res) => {
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  db.all('SELECT id, nombre, email, sucursal, numero_id, rol FROM usuarios', [], (err, rows) => res.json(rows || []));
});

app.put('/api/usuarios/:id', auth, async (req, res) => {
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  const { nombre, sucursal, numero_id, rol, password } = req.body;
  if (password) {
    const hash = await require('bcryptjs').hash(password, 10);
    db.run('UPDATE usuarios SET nombre=?, sucursal=?, numero_id=?, rol=?, password=? WHERE id=?', [nombre, sucursal, numero_id, rol, hash, req.params.id], (err) => res.json({ ok: !err }));
  } else {
    db.run('UPDATE usuarios SET nombre=?, sucursal=?, numero_id=?, rol=? WHERE id=?', [nombre, sucursal, numero_id, rol, req.params.id], (err) => res.json({ ok: !err }));
  }
});

app.delete('/api/usuarios/:id', auth, (req, res) => {
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  db.run('DELETE FROM usuarios WHERE id=?', [req.params.id], (err) => res.json({ ok: !err }));
});

app.get('/api/plantillas', auth, (req, res) => {
  if (req.user.rol === 'supervisor') {
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
        if (numRow && numRow.token) {
          const metaRes = await require('axios').post(
            `https://graph.facebook.com/v18.0/${numId}/message_templates`,
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
    if (err) return res.status(400).json({ error: err.message });
    res.json({ id: this.lastID, nombre, categoria, contenido });
  });
});

app.put('/api/plantillas/:id', auth, (req, res) => {
  const { nombre, categoria, contenido } = req.body;
  db.run('UPDATE plantillas SET nombre=?, categoria=?, contenido=? WHERE id=?', [nombre, categoria, contenido, req.params.id], (err) => res.json({ ok: !err }));
});

app.delete('/api/plantillas/:id', auth, (req, res) => {
  db.run('DELETE FROM plantillas WHERE id=?', [req.params.id], (err) => res.json({ ok: !err }));
});

app.post('/api/difusion', auth, async (req, res) => {
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
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
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
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
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  db.get('SELECT * FROM facebook_capi_config LIMIT 1', [], (err, row) => {
    if (!row) return res.json({ configured: false });
    res.json({ configured: true, pixel_id: row.pixel_id, test_event_code: row.test_event_code, api_version: row.api_version, triggers: JSON.parse(row.triggers || '[]'), has_token: !!row.access_token });
  });
});

// Probar conexión CAPI
app.post('/api/facebook/test', auth, async (req, res) => {
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  const result = await sendCapiEvent('Lead', { nombre: 'Test BunnyRabbit', telefono: '5200000000000', etapa: 'test' });
  res.json(result);
});

// Logs CAPI
app.get('/api/facebook/logs', auth, (req, res) => {
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
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
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  db.get('SELECT COUNT(*) as total, SUM(CASE WHEN status_code=200 THEN 1 ELSE 0 END) as exitosos, SUM(CASE WHEN status_code!=200 THEN 1 ELSE 0 END) as fallidos FROM facebook_capi_logs', [], (err, row) => res.json(row || { total: 0, exitosos: 0, fallidos: 0 }));
});


// ===== CAPI POR NUMERO =====
app.get('/api/numeros/capi', auth, (req, res) => {
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  db.all('SELECT id, nombre, sucursal, phone_number_id, pixel_id, capi_version, capi_test_code, capi_activo, capi_triggers FROM numeros ORDER BY sucursal', [], (err, rows) => {
    res.json(rows || []);
  });
});

app.put('/api/numeros/:id/capi', auth, (req, res) => {
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
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
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
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
  if (req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  const { nombre, sucursal, phone_number_id, pixel_id, capi_version, token: waToken, capi_token, capi_activo } = req.body;
  if (!nombre || !phone_number_id) return res.status(400).json({ error: 'Nombre y Phone Number ID son obligatorios' });
  db.run(
    'INSERT INTO numeros (nombre, sucursal, phone_number_id, token, pixel_id, capi_token, capi_version, capi_activo, capi_triggers) VALUES (?,?,?,?,?,?,?,?,?)',
    [nombre, sucursal||nombre, phone_number_id, waToken||null, pixel_id||null, capi_token||null, capi_version||'v21.0', capi_activo?1:0, '[]'],
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
    db.get('SELECT * FROM numeros WHERE phone_number_id=?', [numero_id], async (err2, num) => {
      if (!num) return res.status(404).json({ error: 'Numero no encontrado' });
      try {
        await require('axios').post(
          'https://graph.facebook.com/v18.0/' + numero_id + '/messages',
          {
            messaging_product: 'whatsapp',
            to: telefono,
            type: 'template',
            template: {
              name: plantilla.nombre.toLowerCase().replace(/\s+/g, '_'),
              language: { code: 'es' },
              components: []
            }
          },
          { headers: { Authorization: 'Bearer ' + num.token } }
        );
        db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion) VALUES (?,?,?,?)',
          [numero_id, telefono, '[Plantilla: ' + plantilla.nombre + ']', 'saliente']);
        res.json({ ok: true });
      } catch(e) {
        const msg = e.response?.data?.error?.message || e.message;
        res.json({ ok: false, error: msg });
      }
    });
  });
});

app.listen(process.env.PORT, () => console.log(`Sistema WhatsApp corriendo en puerto ${process.env.PORT}`));
