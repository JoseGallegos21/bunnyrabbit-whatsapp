# BunnyRabbit — Informe de pendientes

CRM de WhatsApp (bunnyrabbit.lat) que reemplaza GoHighLevel para 23 sucursales de estudios de cejas.
Última actualización: 15/ago/2026.

## Infra / cómo trabajar

- **Servidor:** `root@68.183.131.170` — prod en `/root/bunnyrabbit-whatsapp` (puerto 3000, PM2 `bunnyrabbit`), staging en `/root/bunnyrabbit-staging` (puerto 3001). Servidor **chico (445 MB RAM)**.
- **Stack:** Node 22 + Express + SQLite (`whatsapp.db`) + PM2. nginx enfrente (`/etc/nginx/conf.d/bunnyrabbit.conf`, `client_max_body_size 20m`).
- **Repo:** `git@github.com:JoseGallegos21/bunnyrabbit-whatsapp.git`, rama `main`.
- **Secretos NO versionados:** `.env` y `gcal-sa.json`. Copiarlos del servidor con `scp`.
- **Deploy:** editar en local → `git commit` → `git push origin main` → en el server `./deploy.sh main` (respalda DB, valida con `node --check`, reinicia, verifica HTTP 200; rollback `./rollback.sh`). ⚠️ NO editar prod a mano (`deploy.sh` hace `git checkout --force`).

## Lo que YA funciona

**Base / operación**
- Coexistencia: número "Caralinda San Rafael" (pnid 113038055214763) conectado; recibe mensajes + echoes; **historial de mensajes sincronizado** (arreglado: nginx 20mb + parser de `messages`/`message_echoes`).
- Chat (index.html): navegación por pestañas, perfil, avatares, buscador, responsivo móvil. Secciones (Plantillas/Remarketing/Contactos/Etiquetas) ocupan **todo el ancho** en escritorio. Clic en un chat desde **cualquier** pestaña abre el chat. Panel de **Etiquetas** carga bien.
- **Google Calendar** por cuenta de servicio (`bunnyrabbit-calendar@bunnyrabbit-calendario.iam.gserviceaccount.com`): Caralinda San Rafael mostrando citas reales (fix de desfase de 1 día ya aplicado).
- **Asistencia**: técnica marca ✓ Vino / ✗ No vino en "Mis citas de hoy" (tabla `asistencias`).
- **Importador de contactos**: sube CSV de Google Contactos (auto-detecta formato), cruza por últimos 10 dígitos, actualiza nombres reales y agrega los que faltan (no duplica).
- **Leads de anuncio**: header muestra "📢 Vino de un anuncio"; para leads nuevos, **tarjeta de vista previa** (imagen + título + link). El referral (link/imagen) se guarda desde el 14/ago ~6pm en adelante (los previos no tienen el dato).

**Embudo + Meta (CAPI)**
- Cambio de etapa dispara evento CAPI del número (`sendCapiEvent`). Reglas configurables en Admin→Facebook CAPI→Conexión.
- Etapa **"Perdido"** automática: leads (ads/orgánicos) que se quedaron en "Nuevo" 2 días sin avanzar y sin mensaje reciente → Perdido (segmento de remarketing). NO toca el directorio (historial/celular/importados). Se **reactivan** a Nuevo si vuelven a escribir. Columna `etapa_desde` sella cada cambio.
- **Vino → Purchase**: cuando la técnica marca "Vino", cruza el nombre de la cita con los contactos; si hay UNA coincidencia dispara `Purchase` a Meta y mueve la etapa a **Cerrado** (visible para recepcionista). Confiabilidad ~86% con la data actual; sube casi a 100% al importar contactos.
- **Reporte CAPI desplegable**: Admin→Facebook CAPI→Historial, cada evento se expande (fecha, persona, evento, etapa, event_id, si Meta lo recibió).

**Plantillas / Workflows**
- Plantillas se **auto-sincronizan con Meta** cada 30 min (no solo con el botón).
- Plantillas: opción **"📢 Todas las sucursales (coexistencia)"** → crea y envía a cada WABA de un jalón.
- Plantillas a Meta con **componentes completos**: encabezado de texto, cuerpo con ejemplos de variables, pie y **botones de respuesta rápida**.
- Workflows: casilla **"crear una copia por cada sucursal en coexistencia"**.

## PENDIENTES (por prioridad)

### 1. Seguridad — URGENTE
- [ ] **Rotar el App Secret de Meta** (se expuso en chat).
- [ ] **Rotar la llave del Service Account de Google** (`gcal-sa.json` se pegó en chat) → Google Cloud → cuenta de servicio → Claves → borrar y crear otra → re-subir.

### 2. Configurar el embudo (tú, en el panel)
- [ ] Reglas CAPI: Seguimiento → `Contact`, Propuesta → `Lead` (Admin→Facebook CAPI→Conexión→Reglas de disparo del número). El `Purchase` del "Vino" ya es automático.
- [ ] **Importar tu lista de Google Contactos** (sube el cruce del "Vino" a casi 100%).
- [ ] Crear la plantilla **`rm_agosto`** con botones (QUIERO AGENDAR / DETENER) y mandarla a todas las sucursales.

### 3. Escalar coexistencia
- [ ] Conectar los otros 22 números (Admin→Usuarios→Conexión, botón verde).
- [ ] Google Calendar en las otras 22 sucursales (compartir con el correo del SA + pegar ID en Admin→📅 Calendario).
- [ ] Para escalar (>30 días / límites): PLBV (lo lidera Raga como Tech Provider) o Meta Verified.

### 4. Mejoras pendientes
- [ ] **Encabezado de IMAGEN** en plantillas (requiere subir la imagen a Meta con la Resumable Upload API; hoy solo texto/pie/botones).
- [ ] **Sistema de cortes** del recepcionista (sobre el palomeo de asistencia; la tabla `asistencias` ya tiene `monto`/`metodo_pago`).
- [ ] Responsividad móvil de `admin.html` y `supervisor.html`.
- [ ] (Opcional) `fetch(...).then(r=>r.json())` con chequeo de `r.ok` en las 4 páginas.

### 5. Limpieza técnica
- [ ] Quitar los `console.log` temporales de `index.js`: `[COEX] RAW history` y `[ADS] referral`.
- [ ] (Opcional) Limpiar ~800 mensajes de historial mal etiquetados como 'celular'/null (llegaron antes del fix del parser).
