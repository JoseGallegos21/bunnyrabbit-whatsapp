# BunnyRabbit — Informe de pendientes

CRM de WhatsApp (bunnyrabbit.lat) que reemplaza GoHighLevel para 23 sucursales de estudios de cejas.
Última actualización: ago 2026. Producción ~v1.13.x.

## Infra / cómo trabajar

- **Servidor:** `root@68.183.131.170` — prod en `/root/bunnyrabbit-whatsapp` (puerto 3000, PM2 `bunnyrabbit`), staging en `/root/bunnyrabbit-staging` (puerto 3001, PM2 `bunnyrabbit-staging`).
- **Stack:** Node 22 + Express + SQLite (`whatsapp.db`) + PM2. nginx enfrente (`/etc/nginx/conf.d/bunnyrabbit.conf`) → 127.0.0.1:3000.
- **Repo:** `git@github.com:JoseGallegos21/bunnyrabbit-whatsapp.git` (rama `main`).
- **Secretos NO versionados:** `.env` y `gcal-sa.json` (llave del service account). Copiarlos del servidor.
- **Flujo de deploy correcto:**
  1. Editar en local (Mac).
  2. `git commit` + `git push origin main`.
  3. En el server: `./deploy.sh main` (respalda la DB, valida sintaxis con `node --check`, reinicia PM2, verifica HTTP 200). Si falla: `./rollback.sh`.
- ⚠️ **NO editar producción a mano:** `deploy.sh` hace `git checkout --force` y borra cambios locales no commiteados.
- ⚠️ **Servidor chico (445 MB RAM).** Considerar upgrade si se conectan muchos números / historiales grandes.

## Lo que YA funciona

- Coexistencia: 1 número conectado (**Caralinda San Rafael**, pnid 113038055214763). Recibe mensajes nuevos + echoes del celular. Historial sincronizando.
- Google Calendar por **cuenta de servicio** (`bunnyrabbit-calendar@bunnyrabbit-calendario.iam.gserviceaccount.com`): 1 sucursal (Caralinda) leyendo citas reales en el calendario de la técnica.
- **Palomeo de asistencia** (✓ Vino / ✗ No vino) en `tecnica.html` → tabla `asistencias`.
- Remarketing con aprobación (recepcionista pide → supervisor aprueba).
- Responsividad móvil de `index.html` (chat) y `tecnica.html`.

## PENDIENTES (por prioridad)

### 1. Seguridad — URGENTE
- [ ] **Rotar el App Secret de Meta** (se expuso en chat). Meta → App → Config básica → Restablecer clave secreta. Actualizar `META_APP_SECRET` en `.env` (prod + staging) por canal privado.
- [ ] **Rotar la llave del Service Account de Google** (`gcal-sa.json` se pegó en chat). Google Cloud → cuenta de servicio → Claves → borrar la actual y crear otra JSON → re-subir al server.
- [ ] Confirmar que `gcal-sa.json` quedó en `.gitignore` (para no subir la llave al repo).

### 2. Google Calendar — replicar en las otras 22 sucursales
Por cada sucursal: en calendar.google.com compartir su calendario con `bunnyrabbit-calendar@bunnyrabbit-calendario.iam.gserviceaccount.com` (permiso "Ver todos los detalles del evento"), copiar el "ID de calendario" (Integrar calendario) y pegarlo en **Admin → 📅 Calendario**.

### 3. Coexistencia — cerrar Caralinda y escalar
- [ ] Que termine de bajar el historial de Caralinda (en curso; llega en trozos de 10 MB).
- [ ] **Quitar el `console.log('[COEX] RAW history'...)` temporal** de `index.js` (spam de logs) con un redeploy cuando termine el sync.
- [ ] (Opcional) Limpiar ~800 mensajes que llegaron antes del arreglo mal etiquetados como `celular`/`null` con fecha de hoy: re-sync limpio (DELETE del número + `sync_type:history`) cuando reset el rate limit de Meta.
- [ ] **Conectar los otros 22 números** (botón verde de coexistencia en Admin → Usuarios → Conexión).
- [ ] Para escalar (>30 días / límites): PLBV (Partner-Led Business Verification, lo lidera Raga como Tech Provider) o Meta Verified. La verificación estándar NO aplica a coexistencia.

### 4. Sistema de cortes del recepcionista (idea a desarrollar)
Construir la vista de corte encima del palomeo de asistencia. La tabla `asistencias` ya tiene `monto` y `metodo_pago` reservados. Decisiones por definir:
- ¿Solo asistencia o también dinero (monto + método de pago, total del día)?
- ¿Montos por catálogo de servicios con precio fijo o manual?
- ¿Quién captura el cobro y cierra el corte (recepcionista vs técnica)?

### 5. Remarketing — encender
- [ ] Plantilla de Marketing `rm_agosto` aprobada **con botones** (QUIERO AGENDAR, DETENER).
- [ ] Configurar tipo de cambio USD→MXN y tarifas Utility/Authentication (Admin → Reportes → ⚙ Tarifas).

### 6. Responsividad móvil
- [ ] Falta `admin.html` (tablas + canvas de workflow) y `supervisor.html` (métricas, calendario, chats). `index.html` y `tecnica.html` ya están.

### 7. Robustez (opcional)
- [ ] Envolver los `fetch(...).then(r=>r.json())` con chequeo de `r.ok` en las 4 páginas (para no romper ante 4xx / token caducado).

## Historial técnico reciente (esta sesión)

- **Fix desfase de 1 día en calendario** (`tecnica.html`): se agrupaba por UTC (`toISOString`) con la hora actual → en la noche corría el día. Helper `ymd()` (fecha local). Endpoint `/api/google-calendar/eventos` ahora usa rango con `-06:00`.
- **Asistencia**: tabla `asistencias`, endpoints `GET/POST /api/asistencias`, botones en "Mis citas de hoy".
- **Sync de historial coexistencia**: nginx tapaba en 1 MB (subido a 20 MB); `sync_type:history` re-dispara; parser corregido para `messages`/`message_echoes`; despacho enruta `history` exclusivo a `historial`.
