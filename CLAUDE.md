# CLAUDE.md — BunnyRabbit

CRM de WhatsApp (bunnyrabbit.lat) que reemplaza GoHighLevel para 23 sucursales de estudios de cejas
(microblading/microshading/micropigmentación). Node + Express + SQLite + PM2.

## 👉 Pendientes / roadmap
Lee **[PENDIENTES.md](PENDIENTES.md)** — ahí está el estado actual y la lista priorizada de tareas.

## Infraestructura
- **Servidor:** `root@68.183.131.170` (DigitalOcean, Fedora, ~445 MB RAM — es chico).
  - Prod: `/root/bunnyrabbit-whatsapp` — PM2 `bunnyrabbit`, puerto 3000.
  - Staging: `/root/bunnyrabbit-staging` — PM2 `bunnyrabbit-staging`, puerto 3001.
  - nginx enfrente: `/etc/nginx/conf.d/bunnyrabbit.conf` → 127.0.0.1:3000 (`client_max_body_size 20m`).
- **Repo:** `git@github.com:JoseGallegos21/bunnyrabbit-whatsapp.git`, rama `main`.
- **Node 22.** App principal: `index.js` (~2700 líneas). Fronts en `public/`: `index.html` (chat/recepcionista),
  `admin.html`, `supervisor.html`, `tecnica.html`.

## Secretos (NO están en git)
- `.env` (JWT_SECRET, META_APP_*, GOOGLE_SA_KEY_FILE, etc.) y `gcal-sa.json` (llave del service account de Google).
- Cópialos del servidor con `scp` si trabajas en local. `gcal-sa.json` está en `.gitignore`.

## Cómo desplegar
1. Editar en local → `git commit` → `git push origin main`.
2. En el server: `./deploy.sh main` (respalda la DB, valida con `node --check`, reinicia PM2, verifica HTTP 200).
   Si algo falla: `./rollback.sh`.
- ⚠️ **NO editar producción a mano:** `deploy.sh` hace `git checkout --force` y borra cambios locales sin commitear.
- Acceso SSH ya configurado desde la Mac (llave `~/.ssh/bunnyrabbit`). Tip: alias `bunny` en `~/.ssh/config`.

## Notas de dominio
- **Roles:** admin, supervisor, recepcionista (chat + remarketing), técnica (calendario + asistencia).
- **Coexistencia (WhatsApp):** números conectados por Embedded Signup; el historial llega por webhook `field:history`
  (arreglos `messages`/`message_echoes`, se guardan con `origen='historial'`). Re-disparo: `POST /{pnid}/smb_app_data`
  con `sync_type:'history'`.
- **Google Calendar:** cuenta de servicio lee calendarios compartidos con
  `bunnyrabbit-calendar@bunnyrabbit-calendario.iam.gserviceaccount.com`; mapeo sucursal→calendar_id en Admin → 📅 Calendario.
- **Asistencia/cortes:** tabla `asistencias` (palomeo Vino/No vino en tecnica.html); base para el sistema de cortes.
