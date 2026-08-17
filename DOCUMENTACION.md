# BunnyRabbit — Documentación del proyecto

CRM de WhatsApp (**bunnyrabbit.lat**) que reemplaza a GoHighLevel para estudios de cejas
(hasta 23 sucursales). Centraliza los chats de WhatsApp, el CRM de contactos, las plantillas,
el remarketing, la agenda por sucursal y las métricas — sobre un número de WhatsApp en modo
**coexistencia** (funciona a la vez en el celular y en la plataforma).

> Documento técnico de referencia. Ver también `PENDIENTES.md` (estado de tareas) y `CLAUDE.md`
> (instrucciones de trabajo). Última actualización: ago 2026.

---

## 1. Stack y arquitectura

- **Backend:** Node.js 22 + Express (un solo archivo, `index.js`, ~3,300 líneas).
- **Base de datos:** SQLite (`whatsapp.db`) — sin servidor, un archivo.
- **Frontend:** 4 páginas HTML estáticas (sin framework) servidas desde `public/`.
- **Proceso:** PM2 (`bunnyrabbit`), nginx enfrente.
- **Auth:** JWT (24 h) + bcrypt para contraseñas.
- **Dependencias:** `express, sqlite3, jsonwebtoken, bcryptjs, multer, node-cron, axios, cors, csv-parse, dotenv`.
- **Integraciones externas:** WhatsApp Cloud API (Meta), Google Calendar (cuenta de servicio), Facebook CAPI.

```
Navegador ──HTTPS──> nginx ──> Express (:3000) ──> SQLite (whatsapp.db)
                                     │
                                     ├── WhatsApp Cloud API (Meta)  [chats, plantillas, media]
                                     ├── Google Calendar API (SA)   [agenda por sucursal]
                                     └── Facebook Conversions API   [pixel/CAPI opcional]
Meta ──webhook──> /webhook (mensajes entrantes, ecos, historial, estados)
```

---

## 2. Infraestructura y despliegue

- **Servidor:** `root@68.183.131.170`.
  - Prod: `/root/bunnyrabbit-whatsapp` — puerto **3000**, PM2 `bunnyrabbit`.
  - Staging: `/root/bunnyrabbit-staging` — puerto **3001**, PM2 `bunnyrabbit-staging`.
- **Repo:** `git@github.com:JoseGallegos21/bunnyrabbit-whatsapp.git` (rama `main`).
- **Secretos NO versionados** (`.gitignore`): `.env`, `gcal-sa.json`, `whatsapp.db`, `public/uploads/`.

### Flujo de deploy

1. Editar en local → `git commit` → `git push origin main`.
2. En el server: `./deploy.sh main`
   - respalda la DB, resuelve el commit remoto, `git checkout --force`, `node --check index.js`,
     `pm2 restart`, verifica HTTP 200. Si falla: `./rollback.sh`.
3. ⚠️ **No editar producción a mano:** `deploy.sh` hace `git checkout --force` (borra cambios locales
   versionados). Los archivos NO versionados (`.env`, `gcal-sa.json`, `public/uploads/`) se conservan.

### Variables de entorno (`.env`)

`PORT`, `HOST`, `JWT_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `META_APP_ID`, `META_APP_SECRET`,
`META_GRAPH_VERSION`, `META_ES_CONFIG_ID`, `GOOGLE_SA_KEY_FILE` (ruta a `gcal-sa.json`).

---

## 3. Roles

| Rol | Página | Qué puede |
|---|---|---|
| **admin** | `admin.html` | Todo: usuarios, sucursales, números, plantillas, difusión, reportes, workflows, calendario, CAPI. |
| **supervisor** (gerente) | `supervisor.html` | Métricas de su sucursal, aprobar remarketing, calendario, chats, equipo, alertas de técnicas. |
| **recepcionista** | `index.html` | Chat de su número, plantillas, remarketing (pide), contactos, etiquetas, su perfil. |
| **tecnica** | `tecnica.html` | Sus citas del día/semana (Google Calendar), palomeo de asistencia, confirmar/avisar al gerente. |

Guardas: un supervisor solo toca su sucursal y no puede crear/editar admins ni supervisores; la
gestión de **sucursales** es solo de admin.

---

## 4. Estructura del proyecto

```
index.js            Todo el backend (Express + SQLite + crons + integraciones)
deploy.sh           Despliegue a prod/staging
rollback.sh         Volver a la versión anterior
backup.js           Respaldo de la DB
package.json
public/
  index.html        Chat (recepcionista/admin)
  admin.html        Panel de administración
  supervisor.html   Panel del supervisor/gerente
  tecnica.html      Panel de la técnica (citas del día)
  privacy.html      Aviso de privacidad
  uploads/          Imágenes subidas (media saliente, fotos de perfil) — NO versionado
  boxicons/tabler   Iconos
