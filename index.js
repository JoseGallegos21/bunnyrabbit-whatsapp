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
// Guardar el cuerpo crudo: la firma de Meta se calcula sobre los bytes exactos
// recibidos, no sobre el JSON reserializado.
// limit alto: los webhooks de sincronizacion de coexistencia (history) traen
// muchos mensajes y superan el limite por defecto de Express (100kb) -> se
// rechazaban con 413 y no llegaba el historial.
app.use(express.json({ limit: '25mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// Los bots que escanean la URL publica mandan JSON malformado o peticiones sin
// cuerpo. Sin esto, body-parser lanza y deja un stack trace en los logs por cada
// basura. Se responde 400 limpio y no se ensucia el log.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  next(err);
});
// Que req.body sea SIEMPRE un objeto: asi un POST vacio no rompe los handlers
// que hacen const { x } = req.body.
app.use((req, res, next) => { if (req.body == null) req.body = {}; next(); });
app.use(require('express').static('public'));

// Extension anclada (antes /jpeg|jpg.../ dejaba pasar .gifx, .pngx, etc.)
const EXT_IMG = /^\.(jpe?g|png|gif|webp)$/;
// Nombre unico: Date.now solo colisiona si suben 2 en el mismo ms; agregamos aleatorio
const nombreArchivo = (prefijo, file) => prefijo + Date.now() + '_' + Math.floor(Math.random() * 1e6) + path.extname(file.originalname).toLowerCase();
const multerStorage = multer.diskStorage({
  destination: function(req, file, cb){ cb(null, './public/uploads/'); },
  filename: function(req, file, cb){ cb(null, nombreArchivo('img_', file)); }
});
const upload = multer({
  storage: multerStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function(req, file, cb){
    cb(null, EXT_IMG.test(path.extname(file.originalname).toLowerCase()));
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
  // Remarketing con aprobacion: la recepcionista crea una solicitud y el
  // supervisor la aprueba antes de enviar (con contenido, costo y # de contactos).
  db.run(`CREATE TABLE IF NOT EXISTS remarketing_solicitudes (id INTEGER PRIMARY KEY AUTOINCREMENT, solicitante_id INTEGER, solicitante_nombre TEXT, sucursal TEXT, numero_id TEXT, plantilla_id INTEGER, plantilla_nombre TEXT, plantilla_contenido TEXT, categoria TEXT, telefonos TEXT, total_contactos INTEGER, costo_usd REAL DEFAULT 0, costo_mxn REAL, estado TEXT DEFAULT 'pendiente', aprobador_id INTEGER, aprobador_nombre TEXT, motivo TEXT, difusion_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at DATETIME)`);
  db.run(`CREATE TABLE IF NOT EXISTS citas (id INTEGER PRIMARY KEY AUTOINCREMENT, contacto_id INTEGER, tecnica_id INTEGER, recepcionista_id INTEGER, numero_id TEXT, sucursal TEXT, fecha TEXT, hora_inicio TEXT, hora_fin TEXT, servicio TEXT, notas TEXT, estado TEXT DEFAULT 'pendiente', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS sucursales (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, direccion TEXT, phone_number_id TEXT, logo_url TEXT, activo INTEGER DEFAULT 1)`);
  db.run(`CREATE TABLE IF NOT EXISTS biblioteca_imagenes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, url TEXT, subido_por INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS respuestas_rapidas (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER, titulo TEXT, contenido TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS facebook_capi_config (id INTEGER PRIMARY KEY AUTOINCREMENT, pixel_id TEXT, access_token TEXT, test_event_code TEXT, api_version TEXT DEFAULT 'v21.0', triggers TEXT DEFAULT '[]', activo INTEGER DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS facebook_capi_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, contacto_nombre TEXT, contacto_telefono TEXT, evento_tipo TEXT, etapa TEXT, event_id TEXT, status_code INTEGER, respuesta TEXT, numero_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS google_calendar_config (id INTEGER PRIMARY KEY AUTOINCREMENT, sucursal TEXT UNIQUE, calendar_id TEXT, access_token TEXT, refresh_token TEXT, activo INTEGER DEFAULT 1)`);
  // Asistencia por cita (palomeo Vino/No vino). Base del sistema de cortes del
  // recepcionista. event_id = id del evento de Google (o 'cita:<id>' para citas
  // nativas). monto/metodo_pago quedan listos para la fase de corte de caja.
  db.run(`CREATE TABLE IF NOT EXISTS asistencias (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, sucursal TEXT, fecha TEXT, cliente TEXT, servicio TEXT, hora TEXT, estado TEXT, monto REAL, metodo_pago TEXT, tecnica_id INTEGER, marcado_por INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  // Tarifas de Meta por pais y categoria (USD por mensaje entregado).
  // Editables: Meta actualiza su tarifario y dejarlas fijas seria garantizar numeros viejos.
  db.run(`CREATE TABLE IF NOT EXISTS tarifas_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, pais TEXT, categoria TEXT, precio_usd REAL, actualizado DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(pais, categoria))`);
  db.run(`CREATE TABLE IF NOT EXISTS configuracion (clave TEXT PRIMARY KEY, valor TEXT)`);

  // ===== WORKFLOWS =====
  // activo=0 por defecto: un workflow recien creado NO envia nada hasta que se
  // activa a proposito. Mandan mensajes reales y cuestan dinero.
  db.run(`CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    activo INTEGER DEFAULT 0,
    trigger_tipo TEXT,
    trigger_config TEXT DEFAULT '{}',
    pasos TEXT DEFAULT '[]',
    sucursal TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Una inscripcion = un contacto recorriendo un workflow. proximo_en dice cuando
  // toca avanzarlo; el programador solo mira las que ya vencieron.
  db.run(`CREATE TABLE IF NOT EXISTS workflow_inscripciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER,
    contacto_id INTEGER,
    telefono TEXT,
    paso_actual INTEGER DEFAULT 0,
    estado TEXT DEFAULT 'activo',
    proximo_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    motivo_salida TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_insc_pendientes ON workflow_inscripciones (estado, proximo_en)`);
  db.run(`CREATE TABLE IF NOT EXISTS workflow_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inscripcion_id INTEGER,
    workflow_id INTEGER,
    telefono TEXT,
    paso INTEGER,
    accion TEXT,
    resultado TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Semillas. Solo MARKETING trae precio: es el unico que pude verificar contra el
  // tarifario de Meta. Los demas quedan sin precio a proposito, para que se
  // configuren desde el panel en vez de inventar una cifra que salga mal en los reportes.
  db.run(`INSERT OR IGNORE INTO tarifas_meta (pais, categoria, precio_usd) VALUES ('MX','MARKETING',0.0305)`);
  db.run(`INSERT OR IGNORE INTO tarifas_meta (pais, categoria, precio_usd) VALUES ('MX','UTILITY',NULL)`);
  db.run(`INSERT OR IGNORE INTO tarifas_meta (pais, categoria, precio_usd) VALUES ('MX','AUTHENTICATION',NULL)`);
  db.run(`INSERT OR IGNORE INTO configuracion (clave, valor) VALUES ('tipo_cambio_usd_mxn','')`);

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
  ensureColumns('plantillas', [
    ['idioma', "TEXT DEFAULT 'es'"],
    ['botones', 'TEXT']   // JSON con los textos de los botones de respuesta rapida
  ]);
  ensureColumns('mensajes', [
    ['origen', 'TEXT'],
    ['tipo', 'TEXT'],            // texto | plantilla
    ['categoria', 'TEXT'],       // MARKETING | UTILITY | AUTHENTICATION
    ['facturable', 'INTEGER DEFAULT 0'],
    ['costo_usd', 'REAL DEFAULT 0']
  ]);
  ensureColumns('difusiones', [
    ['plantilla_id', 'INTEGER'],
    ['categoria', 'TEXT'],
    ['fallidos', 'INTEGER DEFAULT 0'],
    ['costo_usd', 'REAL DEFAULT 0'],
    ['errores', 'TEXT']          // JSON con los errores agrupados, para que sean visibles
  ]);
  ensureColumns('contactos', [['origen', 'TEXT']]);
  // ruta = posicion del contacto en el arbol del workflow (soporta ramas anidadas)
  ensureColumns('workflow_inscripciones', [
    ['ruta', 'TEXT'],
    ['mensaje_wamid', 'TEXT']   // id del mensaje que se espera, para detectar "no entregado"
  ]);
  ensureColumns('etiquetas', [['usuario_id', 'INTEGER']]);
  ensureColumns('numeros', [
    ['waba_id', 'TEXT'],
    ['pixel_id', 'TEXT'], ['capi_token', 'TEXT'], ['capi_version', "TEXT DEFAULT 'v21.0'"],
    ['capi_test_code', 'TEXT'], ['capi_activo', 'INTEGER DEFAULT 0'], ['capi_triggers', "TEXT DEFAULT '[]'"],
    // Coexistencia (el numero sigue en la app del celular Y en la plataforma)
    ['es_coexistencia', 'INTEGER DEFAULT 0'],   // 1 = conectado por Embedded Signup en modo coexistencia
    ['sync_estado', 'TEXT'],                    // pendiente | sincronizando | listo | error
    ['sync_progreso', 'INTEGER DEFAULT 0']      // 0-100, avance de la sincronizacion de historial
  ]);
  // Remarketing: soportar tambien enviar un WORKFLOW (no solo una plantilla)
  ensureColumns('remarketing_solicitudes', [
    ['tipo', "TEXT DEFAULT 'plantilla'"],   // plantilla | workflow
    ['workflow_id', 'INTEGER'],
    ['workflow_nombre', 'TEXT']
  ]);
  // Al reiniciar, una difusion que quedo 'enviando' ya no se reanuda (el envio
  // corre en segundo plano y se corta con el reinicio). La marcamos 'interrumpida'
  // para que no aparezca eternamente "en progreso".
  db.run("UPDATE difusiones SET estado='interrumpida' WHERE estado='enviando'");
});

// ==================== COSTOS DE META ====================
// Modelo por mensaje desde el 1-jul-2025:
//   MARKETING          -> siempre se cobra
//   UTILITY / AUTH     -> gratis dentro de la ventana de servicio, se cobran fuera
//   texto y servicio   -> gratis (fuera de ventana Meta ni siquiera los permite)
// Documentacion: developers.facebook.com/documentation/business-messaging/whatsapp/pricing

function paisDeTelefono(tel) {
  const t = String(tel || '').replace(/\D/g, '');
  if (t.startsWith('52')) return 'MX';
  if (t.startsWith('1')) return 'US';
  return 'OTRO';
}

// Ventana de servicio: 24h desde el ultimo mensaje que envio el cliente
function ventanaAbierta(contacto) {
  return new Promise((resolve) => {
    db.get(`SELECT MAX(timestamp) t FROM mensajes WHERE contacto=? AND direccion='entrante'`, [contacto], (e, r) => {
      if (!r || !r.t) return resolve(false);
      const ultimo = new Date(String(r.t).replace(' ', 'T') + 'Z').getTime(); // SQLite guarda UTC
      resolve(!isNaN(ultimo) && (Date.now() - ultimo) < 24 * 3600 * 1000);
    });
  });
}

function tarifa(pais, categoria) {
  return new Promise((resolve) => {
    db.get('SELECT precio_usd FROM tarifas_meta WHERE pais=? AND categoria=?', [pais, categoria], (e, r) => {
      resolve(r && r.precio_usd != null ? r.precio_usd : null);
    });
  });
}

// Calcula si un envio se cobra y cuanto. Devuelve tarifa_configurada=false cuando
// no hay precio cargado, para no reportar 0 y hacer creer que fue gratis.
async function calcularCosto(telefono, categoria) {
  const cat = String(categoria || '').toUpperCase();
  const pais = paisDeTelefono(telefono);
  let facturable = false;
  if (cat === 'MARKETING') facturable = true;
  else if (cat === 'UTILITY' || cat === 'AUTHENTICATION') facturable = !(await ventanaAbierta(telefono));

  if (!facturable) return { facturable: 0, costo_usd: 0, pais, categoria: cat || null, tarifa_configurada: true };
  const precio = await tarifa(pais, cat);
  return {
    facturable: 1,
    costo_usd: precio != null ? precio : 0,
    pais,
    categoria: cat,
    tarifa_configurada: precio != null
  };
}

function configGet(clave) {
  return new Promise((resolve) => {
    db.get('SELECT valor FROM configuracion WHERE clave=?', [clave], (e, r) => resolve(r ? r.valor : null));
  });
}

// Arma los componentes de la plantilla rellenando sus variables {{1}}, {{2}}...
// Convencion: {{1}} = primer nombre del contacto. Las demas se rellenan con el
// nombre completo como valor por defecto seguro, porque Meta RECHAZA el envio si
// una variable va vacia. contacto = { nombre, telefono }.
function construirComponentesPlantilla(plantilla, contacto) {
  const texto = (plantilla && plantilla.contenido) || '';
  let max = 0;
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m;
  while ((m = re.exec(texto)) !== null) max = Math.max(max, parseInt(m[1], 10));
  if (max === 0) return []; // sin variables

  const nombre = (contacto && contacto.nombre) ? String(contacto.nombre).trim() : '';
  const primerNombre = nombre ? nombre.split(/\s+/)[0] : 'Hola';
  const parametros = [];
  for (let i = 1; i <= max; i++) {
    // {{1}} = primer nombre; el resto = nombre completo o un valor no vacio
    const valor = i === 1 ? primerNombre : (nombre || primerNombre);
    parametros.push({ type: 'text', text: valor });
  }
  return [{ type: 'body', parameters: parametros }];
}

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
    filename: function(req, file, cb){ cb(null, nombreArchivo('bib_', file)); }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function(req, file, cb){
    cb(null, EXT_IMG.test(path.extname(file.originalname).toLowerCase()));
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

app.put('/api/contactos/:id', auth, requireRole('admin', 'supervisor', 'recepcionista'), async (req, res) => {
  const { nombre, etapa, prioridad, notas } = req.body;
  db.get('SELECT etapa, telefono, numero_id, nombre as nombre_actual FROM contactos WHERE id=?', [req.params.id], (err, contactoAnterior) => {
    db.run('UPDATE contactos SET nombre=?, etapa=?, prioridad=?, notas=? WHERE id=?',
      [nombre, etapa||'Nuevo', prioridad||'Media', notas||'', req.params.id],
      async (err2) => {
        if (!err2 && contactoAnterior && etapa && etapa !== contactoAnterior.etapa) {
          // Disparador de workflows: cambio de etapa
          dispararWorkflows('etapa_cambio', { contacto_id: req.params.id, etapa });
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

app.delete('/api/contactos/:id', auth, requireRole('admin', 'supervisor', 'recepcionista'), (req, res) => {
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
    [req.params.id, etiqueta_id], function (err) {
      res.json({ ok: !err });
      // Disparador de workflows: etiqueta añadida
      if (!err && this.changes > 0) {
        db.get('SELECT nombre FROM etiquetas WHERE id=?', [etiqueta_id], (e, et) => {
          if (et) dispararWorkflows('etiqueta_agregada', { contacto_id: req.params.id, etiqueta: et.nombre });
        });
      }
    });
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

// Rate limiting del login: evita que prueben contrasenas sin limite.
// En memoria (no hace falta dependencia extra). Se cuenta por IP: tras 5 fallos
// en 15 min se bloquea 15 min. Un login correcto reinicia el contador.
const LOGIN_MAX = 5, LOGIN_VENTANA_MS = 15 * 60 * 1000;
const loginIntentos = new Map(); // ip -> { fallos, hasta }
function ipDe(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'desconocida'; }
// Limpieza periodica para que el Map no crezca sin fin
setInterval(() => { const ahora = Date.now(); for (const [ip, v] of loginIntentos) if (v.hasta < ahora) loginIntentos.delete(ip); }, 60 * 60 * 1000);

app.post('/api/login', (req, res) => {
  const ip = ipDe(req);
  const reg = loginIntentos.get(ip);
  if (reg && reg.bloqueadoHasta && reg.bloqueadoHasta > Date.now()) {
    const min = Math.ceil((reg.bloqueadoHasta - Date.now()) / 60000);
    return res.status(429).json({ error: `Demasiados intentos. Espera ${min} min.` });
  }
  const { email, password } = req.body;
  db.get('SELECT * FROM usuarios WHERE email = ?', [email], async (err, user) => {
    if (!user || !(await bcrypt.compare(password || '', user.password))) {
      // Contar el fallo
      const r = loginIntentos.get(ip) || { fallos: 0 };
      r.fallos++;
      if (r.fallos >= LOGIN_MAX) { r.bloqueadoHasta = Date.now() + LOGIN_VENTANA_MS; r.fallos = 0; }
      loginIntentos.set(ip, r);
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    loginIntentos.delete(ip); // login correcto: borron y cuenta nueva
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

// Historial de mensajes de un contacto (lo usa el panel de supervisor al abrir un chat)
app.get('/api/mensajes/:telefono', auth, (req, res) => {
  const numero_id = req.user.rol === 'supervisor' ? req.query.numero_id : req.user.numero_id;
  const cond = ['contacto = ?'], params = [req.params.telefono];
  if (numero_id) { cond.push('numero_id = ?'); params.push(numero_id); }
  db.all(`SELECT * FROM mensajes WHERE ${cond.join(' AND ')} ORDER BY timestamp ASC LIMIT 500`, params, (err, rows) => res.json(rows || []));
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

// Metricas del panel de supervisor: citas de hoy + actividad por recepcionista.
// Un supervisor solo ve su sucursal; un admin ve todo.
app.get('/api/metricas/supervisor', auth, requireRole('admin', 'supervisor'), (req, res) => {
  const esSuper = req.user.rol === 'supervisor';
  const sucursal = esSuper ? req.user.sucursal : null;
  const sucCond = sucursal ? ' AND sucursal = ?' : '';
  const sucParam = sucursal ? [sucursal] : [];
  db.get(`SELECT COUNT(*) total_citas_hoy,
                 SUM(CASE WHEN estado='pendiente' THEN 1 ELSE 0 END) pendientes,
                 SUM(CASE WHEN estado='completada' THEN 1 ELSE 0 END) completadas,
                 SUM(CASE WHEN estado='cancelada' THEN 1 ELSE 0 END) canceladas
          FROM citas WHERE fecha = date('now','localtime')${sucCond}`, sucParam, (e1, citasHoy) => {
    const uCond = esSuper ? "WHERE rol='recepcionista' AND sucursal=?" : "WHERE rol='recepcionista'";
    const uParam = esSuper ? [sucursal] : [];
    db.all(`SELECT id, nombre, sucursal, numero_id FROM usuarios ${uCond}`, uParam, (e2, recs) => {
      recs = recs || [];
      if (!recs.length) return res.json({ citasHoy: citasHoy || {}, recepcionistas: [] });
      const out = [];
      recs.forEach(r => {
        db.get(`SELECT SUM(CASE WHEN date(timestamp)=date('now','localtime') THEN 1 ELSE 0 END) mensajes_hoy,
                       SUM(CASE WHEN timestamp >= datetime('now','-7 days') THEN 1 ELSE 0 END) mensajes_semana
                FROM mensajes WHERE numero_id=?`, [r.numero_id], (e3, ms) => {
          db.get('SELECT COUNT(*) total_contactos FROM contactos WHERE numero_id=?', [r.numero_id], (e4, cs) => {
            out.push({ nombre: r.nombre, sucursal: r.sucursal,
                       mensajes_hoy: ms?.mensajes_hoy || 0, mensajes_semana: ms?.mensajes_semana || 0,
                       total_contactos: cs?.total_contactos || 0 });
            if (out.length === recs.length) res.json({ citasHoy: citasHoy || {}, recepcionistas: out });
          });
        });
      });
    });
  });
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


app.get('/api/contactos/:telefono', auth, (req, res) => {
  db.get('SELECT * FROM contactos WHERE telefono = ?', [req.params.telefono], (err, contacto) => {
    if (!contacto) return res.json({ telefono: req.params.telefono, nombre: null, notas: null, etapa: 'Nuevo', prioridad: 'Media', etiquetas: [] });
    db.all('SELECT e.* FROM etiquetas e JOIN contacto_etiquetas ce ON e.id = ce.etiqueta_id WHERE ce.contacto_id = ?', [contacto.id], (err, etiquetas) => {
      res.json({ ...contacto, etiquetas: etiquetas || [] });
    });
  });
});

// Ruta bajo /tel/ para NO chocar con PUT /api/contactos/:id (Express matcheaba
// siempre :id y esta quedaba muerta: el upsert por telefono + etiquetas nunca corria).
app.put('/api/contactos/tel/:telefono', auth, requireRole('admin', 'supervisor', 'recepcionista'), (req, res) => {
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




app.put('/api/leer/:contacto', auth, (req, res) => {
  const numero_id = req.user.rol === 'supervisor' ? req.query.numero_id : req.user.numero_id;
  // Solo los mensajes de ESTE numero: si dos sucursales comparten el telefono de
  // un cliente, marcar leido en una ya no afecta a la otra.
  const cond = ['contacto = ?', "direccion = 'entrante'"], params = [req.params.contacto];
  if (numero_id) { cond.push('numero_id = ?'); params.push(numero_id); }
  db.run(`UPDATE mensajes SET leido = 1 WHERE ${cond.join(' AND ')}`, params, () => res.json({ ok: true }));
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

// Comprueba que el webhook lo manda Meta de verdad: HMAC-SHA256 del cuerpo
// con el App Secret de la app de Meta. Sin esto cualquiera que conozca la URL
// puede inyectar mensajes y contactos falsos.
//
// Si META_APP_SECRET no esta configurado, deja pasar y avisa en el log: activarlo
// a ciegas dejaria de recibir leads en cuanto se despliegue. Con el secreto
// puesto, rechaza todo lo que no venga firmado por Meta.
let _avisoFirmaDado = false;
function verificarFirmaMeta(req, res, next) {
  const secreto = process.env.META_APP_SECRET;
  if (!secreto) {
    if (!_avisoFirmaDado) {
      console.warn('[SEGURIDAD] META_APP_SECRET sin configurar: el webhook acepta peticiones de cualquiera. Configuralo en .env');
      _avisoFirmaDado = true;
    }
    return next();
  }
  const firma = req.get('X-Hub-Signature-256') || '';
  if (!firma.startsWith('sha256=') || !req.rawBody) {
    console.warn('[SEGURIDAD] webhook sin firma valida, rechazado');
    return res.sendStatus(403);
  }
  const esperado = 'sha256=' + require('crypto').createHmac('sha256', secreto).update(req.rawBody).digest('hex');
  const a = Buffer.from(firma), b = Buffer.from(esperado);
  // timingSafeEqual evita filtrar la firma por el tiempo de comparacion
  if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
    console.warn('[SEGURIDAD] webhook con firma invalida, rechazado');
    return res.sendStatus(403);
  }
  next();
}

// Extrae el texto de un mensaje entrante, incluidos los botones de respuesta rapida.
// Los botones de plantilla llegan como type 'button'; los interactivos como 'interactive'.
function textoDeMensaje(msg) {
  if (!msg) return { texto: '[media]', esBoton: false };
  if (msg.type === 'button' && msg.button) return { texto: msg.button.text || msg.button.payload || '', esBoton: true };
  if (msg.type === 'interactive' && msg.interactive) {
    const i = msg.interactive;
    const t = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '';
    return { texto: t, esBoton: true };
  }
  return { texto: msg.text?.body || '[media]', esBoton: false };
}

// ==================== COEXISTENCIA: webhooks de sincronizacion ====================
// Cuando un numero se conecta en modo coexistencia, Meta manda 3 tipos de eventos
// ademas de los normales. Los procesamos de forma tolerante (siempre 200, nunca
// rompen el flujo existente) y registramos el payload crudo la primera vez para
// poder afinar el parseo contra datos reales.
let _coexLogueado = { history: 0, smb_app_state_sync: 0, smb_message_echoes: 0 };
function coexLogPrimeraVez(field, value) {
  if (_coexLogueado[field] != null && _coexLogueado[field] < 2) {
    _coexLogueado[field]++;
    try { console.log('[COEX] payload ' + field + ':', JSON.stringify(value).slice(0, 1500)); } catch (e) {}
  }
}

// Mensajes que la recepcionista escribe DESDE la app WhatsApp Business del celular.
// Llegan como "echoes"; los guardamos como salientes para que aparezcan en el CRM.
async function coexProcesarEchoes(value) {
  try {
    const numero_id = value?.metadata?.phone_number_id;
    const echoes = value?.message_echoes || value?.messages || [];
    for (const m of echoes) {
      const telefono = m.to || m.recipient_id || m.from;
      if (!telefono) continue;
      const { texto } = textoDeMensaje(m);
      db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion, origen) VALUES (?,?,?,?,?)',
        [numero_id, telefono, texto, 'saliente', 'celular']);
      db.run("INSERT INTO contactos (telefono, numero_id, etapa, prioridad, origen) VALUES (?,?,'Nuevo','Media','celular') ON CONFLICT(telefono) DO NOTHING", [telefono, numero_id]);
    }
  } catch (e) { console.error('[COEX] echoes:', e.message); }
}

// Altas/cambios de contactos sincronizados desde la libreta del celular.
async function coexProcesarStateSync(value) {
  try {
    const numero_id = value?.metadata?.phone_number_id;
    const items = value?.state_sync || value?.contacts || [];
    for (const it of items) {
      const c = it.contact || it;
      const telefono = c.phone_number || c.wa_id || c.phone || (c.profile && c.profile.phone);
      const nombre = c.full_name || c.name || (c.profile && c.profile.name) || null;
      if (!telefono) continue;
      db.run("INSERT INTO contactos (telefono, nombre, numero_id, etapa, prioridad, origen) VALUES (?,?,?,'Nuevo','Media','celular') ON CONFLICT(telefono) DO UPDATE SET nombre=COALESCE(excluded.nombre, contactos.nombre)",
        [telefono, nombre, numero_id]);
    }
  } catch (e) { console.error('[COEX] state_sync:', e.message); }
}

// Historial (hasta 180 dias) que Meta envia por fases. Guardamos los mensajes y
// registramos el progreso en la tabla numeros para poder mostrarlo en el panel.
async function coexProcesarHistorial(value) {
  try {
    // LOG CRUDO TEMPORAL para afinar el parseo contra el payload real de Meta.
    console.log('[COEX] RAW history:', JSON.stringify(value).slice(0, 1500));
    const numero_id = value?.metadata?.phone_number_id;
    let guardados = 0;
    let prog = value?.metadata?.progress ?? value?.progress ?? null;
    const guarda = (telefono, m, deMi) => {
      if (!telefono) return;
      const { texto } = textoDeMensaje(m);
      let ts = null;
      if (m.timestamp) { const d = new Date(Number(m.timestamp) * 1000); if (!isNaN(d)) ts = d.toISOString().slice(0, 19).replace('T', ' '); }
      db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion, timestamp, origen) VALUES (?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP),?)',
        [numero_id, telefono, texto, deMi ? 'saliente' : 'entrante', ts, 'historial']);
      db.run(`INSERT INTO contactos (telefono, numero_id, etapa, prioridad, origen) VALUES (?, ?, 'Nuevo', 'Media', 'historial') ON CONFLICT(telefono) DO NOTHING`, [telefono, numero_id]);
      guardados++;
    };
    // Forma A (documentada): value.history = chunks -> threads -> messages
    for (const chunk of (Array.isArray(value?.history) ? value.history : [])) {
      if (chunk?.metadata?.progress != null) prog = chunk.metadata.progress;
      const threads = chunk?.threads || (chunk?.messages ? [chunk] : []);
      for (const th of threads) {
        const cliente = th.id || th.thread_id || th.wa_id;
        for (const m of (th.messages || [])) {
          const deMi = (m.history_context && m.history_context.from_me) || m.from === numero_id;
          guarda(cliente || (deMi ? (m.to || m.recipient_id) : m.from), m, deMi);
        }
      }
    }
    // Forma B (la que manda Meta aqui): messages/message_echoes directo en value
    for (const m of (value.messages || [])) guarda(m.from, m, false);          // entrantes pasados
    for (const m of (value.message_echoes || [])) guarda(m.to || m.recipient_id, m, true); // salientes pasados
    if (numero_id && prog != null) {
      db.run("UPDATE numeros SET sync_progreso=?, sync_estado=CASE WHEN ?>=100 THEN 'listo' ELSE 'sincronizando' END WHERE phone_number_id=?", [Number(prog), Number(prog), numero_id]);
    }
    console.log('[COEX] historial: guardados ' + guardados + ' mensajes, progreso ' + prog);
  } catch (e) { console.error('[COEX] history:', e.message); }
}

app.post('/webhook', verificarFirmaMeta, (req, res) => {
  // Meta envia en lote: varias entry, varios changes y varios messages en un
  // solo POST. Iteramos TODO (antes solo se procesaba el primero y se perdian
  // los demas). Envuelto en try/catch: siempre respondemos 200 para que Meta no
  // reintente, aunque un payload venga malformado.
  try {
    for (const e of (req.body?.entry || [])) {
      for (const cambio of (e.changes || [])) {
        const field = cambio?.field;
        const value = cambio?.value;
        if (!value) continue;
        const numero_id = value.metadata?.phone_number_id;
        // HISTORIAL de coexistencia: llega bajo field 'history' con messages y/o
        // message_echoes de conversaciones PASADAS. Se procesa SOLO como historial
        // y se corta aqui para no mezclarlo con el trafico en vivo (evita que el
        // handler de echoes lo re-guarde como 'celular').
        if (field === 'history' || value.history) { coexLogPrimeraVez('history', value); coexProcesarHistorial(value); continue; }
        // Mensajes entrantes (puede venir mas de uno)
        for (const msg of (value.messages || [])) {
          const telefono = msg.from;
          const { texto } = textoDeMensaje(msg);
          const origen = origenDelMensaje(msg, texto);
          db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion, origen) VALUES (?, ?, ?, ?, ?)', [numero_id, telefono, texto, 'entrante', origen]);
          db.run(`INSERT INTO contactos (telefono, numero_id, etapa, prioridad, origen) VALUES (?, ?, 'Nuevo', 'Media', ?) ON CONFLICT(telefono) DO NOTHING`, [telefono, numero_id, origen]);
          // Si un workflow esta esperando la respuesta de este contacto, enrutar por el boton
          wfRutearRespuesta(telefono, texto).catch(err => console.error('[WF] rutear respuesta:', err.message));
        }
        // Estados de entrega: si un mensaje que se esperaba FALLO, enrutar a "no entregado"
        for (const st of (value.statuses || [])) {
          if (st.status === 'failed') wfRutearUndelivered(st.id).catch(err => console.error('[WF] rutear undelivered:', err.message));
        }
        // Coexistencia (trafico en vivo): mensajes del celular y contactos
        if (field === 'smb_message_echoes' || value.message_echoes) { coexLogPrimeraVez('smb_message_echoes', value); coexProcesarEchoes(value); }
        if (field === 'smb_app_state_sync' || value.state_sync)    { coexLogPrimeraVez('smb_app_state_sync', value); coexProcesarStateSync(value); }
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] error procesando payload:', err.message);
  }
  res.sendStatus(200);
});

// Datos publicos (App ID + config) que el panel necesita para abrir el Embedded
// Signup de Meta. El App Secret NUNCA sale de aqui; solo se usa en el backend.
app.get('/api/meta/embedded-config', auth, (req, res) => {
  if (req.user.rol !== 'admin' && req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  res.json({
    app_id: process.env.META_APP_ID || '',
    config_id: process.env.META_ES_CONFIG_ID || '',
    graph_version: process.env.META_GRAPH_VERSION || 'v21.0',
    configurado: !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_ES_CONFIG_ID)
  });
});

// Dispara la sincronizacion de contactos desde la app del celular. El historial
// llega solo si el negocio acepto compartirlo durante el onboarding. Debe correr
// dentro de las primeras 24h tras conectar (regla de Meta).
async function dispararSyncCoexistencia(phone_number_id, token, V) {
  try {
    const r = await axios.post(`https://graph.facebook.com/${V}/${phone_number_id}/smb_app_data`,
      { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' },
      { headers: { Authorization: 'Bearer ' + token } });
    console.log('[COEX] sync solicitado para ' + phone_number_id + ': ' + JSON.stringify(r.data));
    db.run("UPDATE numeros SET sync_estado='sincronizando' WHERE phone_number_id=?", [phone_number_id]);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('[COEX] no se pudo disparar sync:', msg);
    db.run("UPDATE numeros SET sync_estado='error' WHERE phone_number_id=?", [phone_number_id]);
  }
}

// Onboarding de coexistencia (Embedded Signup): recibe el 'code' que devuelve
// Meta, lo cambia por el token del numero, suscribe NUESTRA app a los webhooks
// del WABA, guarda el numero en modo coexistencia y arranca la sincronizacion.
app.post('/api/numeros/coexistencia', auth, async (req, res) => {
  if (req.user.rol !== 'admin' && req.user.rol !== 'supervisor') return res.status(403).json({ error: 'Sin acceso' });
  const { code, phone_number_id, waba_id, nombre, sucursal } = req.body;
  const APP_ID = process.env.META_APP_ID, APP_SECRET = process.env.META_APP_SECRET;
  const V = process.env.META_GRAPH_VERSION || 'v21.0';
  if (!APP_ID || !APP_SECRET) return res.status(400).json({ error: 'Falta configurar META_APP_ID y META_APP_SECRET en el .env del servidor' });
  if (!code || !phone_number_id || !waba_id) return res.status(400).json({ error: 'Faltan datos del Embedded Signup (code, phone_number_id, waba_id)' });
  try {
    // 1) code -> token del negocio
    const tk = await axios.get(`https://graph.facebook.com/${V}/oauth/access_token`,
      { params: { client_id: APP_ID, client_secret: APP_SECRET, code } });
    const token = tk.data && tk.data.access_token;
    if (!token) return res.status(502).json({ error: 'Meta no devolvio un token de acceso' });
    // 2) suscribir nuestra app a los webhooks del WABA
    await axios.post(`https://graph.facebook.com/${V}/${waba_id}/subscribed_apps`, {}, { headers: { Authorization: 'Bearer ' + token } });
    // 3) guardar el numero en modo coexistencia (sin pisar datos CAPI si ya existia)
    await new Promise((resolve, reject) => {
      db.run(`INSERT INTO numeros (nombre, sucursal, phone_number_id, token, waba_id, es_coexistencia, sync_estado, sync_progreso)
              VALUES (?,?,?,?,?,1,'pendiente',0)
              ON CONFLICT(phone_number_id) DO UPDATE SET token=excluded.token, waba_id=excluded.waba_id, es_coexistencia=1, sync_estado='pendiente'`,
        [nombre || sucursal || phone_number_id, sucursal || nombre || phone_number_id, phone_number_id, token, waba_id],
        (e) => e ? reject(e) : resolve());
    });
    // 4) disparar la sincronizacion (no bloquea la respuesta al panel)
    dispararSyncCoexistencia(phone_number_id, token, V);
    res.json({ ok: true, phone_number_id, waba_id });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('[COEX] onboarding:', msg);
    res.status(500).json({ error: 'Error al conectar: ' + msg });
  }
});

const ROLES_VALIDOS = ['admin', 'supervisor', 'recepcionista', 'tecnica'];

app.post('/api/usuarios', auth, async (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const { nombre, email, password, numero_id, sucursal, rol, telefono } = req.body;
  const rolPedido = rol || 'recepcionista';
  // El rol venia del body sin validar: un supervisor podia crearse una cuenta
  // de admin y quedarse con el sistema entero.
  if (!ROLES_VALIDOS.includes(rolPedido)) return res.status(400).json({ error: 'Rol inválido' });
  if (req.user.rol === 'supervisor' && (rolPedido === 'admin' || rolPedido === 'supervisor')) {
    return res.status(403).json({ error: 'Un supervisor solo puede crear recepcionistas o técnicas' });
  }
  if (!nombre || !email || !password) return res.status(400).json({ error: 'Faltan campos requeridos' });
  const hash = await bcrypt.hash(password, 10);
  db.run('INSERT INTO usuarios (nombre, email, password, numero_id, sucursal, rol, telefono) VALUES (?, ?, ?, ?, ?, ?, ?)', [nombre, email, hash, numero_id, sucursal, rolPedido, telefono || null], function(err) {
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
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const { nombre, sucursal, numero_id, rol, password } = req.body;
  // Mismas guardas que crear: no aceptar roles invalidos ni dejar que un
  // supervisor se ascienda a admin/supervisor (escalada de privilegios).
  if (rol && !ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol inválido' });
  if (req.user.rol === 'supervisor' && (rol === 'admin' || rol === 'supervisor')) {
    return res.status(403).json({ error: 'Un supervisor solo puede asignar recepcionista o técnica' });
  }
  // Verificar el usuario destino: un supervisor no puede editar admins/supervisores
  // ni usuarios de otra sucursal.
  db.get('SELECT rol, sucursal FROM usuarios WHERE id=?', [req.params.id], async (eDest, destino) => {
    if (eDest || !destino) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (req.user.rol === 'supervisor') {
      if (destino.rol === 'admin' || destino.rol === 'supervisor') return res.status(403).json({ error: 'No puedes editar admins ni supervisores' });
      if (destino.sucursal !== req.user.sucursal) return res.status(403).json({ error: 'Solo puedes editar usuarios de tu sucursal' });
    }
    const done = (err) => res.json({ ok: !err, error: err?.message });
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      db.run('UPDATE usuarios SET nombre=?, sucursal=?, numero_id=?, rol=?, password=? WHERE id=?', [nombre, sucursal, numero_id, rol, hash, req.params.id], done);
    } else {
      db.run('UPDATE usuarios SET nombre=?, sucursal=?, numero_id=?, rol=? WHERE id=?', [nombre, sucursal, numero_id, rol, req.params.id], done);
    }
  });
});

app.delete('/api/usuarios/:id', auth, (req, res) => {
  if (req.user.rol !== 'supervisor' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  if (String(req.user.id) === String(req.params.id)) return res.status(400).json({ error: 'No puedes borrar tu propio usuario' });
  db.get('SELECT rol FROM usuarios WHERE id=?', [req.params.id], (e, destino) => {
    if (!destino) return res.status(404).json({ error: 'Usuario no encontrado' });
    // Un supervisor no puede eliminar admins ni a otros supervisores
    if (req.user.rol === 'supervisor' && (destino.rol === 'admin' || destino.rol === 'supervisor')) {
      return res.status(403).json({ error: 'Un supervisor no puede eliminar admins ni supervisores' });
    }
    db.run('DELETE FROM usuarios WHERE id=?', [req.params.id], (err) => res.json({ ok: !err }));
  });
});

app.get('/api/plantillas', auth, (req, res) => {
  if (req.user.rol === 'supervisor' || req.user.rol === 'admin') {
    db.all('SELECT * FROM plantillas ORDER BY categoria, nombre', [], (err, rows) => res.json(rows || []));
  } else {
    db.all('SELECT * FROM plantillas WHERE phone_number_id=? OR phone_number_id IS NULL ORDER BY categoria, nombre', [req.user.numero_id], (err, rows) => res.json(rows || []));
  }
});

app.post('/api/plantillas', auth, requireRole('admin', 'supervisor', 'recepcionista'), async (req, res) => {
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

app.put('/api/plantillas/:id', auth, requireRole('admin', 'supervisor', 'recepcionista'), (req, res) => {
  const { nombre, categoria, contenido } = req.body;
  db.run('UPDATE plantillas SET nombre=?, categoria=?, contenido=? WHERE id=?', [nombre, categoria, contenido, req.params.id], (err) => res.json({ ok: !err }));
});

app.delete('/api/plantillas/:id', auth, requireRole('admin', 'supervisor', 'recepcionista'), (req, res) => {
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
            // Botones de respuesta rapida (QUICK_REPLY): son los que el cliente toca
            // y con los que la Etapa C ramificara el flujo.
            const compBtns = (t.components || []).find(c => c.type === 'BUTTONS');
            const botones = compBtns && Array.isArray(compBtns.buttons)
              ? compBtns.buttons.filter(x => x.type === 'QUICK_REPLY').map(x => x.text)
              : [];
            const botonesJson = JSON.stringify(botones);

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
                `UPDATE plantillas SET meta_template_id=?, estado_meta=?, categoria=?, contenido=?, idioma=?, botones=?,
                 phone_number_id=COALESCE(phone_number_id,?) WHERE id=?`,
                [t.id, estado, categoria, contenido, t.language || 'es', botonesJson, n.phone_number_id, fila.id], () => resolve()));
              vistas.add(fila.id);
              actualizadas++;
            } else {
              const nuevo = await new Promise(resolve => db.run(
                'INSERT INTO plantillas (nombre, categoria, contenido, phone_number_id, estado_meta, meta_template_id, idioma, botones) VALUES (?,?,?,?,?,?,?,?)',
                [t.name, categoria, contenido, n.phone_number_id, estado, t.id, t.language || 'es', botonesJson], function () { resolve(this.lastID); }));
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

// Envia una difusion en segundo plano: manda la PLANTILLA (unica forma que Meta
// permite fuera de la ventana de 24h), registra el costo de cada envio y guarda
// los errores agrupados para que se vean, en vez de tragarselos.
async function ejecutarDifusion(difId, num, plantilla, contactos) {
  const nombrePlantilla = plantilla.nombre.toLowerCase().replace(/\s+/g, '_');
  const idioma = plantilla.idioma || 'es';
  let enviados = 0, fallidos = 0, costo = 0;
  const errores = {}; // mensaje de error -> cuantas veces

  for (const c of contactos) {
    try {
      await require('axios').post(
        'https://graph.facebook.com/v18.0/' + num.phone_number_id + '/messages',
        { messaging_product: 'whatsapp', to: c.telefono, type: 'template',
          template: { name: nombrePlantilla, language: { code: idioma },
            components: construirComponentesPlantilla(plantilla, { nombre: c.nombre, telefono: c.telefono }) } },
        { headers: { Authorization: 'Bearer ' + num.token } });
      const costoMsg = await calcularCosto(c.telefono, plantilla.categoria);
      db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion, tipo, categoria, facturable, costo_usd) VALUES (?,?,?,?,?,?,?,?)',
        [num.phone_number_id, c.telefono, '[Difusión: ' + plantilla.nombre + ']', 'saliente', 'plantilla', costoMsg.categoria, costoMsg.facturable, costoMsg.costo_usd]);
      enviados++; costo += costoMsg.costo_usd;
    } catch (e) {
      fallidos++;
      const msg = e.response?.data?.error?.message || e.message || 'Error desconocido';
      errores[msg] = (errores[msg] || 0) + 1;
    }
    // Progreso cada 10 envios, para poder seguirlo en vivo
    if ((enviados + fallidos) % 10 === 0) {
      db.run('UPDATE difusiones SET enviados=?, fallidos=?, costo_usd=? WHERE id=?', [enviados, fallidos, Number(costo.toFixed(4)), difId]);
    }
    await new Promise(r => setTimeout(r, 250)); // ritmo para no saturar la API de Meta
  }

  const listaErrores = Object.entries(errores).map(([mensaje, veces]) => ({ mensaje, veces }));
  db.run('UPDATE difusiones SET enviados=?, fallidos=?, costo_usd=?, estado=?, errores=? WHERE id=?',
    [enviados, fallidos, Number(costo.toFixed(4)), 'completado', JSON.stringify(listaErrores), difId]);
  console.log(`[DIFUSION ${difId}] ${enviados} enviados, ${fallidos} fallidos, $${costo.toFixed(4)} USD`);
}

app.post('/api/difusion', auth, requireRole('admin', 'supervisor'), async (req, res) => {
  const { nombre, filtro_etapa, numero_id, plantilla_id } = req.body;
  // El remarketing solo funciona con plantillas: el texto libre lo rechaza Meta
  // fuera de la ventana de 24h. Por eso ahora la plantilla es obligatoria.
  if (!plantilla_id) return res.status(400).json({ error: 'Selecciona una plantilla. La difusión por texto no llega a contactos fuera de la ventana de 24h.' });
  try {
    const plantilla = await new Promise(r => db.get('SELECT * FROM plantillas WHERE id=?', [plantilla_id], (e, x) => r(x)));
    if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada' });
    if (plantilla.estado_meta !== 'aprobada') {
      return res.status(400).json({ error: `La plantilla "${plantilla.nombre}" no está aprobada por Meta (estado: ${plantilla.estado_meta}). Meta rechazará el envío.` });
    }
    const num = await resolverNumeroEnvio(req, numero_id);
    if (!num) return res.status(404).json({ error: 'No hay un número de WhatsApp configurado para enviar.' });
    if (!num.token) return res.status(400).json({ error: 'El número no tiene token de WhatsApp configurado.' });

    // Solo contactos de ESTE numero: antes mandaba (con costo real) a los contactos
    // de TODAS las sucursales sin importar desde que numero se lanzara.
    let query = 'SELECT telefono, MAX(nombre) nombre FROM contactos WHERE numero_id = ?';
    const params = [num.phone_number_id];
    if (filtro_etapa) { query += ' AND etapa=?'; params.push(filtro_etapa); }
    query += ' GROUP BY telefono';
    const contactos = await new Promise(r => db.all(query, params, (e, x) => r(x || [])));
    if (!contactos.length) return res.status(400).json({ error: 'No hay contactos que cumplan el filtro' });

    const difId = await new Promise((resolve, reject) => db.run(
      'INSERT INTO difusiones (nombre, mensaje, filtro_etapa, total, estado, phone_number_id, plantilla_id, categoria) VALUES (?,?,?,?,?,?,?,?)',
      [nombre || plantilla.nombre, '[Plantilla: ' + plantilla.nombre + ']', filtro_etapa || null, contactos.length, 'enviando', num.phone_number_id, plantilla_id, plantilla.categoria],
      function (e) { e ? reject(e) : resolve(this.lastID); }));

    // Responder ya; el envio corre en segundo plano y el frontend consulta el progreso
    res.json({ ok: true, difusion_id: difId, total: contactos.length });
    ejecutarDifusion(difId, num, plantilla, contactos).catch(e => {
      console.error('[DIFUSION ' + difId + '] error fatal:', e.message);
      db.run('UPDATE difusiones SET estado=?, errores=? WHERE id=?', ['error', JSON.stringify([{ mensaje: e.message, veces: 1 }]), difId]);
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Progreso de una difusion (para seguirla en vivo)
app.get('/api/difusion/:id', auth, (req, res) => {
  db.get('SELECT * FROM difusiones WHERE id=?', [req.params.id], (e, d) => {
    if (!d) return res.status(404).json({ error: 'No encontrada' });
    let errores = [];
    try { errores = JSON.parse(d.errores || '[]'); } catch (x) {}
    res.json({ ...d, errores });
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

// ==================== REMARKETING CON APROBACIÓN ====================
// La recepcionista arma una solicitud (plantilla + contactos). Se guarda como
// 'pendiente' y NO se envia hasta que su supervisor la apruebe. El supervisor ve
// contenido, costo estimado y # de contactos antes de aprobar.
function _getPlantilla(id) { return new Promise(r => db.get('SELECT * FROM plantillas WHERE id=?', [id], (e, x) => r(x))); }

// Busca la plantilla de envio de un workflow (para estimar costo y mostrar el
// mensaje al gerente). Recorre los pasos buscando un enviar_esperar/enviar_plantilla.
function _wfPlantillaDeEnvio(wf) {
  let pasos = []; try { pasos = JSON.parse(wf.pasos || '[]'); } catch (e) {}
  const buscar = (arr) => {
    for (const p of (arr || [])) {
      const pid = p.config && p.config.plantilla_id;
      if ((p.tipo === 'enviar_esperar' || p.tipo === 'enviar_plantilla') && pid) return pid;
      if (p.tipo === 'ramas' && p.config && Array.isArray(p.config.ramas)) {
        for (const rama of p.config.ramas) { const f = buscar(rama.pasos); if (f) return f; }
      }
    }
    return null;
  };
  return buscar(pasos);
}

// Inscribe un contacto en un workflow (mismo mecanismo que dispararWorkflows, directo).
async function wfInscribirContacto(wf, contacto) {
  const ya = await wfGet(`SELECT id FROM workflow_inscripciones WHERE workflow_id=? AND contacto_id=? AND (estado='activo' OR created_at > datetime('now','-24 hours')) LIMIT 1`, [wf.id, contacto.id]);
  if (ya) return false;
  const r = await wfRun('INSERT INTO workflow_inscripciones (workflow_id, contacto_id, telefono) VALUES (?,?,?)', [wf.id, contacto.id, contacto.telefono]);
  const insc = await wfGet('SELECT * FROM workflow_inscripciones WHERE id=?', [r.lastID]);
  await wfAvanzar(insc);
  return true;
}

// Mapa telefono -> [etiqueta_id], para filtrar contactos por etiqueta en el panel
app.get('/api/contactos-etiquetas', auth, (req, res) => {
  const numero_id = (req.user.rol === 'supervisor' || req.user.rol === 'admin') ? req.query.numero_id : req.user.numero_id;
  const cond = numero_id ? 'WHERE c.numero_id = ?' : '';
  const params = numero_id ? [numero_id] : [];
  db.all(`SELECT c.telefono, ce.etiqueta_id FROM contactos c JOIN contacto_etiquetas ce ON ce.contacto_id=c.id ${cond}`, params, (e, rows) => {
    const map = {};
    (rows || []).forEach(x => { (map[x.telefono] = map[x.telefono] || []).push(x.etiqueta_id); });
    res.json(map);
  });
});

// Workflows activos disponibles para remarketing (accesible a la recepcionista)
app.get('/api/remarketing/workflows', auth, requireRole('recepcionista', 'supervisor', 'admin'), async (req, res) => {
  const suc = req.user.rol === 'admin' ? null : req.user.sucursal;
  const wfs = await wfAll('SELECT id, nombre, sucursal FROM workflows WHERE activo=1');
  res.json((wfs || []).filter(w => !w.sucursal || !suc || w.sucursal === suc).map(w => ({ id: w.id, nombre: w.nombre })));
});

// Crear solicitud: puede ser una PLANTILLA o un WORKFLOW
app.post('/api/remarketing/solicitud', auth, requireRole('recepcionista', 'supervisor', 'admin'), async (req, res) => {
  const { tipo, plantilla_id, workflow_id, telefonos } = req.body;
  const esWorkflow = tipo === 'workflow';
  if (!esWorkflow && !plantilla_id) return res.status(400).json({ error: 'Selecciona una plantilla.' });
  if (esWorkflow && !workflow_id) return res.status(400).json({ error: 'Selecciona un workflow.' });
  if (!Array.isArray(telefonos) || !telefonos.length) return res.status(400).json({ error: 'Selecciona al menos un contacto.' });
  try {
    const num = await resolverNumeroEnvio(req, req.body.numero_id);
    const numero_id = num ? num.phone_number_id : req.user.numero_id;
    // Solo se aceptan contactos REALES del numero (evita mandar a numeros sueltos)
    const ph = telefonos.map(() => '?').join(',');
    const validos = await new Promise(r => db.all(
      `SELECT DISTINCT telefono FROM contactos WHERE telefono IN (${ph})` + (numero_id ? ' AND numero_id=?' : ''),
      numero_id ? [...telefonos, numero_id] : telefonos, (e, rows) => r((rows || []).map(x => x.telefono))));
    if (!validos.length) return res.status(400).json({ error: 'Ningún contacto válido seleccionado.' });

    let categoria = 'MARKETING', plNombre = null, plContenido = null, wfNombre = null;
    if (esWorkflow) {
      const workflow = await wfGet('SELECT * FROM workflows WHERE id=?', [workflow_id]);
      if (!workflow) return res.status(404).json({ error: 'Workflow no encontrado.' });
      wfNombre = workflow.nombre;
      const plId = _wfPlantillaDeEnvio(workflow);
      const plEnvio = plId ? await _getPlantilla(plId) : null;
      categoria = (plEnvio && plEnvio.categoria) || 'MARKETING';
      plNombre = plEnvio ? plEnvio.nombre : null;        // para mostrarle al gerente qué manda el workflow
      plContenido = plEnvio ? plEnvio.contenido : null;
    } else {
      const plantilla = await _getPlantilla(plantilla_id);
      if (!plantilla) return res.status(404).json({ error: 'Plantilla no encontrada.' });
      categoria = plantilla.categoria; plNombre = plantilla.nombre; plContenido = plantilla.contenido;
    }
    let costo = 0;
    for (const t of validos) { const c = await calcularCosto(t, categoria); costo += c.costo_usd; }
    const tc = parseFloat(await configGet('tipo_cambio_usd_mxn'));
    const costo_mxn = tc ? Number((costo * tc).toFixed(2)) : null;
    const id = await new Promise((resolve, reject) => db.run(
      `INSERT INTO remarketing_solicitudes (solicitante_id, solicitante_nombre, sucursal, numero_id, tipo, plantilla_id, plantilla_nombre, plantilla_contenido, workflow_id, workflow_nombre, categoria, telefonos, total_contactos, costo_usd, costo_mxn, estado)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pendiente')`,
      [req.user.id, req.user.nombre || '', req.user.sucursal || null, numero_id, esWorkflow ? 'workflow' : 'plantilla', esWorkflow ? null : plantilla_id, plNombre, plContenido, esWorkflow ? workflow_id : null, wfNombre, categoria, JSON.stringify(validos), validos.length, Number(costo.toFixed(4)), costo_mxn],
      function (e) { e ? reject(e) : resolve(this.lastID); }));
    res.json({ ok: true, id, total_contactos: validos.length, costo_usd: Number(costo.toFixed(4)), costo_mxn });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lista para el gerente (pendientes primero), acotada a su sucursal
app.get('/api/remarketing/solicitudes', auth, requireRole('supervisor', 'admin'), (req, res) => {
  const esSuper = req.user.rol === 'supervisor';
  const cond = esSuper ? 'WHERE sucursal = ?' : '';
  const params = esSuper ? [req.user.sucursal] : [];
  db.all(`SELECT * FROM remarketing_solicitudes ${cond} ORDER BY (estado='pendiente') DESC, created_at DESC LIMIT 50`, params, (e, rows) => res.json(rows || []));
});

// Las propias solicitudes de la recepcionista (para ver el estado)
app.get('/api/remarketing/mis-solicitudes', auth, (req, res) => {
  db.all('SELECT id, tipo, plantilla_nombre, workflow_nombre, total_contactos, costo_usd, costo_mxn, estado, motivo, created_at, resolved_at FROM remarketing_solicitudes WHERE solicitante_id=? ORDER BY created_at DESC LIMIT 30', [req.user.id], (e, rows) => res.json(rows || []));
});

// Aprobar -> envia la plantilla a esos contactos (envio simple, en 2do plano)
app.post('/api/remarketing/solicitud/:id/aprobar', auth, requireRole('supervisor', 'admin'), async (req, res) => {
  try {
    const sol = await new Promise(r => db.get('SELECT * FROM remarketing_solicitudes WHERE id=?', [req.params.id], (e, x) => r(x)));
    if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (req.user.rol === 'supervisor' && sol.sucursal !== req.user.sucursal) return res.status(403).json({ error: 'No es de tu sucursal.' });
    if (sol.estado !== 'pendiente') return res.status(400).json({ error: 'La solicitud ya fue ' + sol.estado + '.' });
    let telefonos = []; try { telefonos = JSON.parse(sol.telefonos || '[]'); } catch (e) {}

    // WORKFLOW: inscribir a los contactos (dispara el envio + ramas del workflow)
    if (sol.tipo === 'workflow') {
      const wf = await wfGet('SELECT * FROM workflows WHERE id=?', [sol.workflow_id]);
      if (!wf) return res.status(404).json({ error: 'El workflow ya no existe.' });
      if (!wf.activo) return res.status(400).json({ error: 'El workflow está apagado. Actívalo (admin → Automatizaciones) antes de aprobar.' });
      db.run("UPDATE remarketing_solicitudes SET estado='aprobada', aprobador_id=?, aprobador_nombre=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?", [req.user.id, req.user.nombre || '', sol.id]);
      res.json({ ok: true, tipo: 'workflow', total: telefonos.length });
      (async () => {
        for (const tel of telefonos) {
          const c = await wfGet('SELECT id, telefono FROM contactos WHERE telefono=?', [tel]);
          if (c) { try { await wfInscribirContacto(wf, c); } catch (e) { console.error('[REMARKETING wf] inscribir ' + tel + ':', e.message); } }
        }
        console.log('[REMARKETING ' + sol.id + '] inscritos ' + telefonos.length + ' en workflow ' + wf.nombre);
      })();
      return;
    }

    // PLANTILLA: envio simple
    const plantilla = await _getPlantilla(sol.plantilla_id);
    if (!plantilla) return res.status(404).json({ error: 'La plantilla ya no existe.' });
    if (plantilla.estado_meta !== 'aprobada') return res.status(400).json({ error: `La plantilla "${plantilla.nombre}" no está aprobada por Meta (${plantilla.estado_meta}). Meta rechazará el envío.` });
    const num = await new Promise(r => db.get('SELECT * FROM numeros WHERE phone_number_id=?', [sol.numero_id], (e, x) => r(x)));
    if (!num || !num.token) return res.status(400).json({ error: 'El número no tiene token de WhatsApp configurado.' });
    const contactos = await new Promise(r => {
      if (!telefonos.length) return r([]);
      const ph = telefonos.map(() => '?').join(',');
      db.all(`SELECT telefono, MAX(nombre) nombre FROM contactos WHERE telefono IN (${ph}) GROUP BY telefono`, telefonos, (e, rows) => {
        const map = {}; (rows || []).forEach(x => map[x.telefono] = x.nombre);
        r(telefonos.map(t => ({ telefono: t, nombre: map[t] || null })));
      });
    });
    const difId = await new Promise((resolve, reject) => db.run(
      'INSERT INTO difusiones (nombre, mensaje, total, estado, phone_number_id, plantilla_id, categoria) VALUES (?,?,?,?,?,?,?)',
      ['Remarketing aprobado: ' + sol.plantilla_nombre, '[Plantilla: ' + sol.plantilla_nombre + ']', contactos.length, 'enviando', sol.numero_id, sol.plantilla_id, plantilla.categoria],
      function (e) { e ? reject(e) : resolve(this.lastID); }));
    db.run("UPDATE remarketing_solicitudes SET estado='aprobada', aprobador_id=?, aprobador_nombre=?, difusion_id=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?", [req.user.id, req.user.nombre || '', difId, sol.id]);
    res.json({ ok: true, difusion_id: difId, total: contactos.length });
    ejecutarDifusion(difId, num, plantilla, contactos).catch(e => {
      console.error('[REMARKETING ' + sol.id + '] error:', e.message);
      db.run("UPDATE difusiones SET estado='error' WHERE id=?", [difId]);
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rechazar (con motivo opcional)
app.post('/api/remarketing/solicitud/:id/rechazar', auth, requireRole('supervisor', 'admin'), (req, res) => {
  const { motivo } = req.body;
  db.get('SELECT * FROM remarketing_solicitudes WHERE id=?', [req.params.id], (e, sol) => {
    if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (req.user.rol === 'supervisor' && sol.sucursal !== req.user.sucursal) return res.status(403).json({ error: 'No es de tu sucursal.' });
    if (sol.estado !== 'pendiente') return res.status(400).json({ error: 'La solicitud ya fue ' + sol.estado + '.' });
    db.run("UPDATE remarketing_solicitudes SET estado='rechazada', aprobador_id=?, aprobador_nombre=?, motivo=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?", [req.user.id, req.user.nombre || '', motivo || null, sol.id], (er) => res.json({ ok: !er }));
  });
});

app.get('/api/reportes', auth, (req, res) => {
  const dias = parseInt(req.query.dias) || 7;
  // Una recepcionista solo ve su numero; supervisor/admin pueden ver todo o filtrar.
  const numero_id = (req.user.rol === 'supervisor' || req.user.rol === 'admin') ? (req.query.numero_id || null) : req.user.numero_id;
  let where = 'WHERE timestamp >= datetime("now", "-" || ? || " days")';
  const params = ['entrante', 'saliente', dias];
  if (numero_id) { where += ' AND numero_id = ?'; params.push(numero_id); }
  db.all(`SELECT date(timestamp) as dia, numero_id, COUNT(*) as total, SUM(CASE WHEN direccion=? THEN 1 ELSE 0 END) as entrantes, SUM(CASE WHEN direccion=? THEN 1 ELSE 0 END) as salientes FROM mensajes ${where} GROUP BY dia, numero_id ORDER BY dia DESC`, params, (err, rows) => res.json(rows || []));
});

app.get('/api/reportes/etapas', auth, (req, res) => {
  const numero_id = (req.user.rol === 'supervisor' || req.user.rol === 'admin') ? (req.query.numero_id || null) : req.user.numero_id;
  const where = numero_id ? 'WHERE numero_id = ?' : '';
  const params = numero_id ? [numero_id] : [];
  db.all(`SELECT etapa, COUNT(*) as total FROM contactos ${where} GROUP BY etapa`, params, (err, rows) => res.json(rows || []));
});

// ==================== REPORTES FINANCIEROS ====================

// Tarifas y tipo de cambio
app.get('/api/tarifas', auth, requireRole('admin', 'supervisor'), async (req, res) => {
  const tarifas = await new Promise(r => db.all('SELECT pais, categoria, precio_usd, actualizado FROM tarifas_meta ORDER BY pais, categoria', [], (e, x) => r(x || [])));
  res.json({
    tarifas,
    tipo_cambio_usd_mxn: await configGet('tipo_cambio_usd_mxn'),
    sin_configurar: tarifas.filter(t => t.precio_usd == null).map(t => t.pais + '/' + t.categoria)
  });
});

app.put('/api/tarifas', auth, requireRole('admin'), async (req, res) => {
  const { tarifas, tipo_cambio_usd_mxn } = req.body;
  try {
    for (const t of (tarifas || [])) {
      await new Promise((resolve, reject) => db.run(
        `INSERT INTO tarifas_meta (pais, categoria, precio_usd, actualizado) VALUES (?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(pais, categoria) DO UPDATE SET precio_usd=excluded.precio_usd, actualizado=CURRENT_TIMESTAMP`,
        [t.pais, String(t.categoria).toUpperCase(), t.precio_usd === '' || t.precio_usd == null ? null : Number(t.precio_usd)],
        e => e ? reject(e) : resolve()));
    }
    if (tipo_cambio_usd_mxn !== undefined) {
      await new Promise(resolve => db.run(
        `INSERT INTO configuracion (clave, valor) VALUES ('tipo_cambio_usd_mxn', ?)
         ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor`, [String(tipo_cambio_usd_mxn)], () => resolve()));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Estimador: cuanto costaria una difusion ANTES de lanzarla
app.post('/api/difusion/estimar', auth, requireRole('admin', 'supervisor'), async (req, res) => {
  const { filtro_etapa, plantilla_id } = req.body;
  try {
    const plantilla = plantilla_id
      ? await new Promise(r => db.get('SELECT nombre, categoria, estado_meta FROM plantillas WHERE id=?', [plantilla_id], (e, x) => r(x)))
      : null;

    // Mismo alcance que el envio real: contactos del numero desde el que se lanzaria.
    const num = await resolverNumeroEnvio(req, req.body.numero_id);
    let q = 'SELECT DISTINCT telefono FROM contactos WHERE numero_id = ?';
    const p = [num ? num.phone_number_id : '__sin_numero__'];
    if (filtro_etapa) { q += ' AND etapa=?'; p.push(filtro_etapa); }
    const contactos = await new Promise(r => db.all(q, p, (e, x) => r(x || [])));

    const categoria = plantilla ? String(plantilla.categoria || '').toUpperCase() : 'MARKETING';
    let facturables = 0, total_usd = 0, sin_tarifa = 0;
    const porPais = {};
    for (const c of contactos) {
      const costo = await calcularCosto(c.telefono, categoria);
      porPais[costo.pais] = (porPais[costo.pais] || 0) + 1;
      if (costo.facturable) { facturables++; total_usd += costo.costo_usd; }
      if (costo.facturable && !costo.tarifa_configurada) sin_tarifa++;
    }

    const tc = parseFloat(await configGet('tipo_cambio_usd_mxn'));
    const avisos = [];
    if (plantilla && plantilla.estado_meta !== 'aprobada') avisos.push(`La plantilla "${plantilla.nombre}" no esta aprobada por Meta (${plantilla.estado_meta}); Meta rechazara el envio.`);
    if (sin_tarifa) avisos.push(`${sin_tarifa} envio(s) sin tarifa configurada: el costo real sera mayor que el estimado.`);
    if (!plantilla) avisos.push('Sin plantilla: la difusion manda texto y Meta solo lo permite dentro de la ventana de 24h.');

    res.json({
      ok: true,
      total_contactos: contactos.length,
      facturables,
      gratis: contactos.length - facturables,
      categoria,
      costo_usd: Number(total_usd.toFixed(4)),
      costo_mxn: tc ? Number((total_usd * tc).toFixed(2)) : null,
      tipo_cambio: tc || null,
      por_pais: porPais,
      avisos
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Gasto historico por numero / sucursal
app.get('/api/reportes/gasto', auth, requireRole('admin', 'supervisor'), async (req, res) => {
  const dias = parseInt(req.query.dias) || 30;
  try {
    const filas = await new Promise(r => db.all(
      `SELECT m.numero_id,
              COALESCE(s.nombre, n.sucursal, 'Sin sucursal') sucursal,
              COALESCE(m.categoria,'-') categoria,
              COUNT(*) enviados,
              SUM(m.facturable) facturables,
              ROUND(SUM(m.costo_usd), 4) costo_usd
       FROM mensajes m
       LEFT JOIN numeros n ON n.phone_number_id = m.numero_id
       LEFT JOIN sucursales s ON s.phone_number_id = m.numero_id
       WHERE m.direccion='saliente' AND m.timestamp >= datetime('now', '-' || ? || ' days')
       GROUP BY m.numero_id, categoria
       ORDER BY costo_usd DESC`, [dias], (e, x) => r(x || [])));

    const tc = parseFloat(await configGet('tipo_cambio_usd_mxn'));
    const total_usd = filas.reduce((a, f) => a + (f.costo_usd || 0), 0);
    res.json({
      ok: true,
      dias,
      filas: filas.map(f => ({ ...f, costo_mxn: tc ? Number((f.costo_usd * tc).toFixed(2)) : null })),
      total_usd: Number(total_usd.toFixed(4)),
      total_mxn: tc ? Number((total_usd * tc).toFixed(2)) : null,
      tipo_cambio: tc || null
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
      const contactoRow = await new Promise(r => db.get('SELECT nombre FROM contactos WHERE telefono=?', [telefono], (e, x) => r(x)));
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
            components: construirComponentesPlantilla(plantilla, { nombre: contactoRow && contactoRow.nombre, telefono })
          }
        },
        { headers: { Authorization: 'Bearer ' + num.token } }
      );
      // Registrar el coste: es lo unico que Meta factura de verdad
      const c = await calcularCosto(telefono, plantilla.categoria);
      db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion, tipo, categoria, facturable, costo_usd) VALUES (?,?,?,?,?,?,?,?)',
        [num.phone_number_id, telefono, '[Plantilla: ' + plantilla.nombre + ']', 'saliente', 'plantilla', c.categoria, c.facturable, c.costo_usd]);
      res.json({ ok: true, costo_usd: c.costo_usd, facturable: !!c.facturable });
    } catch(e) {
      const msg = e.response?.data?.error?.message || e.message;
      res.json({ ok: false, error: msg });
    }
  });
});


// ============================================
// MIDDLEWARE DE ROLES
// ============================================
// Declarada como funcion (no como const) a proposito: asi se eleva y puede usarse
// en rutas definidas mas arriba en el archivo. Con `const` fallaba al arrancar con
// "Cannot access 'requireRole' before initialization".
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autorizado' });
    if (!roles.includes(req.user.rol)) return res.status(403).json({ error: 'Sin permiso para esta acción' });
    next();
  };
}

// ============================================
// ENDPOINTS DE USUARIOS / ROLES
// ============================================

// Obtener todos los usuarios (admin/supervisor)

// Crear usuario nuevo (solo admin)

// Actualizar usuario (solo admin)

// Eliminar usuario (solo admin)

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
app.post('/api/citas', auth, requireRole('admin', 'supervisor', 'recepcionista'), async (req, res) => {
  const { contacto_id, tecnica_id, fecha, hora_inicio, hora_fin, servicio, notas, numero_id } = req.body;
  if (!fecha || !hora_inicio) return res.status(400).json({ error: 'Fecha y hora son requeridas' });
  // Si no la mandan, deducir la sucursal del numero de WhatsApp del chat
  const sucursal = req.body.sucursal || await resolverSucursal(numero_id, req.user.sucursal);
  db.run(
    `INSERT INTO citas (contacto_id, tecnica_id, recepcionista_id, numero_id, sucursal, fecha, hora_inicio, hora_fin, servicio, notas, estado)
     VALUES (?,?,?,?,?,?,?,?,?,?,'pendiente')`,
    [contacto_id || null, tecnica_id || null, req.user.id, numero_id || null, sucursal, fecha, hora_inicio, hora_fin || null, servicio || null, notas || null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const citaId = this.lastID;
      // Avisar por WhatsApp a la tecnica (no bloquea la respuesta ni la tumba si falla)
      if (tecnica_id) {
        notificarTecnicaCitaNueva(citaId).catch(e => console.error('[NOTIF] cita', citaId, e.message));
      }
      res.json({ ok: true, id: citaId, sucursal });
    }
  );
});

// Resuelve a que sucursal pertenece un numero de WhatsApp.
// La sucursal la define el numero al que escribio el cliente, no quien atiende.
function resolverSucursal(numero_id, fallback) {
  return new Promise((resolve) => {
    if (!numero_id) return resolve(fallback || null);
    db.get('SELECT nombre FROM sucursales WHERE phone_number_id=? AND activo=1', [numero_id], (e, suc) => {
      if (suc && suc.nombre) return resolve(suc.nombre);
      db.get('SELECT sucursal FROM numeros WHERE phone_number_id=?', [numero_id], (e2, num) => {
        resolve((num && num.sucursal) || fallback || null);
      });
    });
  });
}

// Contexto para agendar desde un chat: sucursal del chat y tecnicas de esa sucursal
app.get('/api/agenda/contexto', auth, async (req, res) => {
  const telefono = req.query.telefono;
  if (!telefono) return res.status(400).json({ error: 'Falta el telefono' });
  try {
    const contacto = await new Promise((resolve) =>
      db.get('SELECT id, nombre, numero_id FROM contactos WHERE telefono=?', [telefono], (e, row) => resolve(row)));
    const numero_id = (contacto && contacto.numero_id) || req.user.numero_id || null;
    const sucursal = await resolverSucursal(numero_id, req.user.sucursal);
    const tecnicas = await new Promise((resolve) =>
      db.all(`SELECT id, nombre FROM usuarios WHERE rol='tecnica' AND sucursal=? ORDER BY nombre`,
        [sucursal], (e, rows) => resolve(rows || [])));
    res.json({
      contacto_id: contacto ? contacto.id : null,
      contacto_nombre: contacto ? contacto.nombre : null,
      numero_id,
      sucursal,
      tecnicas
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      // Disparador de workflows: cita completada (base del seguimiento de retoque)
      if (estado === 'completada' && contacto_id) {
        dispararWorkflows('cita_completada', { contacto_id, servicio: servicio || null });
      }
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
    // Interpretamos fecha_inicio/fecha_fin como DIAS LOCALES de Mexico (-06:00), que
    // es la zona de los calendarios. Asi cubrimos el dia completo y no cortamos los
    // eventos de la tarde/noche del ultimo dia (que en UTC caerian fuera del rango).
    const timeMin = fecha_inicio ? new Date(fecha_inicio + 'T00:00:00-06:00').toISOString() : new Date().toISOString();
    const timeMax = fecha_fin
      ? new Date(fecha_fin + 'T23:59:59-06:00').toISOString()
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const pedir = async (accessToken) => {
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendar_id)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      return { status: response.status, data: await response.json() };
    };
    try {
      // 1) Preferimos la CUENTA DE SERVICIO (lee cualquier calendario compartido con
      //    ella, sin tokens por sucursal ni refresh). 2) Si no esta configurada, caemos
      //    al metodo viejo (OAuth con refresh) por compatibilidad.
      const saToken = await googleServiceToken();
      let r;
      if (saToken) {
        r = await pedir(saToken);
      } else if (config.access_token) {
        r = await pedir(config.access_token);
        const expirado = r.status === 401 || (r.data && r.data.error && r.data.error.code === 401);
        if (expirado && config.refresh_token) {
          const nuevo = await refrescarTokenGoogle(config.refresh_token);
          if (nuevo) { db.run('UPDATE google_calendar_config SET access_token=? WHERE id=?', [nuevo, config.id]); r = await pedir(nuevo); }
        }
      } else {
        return res.json({ eventos: [], configurado: true, error: 'Falta la cuenta de servicio de Google en el servidor (GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY).' });
      }
      if (r.data && r.data.error) return res.json({ eventos: [], error: r.data.error.message, configurado: true });
      res.json({ eventos: r.data.items || [], configurado: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Token de la CUENTA DE SERVICIO de Google (JWT firmado -> access token, cacheado
// ~55min). Requiere GOOGLE_SA_EMAIL y GOOGLE_SA_PRIVATE_KEY en el .env. Lee
// calendarios compartidos con esa cuenta de servicio (solo lectura).
// Credenciales de la cuenta de servicio: desde un archivo JSON (mas facil) o desde
// dos variables de entorno. El archivo es lo recomendado: es el JSON que descargas
// de Google tal cual, sin pelearte con los saltos de linea de la llave.
function _gcalSACreds() {
  if (process.env.GOOGLE_SA_KEY_FILE) {
    try { const j = JSON.parse(require('fs').readFileSync(process.env.GOOGLE_SA_KEY_FILE, 'utf8')); return { email: j.client_email, key: j.private_key }; }
    catch (e) { console.error('[GCAL] no se pudo leer GOOGLE_SA_KEY_FILE:', e.message); return {}; }
  }
  return { email: process.env.GOOGLE_SA_EMAIL, key: process.env.GOOGLE_SA_PRIVATE_KEY };
}
let _gcalSA = { token: null, exp: 0 };
async function googleServiceToken() {
  if (_gcalSA.token && Date.now() < _gcalSA.exp) return _gcalSA.token;
  const cr = _gcalSACreds();
  const email = cr.email;
  let key = cr.key;
  if (!email || !key) { if (!_gcalSA.aviso) { console.warn('[GCAL] falta la cuenta de servicio (GOOGLE_SA_KEY_FILE o GOOGLE_SA_EMAIL/PRIVATE_KEY)'); _gcalSA.aviso = true; } return null; }
  key = key.replace(/\\n/g, '\n'); // por si vienen escapados en el .env
  try {
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      { iss: email, scope: 'https://www.googleapis.com/auth/calendar.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
      key, { algorithm: 'RS256' });
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    });
    const d = await resp.json();
    if (!d.access_token) { console.error('[GCAL] service token:', JSON.stringify(d).slice(0, 200)); return null; }
    _gcalSA = { token: d.access_token, exp: Date.now() + ((d.expires_in || 3600) - 60) * 1000 };
    return d.access_token;
  } catch (e) { console.error('[GCAL] error firmando/obteniendo service token:', e.message); return null; }
}

// (Legado) Refresca un access token OAuth con su refresh_token. Solo se usa si
// una sucursal quedo configurada con el metodo viejo y no hay cuenta de servicio.
async function refrescarTokenGoogle(refreshToken) {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refreshToken, grant_type: 'refresh_token' })
    });
    const d = await resp.json();
    return d.access_token || null;
  } catch (e) { console.error('[GCAL] error al refrescar:', e.message); return null; }
}

// Correo de la cuenta de servicio (con el que hay que compartir los calendarios)
app.get('/api/google-calendar/service-account', auth, requireRole('admin', 'supervisor'), (req, res) => {
  const cr = _gcalSACreds();
  res.json({ email: cr.email || null, configurado: !!(cr.email && cr.key) });
});

// Lista de configuraciones (para la pantalla de admin)
app.get('/api/google-calendar/config', auth, requireRole('admin', 'supervisor'), (req, res) => {
  db.all('SELECT sucursal, calendar_id, activo FROM google_calendar_config ORDER BY sucursal', [], (e, rows) => res.json(rows || []));
});

// Guardar/actualizar el calendario de una sucursal. Con cuenta de servicio solo
// hace falta el ID del calendario (los tokens son opcionales, solo para el metodo viejo).
app.post('/api/google-calendar/config', auth, requireRole('admin'), (req, res) => {
  const { sucursal, calendar_id, access_token, refresh_token, activo } = req.body;
  if (!sucursal || !calendar_id) return res.status(400).json({ error: 'Sucursal y ID de calendario son obligatorios' });
  db.run(
    `INSERT INTO google_calendar_config (sucursal, calendar_id, access_token, refresh_token, activo)
     VALUES (?,?,?,?,?)
     ON CONFLICT(sucursal) DO UPDATE SET calendar_id=excluded.calendar_id, activo=excluded.activo`,
    [sucursal, calendar_id, access_token || null, refresh_token || null, activo === 0 ? 0 : 1],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

// ── ASISTENCIAS (palomeo Vino / No vino) ───────────────────────────────────
// Base del sistema de cortes del recepcionista. La tecnica marca en "Mis citas
// de hoy" si la clienta asistio. Como los eventos de Google son de solo lectura,
// el estado se guarda aqui, ligado al id del evento (event_id).
app.get('/api/asistencias', auth, (req, res) => {
  const sucursal = (req.user.rol === 'tecnica' || req.user.rol === 'recepcionista')
    ? req.user.sucursal : req.query.sucursal;
  if (!sucursal) return res.status(400).json({ error: 'Sucursal requerida' });
  const cond = ['sucursal = ?']; const params = [sucursal];
  if (req.query.fecha) { cond.push('fecha = ?'); params.push(req.query.fecha); }
  db.all(`SELECT event_id, fecha, cliente, servicio, hora, estado, monto, metodo_pago, tecnica_id FROM asistencias WHERE ${cond.join(' AND ')}`,
    params, (e, rows) => e ? res.status(500).json({ error: e.message }) : res.json(rows || []));
});

app.post('/api/asistencias', auth, requireRole('tecnica', 'recepcionista', 'admin', 'supervisor'), (req, res) => {
  const { event_id, fecha, cliente, servicio, hora, estado } = req.body;
  if (!event_id) return res.status(400).json({ error: 'event_id requerido' });
  const sucursal = (req.user.rol === 'tecnica' || req.user.rol === 'recepcionista')
    ? req.user.sucursal : (req.body.sucursal || null);
  // Estado vacio = des-marcar (borrar la fila)
  if (!estado) {
    return db.run('DELETE FROM asistencias WHERE event_id = ?', [event_id],
      err => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true, estado: null }));
  }
  if (!['asistio', 'no_asistio'].includes(estado)) return res.status(400).json({ error: 'Estado invalido' });
  const tecnicaId = req.user.rol === 'tecnica' ? req.user.id : null;
  db.run(
    `INSERT INTO asistencias (event_id, sucursal, fecha, cliente, servicio, hora, estado, tecnica_id, marcado_por, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(event_id) DO UPDATE SET estado=excluded.estado, fecha=excluded.fecha, cliente=excluded.cliente,
       servicio=excluded.servicio, hora=excluded.hora, marcado_por=excluded.marcado_por, updated_at=CURRENT_TIMESTAMP`,
    [event_id, sucursal, fecha || null, cliente || null, servicio || null, hora || null, estado, tecnicaId, req.user.id],
    err => err ? res.status(500).json({ error: err.message }) : res.json({ ok: true, estado })
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
    // Solo anteponer 52 a numeros locales MX de 10 digitos. Si ya trae codigo de
    // pais (11+ digitos, p.ej. US con 1) se respeta tal cual.
    const telefonoFinal = telefonoLimpio.length === 10 ? '52' + telefonoLimpio : telefonoLimpio;
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
// MOTOR DE WORKFLOWS
// ============================================
// Un workflow se dispara con un evento (cita completada, etiqueta, cambio de
// etapa) e inscribe al contacto. Cada inscripcion avanza por los pasos: esperar,
// condicion, etiquetar, cambiar etapa o enviar plantilla. El programador corre
// cada minuto y solo toca las inscripciones cuya espera ya vencio.
//
// Solo actuan los workflows con activo=1: envian mensajes reales y cuestan dinero.

const wfGet = (q, p = []) => new Promise(r => db.get(q, p, (e, x) => r(x)));
const wfAll = (q, p = []) => new Promise(r => db.all(q, p, (e, x) => r(x || [])));
const wfRun = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));

function wfLog(insc, paso, accion, resultado) {
  db.run('INSERT INTO workflow_log (inscripcion_id, workflow_id, telefono, paso, accion, resultado) VALUES (?,?,?,?,?,?)',
    [insc.id, insc.workflow_id, insc.telefono, paso, accion, resultado]);
}

// Busca o crea la etiqueta por nombre y se la pone al contacto
async function wfEtiquetar(contacto_id, nombreEtiqueta, quitar) {
  let et = await wfGet('SELECT id FROM etiquetas WHERE nombre=?', [nombreEtiqueta]);
  if (!et) {
    if (quitar) return 'la etiqueta no existe';
    const r = await wfRun('INSERT INTO etiquetas (nombre, color) VALUES (?,?)', [nombreEtiqueta, '#075e54']);
    et = { id: r.lastID };
  }
  if (quitar) {
    await wfRun('DELETE FROM contacto_etiquetas WHERE contacto_id=? AND etiqueta_id=?', [contacto_id, et.id]);
    return 'etiqueta quitada: ' + nombreEtiqueta;
  }
  await wfRun('INSERT OR IGNORE INTO contacto_etiquetas (contacto_id, etiqueta_id) VALUES (?,?)', [contacto_id, et.id]);
  return 'etiqueta puesta: ' + nombreEtiqueta;
}

// Evalua una condicion sobre el contacto. Devuelve true si SE CUMPLE.
async function wfCondicion(insc, cfg) {
  const cid = insc.contacto_id;
  switch (cfg.tipo) {
    case 'tiene_etiqueta': {
      const r = await wfGet(`SELECT 1 x FROM contacto_etiquetas ce JOIN etiquetas e ON e.id=ce.etiqueta_id
                             WHERE ce.contacto_id=? AND e.nombre=?`, [cid, cfg.valor]);
      return !!r;
    }
    case 'tiene_alguna_etiqueta': {
      // Verdadero si el contacto tiene AL MENOS UNA de las etiquetas de la lista.
      const lista = Array.isArray(cfg.valor) ? cfg.valor
        : String(cfg.valor || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!lista.length) return false;
      const ph = lista.map(() => '?').join(',');
      const r = await wfGet(`SELECT 1 x FROM contacto_etiquetas ce JOIN etiquetas e ON e.id=ce.etiqueta_id
                             WHERE ce.contacto_id=? AND e.nombre IN (${ph})`, [cid, ...lista]);
      return !!r;
    }
    case 'etapa_es': {
      const r = await wfGet('SELECT etapa FROM contactos WHERE id=?', [cid]);
      return !!r && r.etapa === cfg.valor;
    }
    case 'tiene_cita_futura': {
      const r = await wfGet(`SELECT 1 x FROM citas WHERE contacto_id=? AND estado!='cancelada'
                             AND date(fecha) >= date('now')`, [cid]);
      return !!r;
    }
    case 'respondio': {
      // ¿escribio desde que entro al workflow?
      const r = await wfGet(`SELECT 1 x FROM mensajes WHERE contacto=? AND direccion='entrante'
                             AND timestamp > ?`, [insc.telefono, insc.created_at]);
      return !!r;
    }
    default:
      return false;
  }
}

// Evalua la regla de una rama. La rama "por defecto" (siempre/ninguna) siempre entra.
async function wfReglaRama(insc, regla) {
  regla = regla || {};
  if (regla.tipo === 'siempre' || regla.tipo === 'ninguna' || regla.es_default) return true;
  let ok = await wfCondicion(insc, regla);
  if (regla.negar) ok = !ok;
  return ok;
}

// Resuelve un camino (ruta) dentro del arbol de pasos.
// ruta alterna [idxPaso, idxRama, idxPaso, idxRama, ..., idxPaso].
// Devuelve { lista, idx, paso } donde lista es el array que contiene al paso.
function wfResolver(pasos, ruta) {
  let lista = pasos;
  for (let k = 0; k < ruta.length; k += 2) {
    const idx = ruta[k];
    if (k + 1 < ruta.length) {
      const paso = lista[idx];
      const b = ruta[k + 1];
      const rama = paso && paso.config && paso.config.ramas && paso.config.ramas[b];
      if (!rama) return { lista: [], idx: 0, paso: undefined };
      lista = rama.pasos || [];
    } else {
      return { lista, idx, paso: lista[idx] };
    }
  }
  return { lista, idx: 0, paso: lista[0] };
}

// Envia una plantilla a la inscripcion. Devuelve true si se envio, false si no.
// Devuelve el id del mensaje (wamid) si se envio, o null si no. El wamid sirve
// para ligar el estado de entrega (para la rama "no entregado").
async function wfEnviarPlantillaPaso(insc, plantilla_id, accion) {
  const p = await wfGet('SELECT * FROM plantillas WHERE id=?', [plantilla_id]);
  if (!p) { wfLog(insc, insc.paso_actual, accion, 'ERROR: plantilla no encontrada'); return null; }
  if (p.estado_meta !== 'aprobada') { wfLog(insc, insc.paso_actual, accion, `ERROR: plantilla no aprobada (${p.estado_meta})`); return null; }
  const contacto = await wfGet('SELECT numero_id, nombre FROM contactos WHERE id=?', [insc.contacto_id]);
  const num = await wfGet(`SELECT * FROM numeros WHERE phone_number_id=? AND token IS NOT NULL AND token!=''`,
    [contacto && contacto.numero_id]);
  if (!num) { wfLog(insc, insc.paso_actual, accion, 'ERROR: sin número con token para este contacto'); return null; }
  try {
    const resp = await axios.post(`https://graph.facebook.com/v18.0/${num.phone_number_id}/messages`,
      { messaging_product: 'whatsapp', to: insc.telefono, type: 'template',
        template: { name: p.nombre.toLowerCase().replace(/\s+/g, '_'), language: { code: p.idioma || 'es' },
          components: construirComponentesPlantilla(p, { nombre: contacto && contacto.nombre, telefono: insc.telefono }) } },
      { headers: { Authorization: 'Bearer ' + num.token } });
    const wamid = resp.data?.messages?.[0]?.id || null;
    const c = await calcularCosto(insc.telefono, p.categoria);
    db.run('INSERT INTO mensajes (numero_id, contacto, mensaje, direccion, tipo, categoria, facturable, costo_usd) VALUES (?,?,?,?,?,?,?,?)',
      [num.phone_number_id, insc.telefono, '[Workflow: ' + p.nombre + ']', 'saliente', 'plantilla', c.categoria, c.facturable, c.costo_usd]);
    wfLog(insc, insc.paso_actual, accion, `enviada ${p.nombre} ($${c.costo_usd})`);
    return wamid || 'ok'; // 'ok' si Meta no devolvio id, para que igual se espere
  } catch (e) {
    wfLog(insc, insc.paso_actual, accion, 'ERROR: ' + (e.response?.data?.error?.message || e.message));
    return null;
  }
}

// Ejecuta un paso. Devuelve { esperar_ms } para esperar, { salir, motivo } para
// sacar al contacto, { entrar_rama } para bajar a una rama, { esperar_respuesta }
// para aguardar la respuesta del cliente, o null para continuar.
async function wfEjecutarPaso(insc, paso) {
  const cfg = paso.config || {};
  switch (paso.tipo) {
    case 'esperar': {
      const ms = ((cfg.dias || 0) * 24 * 60 + (cfg.horas || 0) * 60 + (cfg.minutos || 0)) * 60 * 1000;
      // Una espera de 0 no debe ceder al programador: seguiria parada hasta la
      // siguiente vuelta del cron sin motivo. Se continua en el momento.
      if (ms <= 0) return null;
      wfLog(insc, insc.paso_actual, 'esperar', `${cfg.dias || 0}d ${cfg.horas || 0}h`);
      return { esperar_ms: ms };
    }
    case 'condicion': {
      const cumple = await wfCondicion(insc, cfg);
      // si_cumple: 'salir' saca al contacto; 'continuar' lo deja seguir
      const accion = cumple ? (cfg.si_cumple || 'continuar') : (cfg.si_no_cumple || 'continuar');
      wfLog(insc, insc.paso_actual, 'condicion', `${cfg.tipo}=${cumple} -> ${accion}`);
      if (accion === 'salir') return { salir: true, motivo: `condición ${cfg.tipo}` };
      return null;
    }
    case 'ramas': {
      // Elige la primera rama cuya regla se cumple; la ultima suele ser "por defecto".
      const ramas = cfg.ramas || [];
      for (let b = 0; b < ramas.length; b++) {
        if (await wfReglaRama(insc, ramas[b].regla)) {
          wfLog(insc, insc.paso_actual, 'ramas', `entra a "${ramas[b].nombre || ('rama ' + b)}"`);
          return { entrar_rama: b };
        }
      }
      // Ninguna rama coincidio y no hay "por defecto" -> el contacto sale
      wfLog(insc, insc.paso_actual, 'ramas', 'ninguna rama coincidió → sale');
      return { salir: true, motivo: 'ninguna rama coincidió' };
    }
    case 'agregar_etiqueta': {
      const r = await wfEtiquetar(insc.contacto_id, cfg.etiqueta, false);
      wfLog(insc, insc.paso_actual, 'agregar_etiqueta', r);
      return null;
    }
    case 'quitar_etiqueta': {
      const r = await wfEtiquetar(insc.contacto_id, cfg.etiqueta, true);
      wfLog(insc, insc.paso_actual, 'quitar_etiqueta', r);
      return null;
    }
    case 'cambiar_etapa': {
      await wfRun('UPDATE contactos SET etapa=? WHERE id=?', [cfg.etapa, insc.contacto_id]);
      wfLog(insc, insc.paso_actual, 'cambiar_etapa', cfg.etapa);
      return null;
    }
    case 'enviar_plantilla': {
      await wfEnviarPlantillaPaso(insc, cfg.plantilla_id, 'enviar_plantilla');
      return null;
    }
    case 'enviar_esperar': {
      // Envia la plantilla (con botones) y ESPERA la respuesta del cliente.
      // El ramificado por boton lo hace el webhook; el Time Out, el programador.
      const wamid = await wfEnviarPlantillaPaso(insc, cfg.plantilla_id, 'enviar_esperar');
      if (!wamid) return null; // si no se pudo enviar, no tiene sentido esperar: continuar
      const horas = cfg.timeout_horas != null ? cfg.timeout_horas : 24;
      return { esperar_respuesta: true, timeout_ms: horas * 3600 * 1000, wamid: wamid };
    }
    default:
      wfLog(insc, insc.paso_actual, 'desconocido', 'tipo de paso no reconocido: ' + paso.tipo);
      return null;
  }
}

// Avanza una inscripcion por el arbol hasta que toque esperar, salga o termine.
// La posicion se guarda como `ruta` (soporta ramas anidadas).
async function wfAvanzar(insc) {
  const wf = await wfGet('SELECT * FROM workflows WHERE id=?', [insc.workflow_id]);
  if (!wf || !wf.activo) return; // si lo desactivaron a mitad, se queda parado
  let pasos = [];
  try { pasos = JSON.parse(wf.pasos || '[]'); } catch (e) { return; }

  // Recuperar la ruta; compat con inscripciones viejas (solo tenian paso_actual)
  let ruta;
  try { ruta = JSON.parse(insc.ruta || 'null'); } catch (e) { ruta = null; }
  if (!Array.isArray(ruta) || !ruta.length) ruta = [insc.paso_actual || 0];

  const guardar = (campos, params) =>
    wfRun(`UPDATE workflow_inscripciones SET ${campos}, ruta=?, paso_actual=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      params.concat([JSON.stringify(ruta), ruta[ruta.length - 1] || 0, insc.id]));

  // Tope alto por vuelta: evita ciclos en workflows mal armados
  for (let n = 0; n < 100; n++) {
    const { lista, idx, paso } = wfResolver(pasos, ruta);
    if (!paso || idx >= lista.length) {
      // Fin de la lista (o de una rama): las ramas son terminales -> completado
      await guardar(`estado='completado'`, []);
      return;
    }
    insc.paso_actual = ruta[ruta.length - 1];
    const r = await wfEjecutarPaso(insc, paso);
    if (r && r.salir) {
      await guardar(`estado='salido', motivo_salida=?`, [r.motivo]);
      return;
    }
    if (r && r.esperar_ms != null) {
      const seg = Math.round(r.esperar_ms / 1000);
      ruta = ruta.slice(); ruta[ruta.length - 1] = idx + 1; // siguiente en la misma lista
      await guardar(`proximo_en=datetime('now','+' || ? || ' seconds')`, [seg]);
      return;
    }
    if (r && r.esperar_respuesta) {
      // Queda esperando la respuesta del cliente. La ruta apunta a ESTE paso;
      // el webhook la baja a la rama del boton (o a "no entregado"), y proximo_en marca el Time Out.
      const seg = Math.round((r.timeout_ms || 0) / 1000);
      await guardar(`estado='esperando', mensaje_wamid=?, proximo_en=datetime('now','+' || ? || ' seconds')`, [r.wamid || null, seg]);
      return;
    }
    if (r && r.entrar_rama != null) {
      ruta = ruta.concat([r.entrar_rama, 0]); // bajar a la rama elegida
      continue;
    }
    // continuar: siguiente paso en la misma lista
    ruta = ruta.slice(); ruta[ruta.length - 1] = idx + 1;
  }
  await guardar(`estado='error', motivo_salida='demasiados pasos sin espera'`, []);
}

// Inscribe contactos cuando ocurre un evento
async function dispararWorkflows(tipo, datos) {
  try {
    const wfs = await wfAll('SELECT * FROM workflows WHERE activo=1 AND trigger_tipo=?', [tipo]);
    for (const wf of wfs) {
      let cfg = {};
      try { cfg = JSON.parse(wf.trigger_config || '{}'); } catch (e) {}
      // Filtros del disparador
      if (cfg.etiqueta && cfg.etiqueta !== datos.etiqueta) continue;
      if (cfg.etapa && cfg.etapa !== datos.etapa) continue;

      const contacto = await wfGet('SELECT id, telefono, sucursal, numero_id FROM contactos WHERE id=?', [datos.contacto_id]);
      if (!contacto) continue;
      // Filtro por sucursal: un workflow acotado a una sucursal solo inscribe
      // contactos de ESA sucursal. Antes `datos.sucursal` nunca llegaba y el
      // filtro no actuaba, inscribiendo contactos de otras sucursales.
      if (wf.sucursal) {
        let sucContacto = contacto.sucursal;
        if (!sucContacto && contacto.numero_id) {
          const nr = await wfGet('SELECT sucursal FROM numeros WHERE phone_number_id=?', [contacto.numero_id]);
          sucContacto = nr && nr.sucursal;
        }
        if (sucContacto !== wf.sucursal) continue;
      }
      // No inscribir dos veces al mismo contacto en el mismo workflow.
      // Ademas se respeta un enfriamiento: aunque haya salido o terminado, no se
      // vuelve a inscribir enseguida. Sin esto, un disparador que se repite (doble
      // clic, o marcar la misma cita completada dos veces) mete al contacto varias
      // veces y le llegan mensajes repetidos.
      const horasEnfriamiento = cfg.enfriamiento_horas != null ? cfg.enfriamiento_horas : 24;
      const ya = await wfGet(
        `SELECT id, estado FROM workflow_inscripciones
         WHERE workflow_id=? AND contacto_id=?
           AND (estado='activo' OR created_at > datetime('now','-' || ? || ' hours'))
         LIMIT 1`,
        [wf.id, contacto.id, horasEnfriamiento]);
      if (ya) continue;
      const r = await wfRun('INSERT INTO workflow_inscripciones (workflow_id, contacto_id, telefono) VALUES (?,?,?)',
        [wf.id, contacto.id, contacto.telefono]);
      console.log(`[WF] inscrito ${contacto.telefono} en "${wf.nombre}" (${tipo})`);
      const insc = await wfGet('SELECT * FROM workflow_inscripciones WHERE id=?', [r.lastID]);
      await wfAvanzar(insc);
    }
  } catch (e) {
    console.error('[WF] error disparando', tipo, e.message);
  }
}

// Normaliza texto para comparar botones (sin mayus/acentos/espacios de sobra)
function wfNorm(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Enruta a la inscripcion que espera respuesta, segun el boton/palabra que llego.
// Devuelve true si enruto a una rama.
async function wfRutearRespuesta(telefono, texto) {
  const insc = await wfGet(`SELECT * FROM workflow_inscripciones WHERE telefono=? AND estado='esperando' ORDER BY id DESC LIMIT 1`, [telefono]);
  if (!insc) return false;
  const wf = await wfGet('SELECT pasos, activo FROM workflows WHERE id=?', [insc.workflow_id]);
  if (!wf) return false;
  let pasos = []; try { pasos = JSON.parse(wf.pasos || '[]'); } catch (e) { return false; }
  let ruta; try { ruta = JSON.parse(insc.ruta || '[0]'); } catch (e) { return false; }
  const { paso } = wfResolver(pasos, ruta);
  if (!paso || paso.tipo !== 'enviar_esperar') return false;
  const ramas = (paso.config && paso.config.ramas) || [];
  // Buscar la rama cuyo boton coincide con lo que escribio/toco el cliente
  let b = ramas.findIndex(r => r.boton && wfNorm(r.boton) === wfNorm(texto));
  if (b < 0) return false; // no coincide con ningun boton -> sigue esperando
  const nueva = ruta.concat([b, 0]);
  await wfRun(`UPDATE workflow_inscripciones SET estado='activo', ruta=?, proximo_en=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [JSON.stringify(nueva), insc.id]);
  const fresca = await wfGet('SELECT * FROM workflow_inscripciones WHERE id=?', [insc.id]);
  wfLog(fresca, 0, 'respuesta', `botón "${texto}" → rama "${ramas[b].nombre || ramas[b].boton}"`);
  await wfAvanzar(fresca);
  return true;
}

// Mensaje no entregado (status failed): enruta a la rama __undelivered__ del paso.
async function wfRutearUndelivered(wamid) {
  if (!wamid) return;
  const insc = await wfGet(`SELECT * FROM workflow_inscripciones WHERE mensaje_wamid=? AND estado='esperando' LIMIT 1`, [wamid]);
  if (!insc) return;
  const wf = await wfGet('SELECT pasos FROM workflows WHERE id=?', [insc.workflow_id]);
  let pasos = []; try { pasos = JSON.parse((wf && wf.pasos) || '[]'); } catch (e) { return; }
  let ruta; try { ruta = JSON.parse(insc.ruta || '[0]'); } catch (e) { return; }
  const { paso } = wfResolver(pasos, ruta);
  const ramas = (paso && paso.config && paso.config.ramas) || [];
  const b = ramas.findIndex(r => r.boton === '__undelivered__');
  if (b < 0) { // sin rama de no-entregado: se queda esperando (llegara el Time Out)
    wfLog(insc, 0, 'undelivered', 'no entregado, pero el flujo no tiene rama "No entregado"');
    return;
  }
  const nueva = ruta.concat([b, 0]);
  await wfRun(`UPDATE workflow_inscripciones SET estado='activo', ruta=?, proximo_en=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [JSON.stringify(nueva), insc.id]);
  const fresca = await wfGet('SELECT * FROM workflow_inscripciones WHERE id=?', [insc.id]);
  wfLog(fresca, 0, 'undelivered', 'mensaje no entregado → rama "No entregado"');
  await wfAvanzar(fresca);
}

// Time Out: una espera de respuesta que vencio. Enruta a la rama __timeout__ si existe.
async function wfTimeout(insc) {
  const wf = await wfGet('SELECT pasos FROM workflows WHERE id=?', [insc.workflow_id]);
  let pasos = []; try { pasos = JSON.parse((wf && wf.pasos) || '[]'); } catch (e) {}
  let ruta; try { ruta = JSON.parse(insc.ruta || '[0]'); } catch (e) { ruta = [0]; }
  const { paso } = wfResolver(pasos, ruta);
  const ramas = (paso && paso.config && paso.config.ramas) || [];
  const b = ramas.findIndex(r => r.boton === '__timeout__');
  if (b >= 0) {
    const nueva = ruta.concat([b, 0]);
    await wfRun(`UPDATE workflow_inscripciones SET estado='activo', ruta=?, proximo_en=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [JSON.stringify(nueva), insc.id]);
    const fresca = await wfGet('SELECT * FROM workflow_inscripciones WHERE id=?', [insc.id]);
    wfLog(fresca, 0, 'timeout', 'no respondió a tiempo → rama Time Out');
    await wfAvanzar(fresca);
  } else {
    // Sin rama de Time Out: el contacto simplemente termina
    await wfRun(`UPDATE workflow_inscripciones SET estado='completado', motivo_salida='sin respuesta (Time Out)', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [insc.id]);
    wfLog(insc, 0, 'timeout', 'no respondió y no hay rama Time Out → termina');
  }
}

// Programador: cada minuto avanza esperas vencidas y Time Outs
let wfCorriendo = false;
async function wfProcesarPendientes() {
  if (wfCorriendo) return; // evita solapamiento si una vuelta tarda
  wfCorriendo = true;
  try {
    const pendientes = await wfAll(`SELECT * FROM workflow_inscripciones
                                    WHERE estado='activo' AND proximo_en <= datetime('now') LIMIT 200`);
    for (const insc of pendientes) await wfAvanzar(insc);
    // Time Outs: esperas de respuesta que ya vencieron
    const vencidas = await wfAll(`SELECT * FROM workflow_inscripciones
                                  WHERE estado='esperando' AND proximo_en <= datetime('now') LIMIT 200`);
    for (const insc of vencidas) await wfTimeout(insc);
    if (pendientes.length || vencidas.length) console.log(`[WF] ${pendientes.length} avanzadas, ${vencidas.length} timeouts`);
  } catch (e) {
    console.error('[WF] error en el programador:', e.message);
  } finally {
    wfCorriendo = false;
  }
}
cronJobs.schedule('* * * * *', wfProcesarPendientes, { timezone: 'America/Mexico_City' });

// ===== API DE WORKFLOWS =====
app.get('/api/workflows', auth, requireRole('admin', 'supervisor'), async (req, res) => {
  const wfs = await wfAll('SELECT * FROM workflows ORDER BY created_at DESC');
  for (const w of wfs) {
    const s = await wfGet(`SELECT
        SUM(estado='activo') activos, SUM(estado='completado') completados,
        SUM(estado='salido') salidos, COUNT(*) total
      FROM workflow_inscripciones WHERE workflow_id=?`, [w.id]);
    w.stats = s || {};
    try { w.pasos = JSON.parse(w.pasos || '[]'); } catch (e) { w.pasos = []; }
    try { w.trigger_config = JSON.parse(w.trigger_config || '{}'); } catch (e) { w.trigger_config = {}; }
  }
  res.json(wfs);
});

app.post('/api/workflows', auth, requireRole('admin', 'supervisor'), async (req, res) => {
  const { nombre, trigger_tipo, trigger_config, pasos, sucursal } = req.body;
  if (!nombre || !trigger_tipo) return res.status(400).json({ error: 'Nombre y disparador son obligatorios' });
  try {
    const r = await wfRun('INSERT INTO workflows (nombre, trigger_tipo, trigger_config, pasos, sucursal, activo) VALUES (?,?,?,?,?,0)',
      [nombre, trigger_tipo, JSON.stringify(trigger_config || {}), JSON.stringify(pasos || []), sucursal || null]);
    // Nace desactivado a proposito
    res.json({ ok: true, id: r.lastID, activo: 0, aviso: 'Creado desactivado. Actívalo cuando lo hayas revisado.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/workflows/:id', auth, requireRole('admin', 'supervisor'), async (req, res) => {
  const { nombre, trigger_tipo, trigger_config, pasos, sucursal, activo } = req.body;
  try {
    await wfRun(`UPDATE workflows SET nombre=?, trigger_tipo=?, trigger_config=?, pasos=?, sucursal=?, activo=? WHERE id=?`,
      [nombre, trigger_tipo, JSON.stringify(trigger_config || {}), JSON.stringify(pasos || []), sucursal || null, activo ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/workflows/:id', auth, requireRole('admin'), async (req, res) => {
  await wfRun('DELETE FROM workflows WHERE id=?', [req.params.id]);
  await wfRun('DELETE FROM workflow_inscripciones WHERE workflow_id=?', [req.params.id]);
  res.json({ ok: true });
});

// Inscripciones y registro de un workflow (para ver que hizo con cada contacto)
app.get('/api/workflows/:id/inscripciones', auth, requireRole('admin', 'supervisor'), async (req, res) => {
  const insc = await wfAll(`SELECT i.*, c.nombre contacto_nombre FROM workflow_inscripciones i
                            LEFT JOIN contactos c ON c.id=i.contacto_id
                            WHERE i.workflow_id=? ORDER BY i.updated_at DESC LIMIT 100`, [req.params.id]);
  const log = await wfAll('SELECT * FROM workflow_log WHERE workflow_id=? ORDER BY created_at DESC LIMIT 100', [req.params.id]);
  res.json({ inscripciones: insc, log });
});

// Simulacion: a cuantos contactos afectaria hoy, sin enviar nada
app.post('/api/workflows/:id/simular', auth, requireRole('admin', 'supervisor'), async (req, res) => {
  const wf = await wfGet('SELECT * FROM workflows WHERE id=?', [req.params.id]);
  if (!wf) return res.status(404).json({ error: 'No encontrado' });
  let pasos = [], envios = 0;
  try { pasos = JSON.parse(wf.pasos || '[]'); } catch (e) {}
  for (const p of pasos) if (p.tipo === 'enviar_plantilla') envios++;
  const activos = await wfGet(`SELECT COUNT(*) n FROM workflow_inscripciones WHERE workflow_id=? AND estado='activo'`, [req.params.id]);
  res.json({
    ok: true, nombre: wf.nombre, activo: !!wf.activo,
    disparador: wf.trigger_tipo, pasos: pasos.length,
    envios_por_contacto: envios,
    inscripciones_activas: activos ? activos.n : 0,
    aviso: envios ? `Cada contacto recibirá ${envios} plantilla(s). Con muchos contactos esto cuesta dinero.` : 'Este workflow no envía mensajes.'
  });
});

// HOST permite que staging escuche solo en local (HOST=127.0.0.1) y no quede expuesto a internet.
// Sin HOST definido se comporta como siempre (0.0.0.0), para no cambiar produccion.
const HOST = process.env.HOST || '0.0.0.0';
app.listen(process.env.PORT, HOST, () => console.log(`Sistema WhatsApp corriendo en ${HOST}:${process.env.PORT}`));