gcal-sa.json        Llave del service account de Google — NO versionado
.env                Secretos — NO versionado
whatsapp.db         Base de datos SQLite — NO versionado
```

---

## 5. Modelo de datos (tablas principales)

| Tabla | Para qué |
|---|---|
| `usuarios` | Cuentas del sistema (nombre, email, password, rol, sucursal, numero_id, telefono, **foto_url**). |
| `numeros` | Números de WhatsApp por sucursal (phone_number_id, token, waba_id, pixel/CAPI, estado de sync). |
| `sucursales` | Sucursales (nombre, dirección, phone_number_id, logo). |
| `contactos` | Clientes (telefono, nombre, notas, etapa, prioridad, sucursal, numero_id, origen). |
| `mensajes` | Todos los mensajes (contacto, mensaje, direccion, timestamp, leido, origen, tipo, **media_id/media_tipo/media_mime**). |
| `plantillas` | Plantillas de WhatsApp (nombre, categoria, contenido, estado_meta, meta_template_id, botones). |
| `difusiones` | Campañas masivas desde el CRM (plantilla, total, enviados, fallidos, costo). |
| `remarketing_solicitudes` | Remarketing con aprobación (recepcionista pide → supervisor aprueba). |
| `citas` | Citas internas (poco usadas; la agenda real vive en Google Calendar). |
| `asistencias` | Palomeo de asistencia por evento (✓ Vino / ✗ No vino, monto, método de pago). |
| `confirmaciones_dia` | Confirmación de la técnica por día (confirmada / no_puede → alerta al gerente). |
| `google_calendar_config` | ID de calendario de Google por sucursal. |
| `etiquetas`, `contacto_etiquetas` | Etiquetas y su relación con contactos. |
| `respuestas_rapidas` | Respuestas rápidas del recepcionista. |
| `workflows`, `workflow_inscripciones`, `workflow_log` | Motor de automatizaciones. |
| `facebook_capi_config`, `facebook_capi_logs` | Conversions API (opcional). |
| `tarifas_meta`, `configuracion`, `biblioteca_imagenes` | Tarifas WhatsApp, config general, biblioteca de imágenes. |

Origen de `mensajes`/`contactos`: `null` (webhook en vivo), `celular` (ecos de coexistencia),
`historial` (backfill de coexistencia), `formulario_ads` (leads de anuncios, se ocultan en el chat).

---

## 6. API (endpoints por módulo)

Todos bajo `/api`, con `Authorization: Bearer <jwt>` salvo `/api/login` y `/webhook`.

- **Sesión / perfil:** `POST /login`, `GET /mi-perfil`, `POST /mi-perfil/foto`.
- **Chat:** `GET /conversaciones` (lista lateral), `GET /mensajes` y `GET /mensajes/:telefono` (historial),
  `POST /enviar`, `PUT /leer/:contacto`, `GET /media/:id` (proxy de multimedia), `POST /upload`.
- **Métricas:** `GET /metricas`, `GET /metricas/conversaciones` (por conversación), `GET /metricas/supervisor`.
- **Contactos / etiquetas:** `GET/PUT/DELETE /contactos...`, `POST /contactos/importar` (CSV), `*/etiquetas`.
- **Usuarios / sucursales:** `GET/POST/PUT/DELETE /usuarios`, `/sucursales`, `/sucursales/:id/usuarios` (equipo).
- **Plantillas / difusión / remarketing:** `/plantillas`, `/plantillas/sync`, `/difusion*`, `/remarketing/*`.
- **Agenda:** `GET /google-calendar/eventos`, `/google-calendar/config`, `/citas`, `/asistencias`,
  `/tecnicas`, `/confirmaciones*` (confirmar día / alertas al gerente).
- **Números / coexistencia:** `POST /numeros/coexistencia`, `/numeros/nuevo`, `/numeros/capi`.
- **Reportes / workflows / CAPI:** `/reportes*`, `/workflows*`, `/facebook/*`.
- **Webhook Meta:** `GET/POST /webhook`.

---

## 7. Funcionalidades por módulo

### Chat (recepcionista/admin — `index.html`)
- Lista lateral con **todas las conversaciones** (una por contacto, hasta 400 recientes), avatar con
  iniciales + color por contacto, nombre, hora del último mensaje, no leídos, buscador.
- Historial **completo** por conversación al abrir un chat (hasta 1000 mensajes).
- **Multimedia** entrante/saliente (foto/video/audio/documento/sticker) vía proxy a Meta; visor de
  imagen dentro de la app (lightbox). *Solo para media nuevo — ver limitaciones.*
- Navegación por pestañas (Chat / Plantillas / Remarketing / Contactos / Etiquetas).
- **Perfil desplegable** en el encabezado (rol, sucursal, correo, teléfono; foto subible; cerrar sesión).

### Supervisor (`supervisor.html`)
- **Métricas:** citas de hoy por **sucursal seleccionable** (Google Calendar + palomeo: Citas/Pendientes/
  Atendidas/No vino), contabilidad por conversación con **rango de fechas**, actividad por recepcionista.
- **Solicitudes:** aprobar/rechazar remarketing.
- **Calendario:** eventos de Google Calendar por sucursal, filtro por técnico (según el equipo de la sucursal).
- **Chats:** ver conversaciones (con multimedia).
- **Equipo:** usuarios agrupados por sucursal; agregar/editar.
- **Alertas:** técnicas que avisaron que no pueden acudir (con botón de WhatsApp directo).

### Técnica (`tecnica.html`)
- Mis citas de hoy y Mi semana (Google Calendar de su sucursal), **solo las suyas** (match por el tag
  `…-Bel` / `…-Naim` al final del título; toggle "todas/mías").
- **Palomeo de asistencia** (✓ Vino / ✗ No vino) → tabla `asistencias`, con contadores del día.
- **Confirmar el día** ("Sí voy" / "No puedo" → alerta al gerente).

### Admin (`admin.html`)
Usuarios, sucursales (crear/editar/ver equipo), números de WhatsApp (coexistencia y manual), plantillas
(crear + enviar a Meta), difusión, remarketing, reportes, biblioteca, workflows, calendario, Facebook CAPI.

---

## 8. WhatsApp / coexistencia

- **Coexistencia:** el número funciona en el celular (WhatsApp Business ≥ 2.24.17) **y** en la plataforma.
  Meta envía por webhook: mensajes entrantes en vivo, **ecos** (lo que se manda desde el celular, origen
  `celular`), **historial** (hasta ~180 días, origen `historial`) y **sincronización de contactos** de la
  libreta del teléfono (de ahí salen los nombres).
- **Nombres de contacto:** del perfil de WhatsApp de quien escribe (`value.contacts[].profile.name`) o de
  la libreta del teléfono (sync de coexistencia, cron diario 4:30am). No pisa nombres puestos a mano.
- **Multimedia:** al llegar se guarda el `media_id`; `GET /api/media/:id` hace de proxy (pide la URL a Meta
  con el token del número y devuelve el binario; el navegador nunca ve el token).
- **Firma del webhook:** se valida con `META_APP_SECRET` (HMAC-SHA256).

---

## 9. Google Calendar

- Lectura por **cuenta de servicio** (`gcal-sa.json` → `GOOGLE_SA_KEY_FILE`). Cada sucursal comparte su
  calendario (solo lectura) con `bunnyrabbit-calendar@bunnyrabbit-calendario.iam.gserviceaccount.com` y
  pega su "ID de calendario" en Admin → Calendario.
- Las citas se interpretan en zona **México (-06:00)**.

---

## 10. Crons (node-cron, zona America/Mexico_City)

| Horario | Qué hace |
|---|---|
| `0 20 * * *` (8:00 pm) | Recordatorio a cada técnica con sus citas de mañana (Google Calendar), por WhatsApp. Usa la plantilla de utilidad si está aprobada; si no, texto libre. |
| `0 7 * * *` (7:00 am) | Recordatorio del mismo día (citas de la tabla interna). |
| `30 4 * * *` (4:30 am) | Re-sync diario de contactos de coexistencia (llena nombres desde el teléfono). |
| `* * * * *` (cada min) | Motor de workflows (avanza inscripciones que ya vencieron). |

---

## 11. Limitaciones conocidas (candados de Meta, no del sistema)

- **Fotos de perfil de clientes:** Meta no las expone por API. Se usan avatares con iniciales + color.
  (La foto del propio usuario del sistema **sí** se puede subir; la del número de la sucursal también existe.)
- **Multimedia vieja:** los mensajes previos guardados solo como `[media]` (sin `media_id`) no se pueden
  recuperar; además Meta borra los archivos a ~30 días. Solo se ve el media **nuevo**.
- **Estadísticas de plantillas (Template Insights):** NO disponibles por API para cuentas **SMB/coexistencia**
  (Meta responde `#10 SMB business type`). Los números existen solo en el WhatsApp Manager de Meta. Para
  tener stats propias habría que enviar las difusiones **desde el CRM**.
- **Búsqueda del chat:** filtra entre las conversaciones cargadas (400 recientes). Búsqueda global en toda la
  base es un pendiente.

---

## 12. Seguridad y pendientes

- **`.env` y `gcal-sa.json`** están en `.gitignore` (no se suben al repo). Copiarlos del servidor.
- **Rotación de secretos (pendiente):** rotar `META_APP_SECRET` (Meta → App → restablecer clave) y la llave
  del service account de Google. Detalle en `PENDIENTES.md`.
- **Servidor chico (~445 MB RAM):** considerar upgrade si se conectan muchos números / historiales grandes.
- Para escalar coexistencia más allá de ~30 días: PLBV (Partner-Led Business Verification) o Meta Verified.

---

## 13. Cómo correr en local (referencia)

```bash
npm install
# copiar .env y gcal-sa.json del servidor
node index.js         # usa PORT/HOST del .env; crea whatsapp.db si no existe
```

El webhook requiere una URL pública (nginx/HTTPS); en local se prueban los endpoints REST directamente.
