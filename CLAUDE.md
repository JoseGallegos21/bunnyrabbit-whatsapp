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
- **Node 22.** App principal: `index.js` (~3300 líneas). Fronts en `public/`: `index.html` (chat/recepcionista),
  `admin.html`, `supervisor.html`, `tecnica.html`.
- **Documentación técnica completa:** [DOCUMENTACION.md](DOCUMENTACION.md).

## Secretos (NO están en git)
- `.env` (JWT_SECRET, META_APP_*, GOOGLE_SA_KEY_FILE, etc.) y `gcal-sa.json` (llave del service account de Google).
- Cópialos del servidor con `scp` si trabajas en local. `gcal-sa.json` está en `.gitignore`.

## Cómo desplegar
1. Editar en local → `git commit` → `git push origin main`.
2. En el server: `./deploy.sh main` (respalda la DB, valida con `node --check`, reinicia PM2, verifica HTTP 200).
   Si algo falla: `./rollback.sh`.
- ⚠️ **NO editar producción a mano:** `deploy.sh` hace `git checkout --force` y borra cambios locales sin commitear.
- Acceso SSH al server con la llave privada `bunnyrabbit` (en la Mac: `~/.ssh/bunnyrabbit`).
  Ejemplo: `ssh -i ~/.ssh/bunnyrabbit root@68.183.131.170`.

## Setup para continuar en otra máquina (Windows / Mac / Linux)

1. **Instalar** Git y Node 22. En Windows: [git-scm.com](https://git-scm.com) (trae Git Bash + `ssh`)
   y [nodejs.org](https://nodejs.org). Trabaja desde **Git Bash** (o PowerShell) para que `ssh`/`scp` funcionen.
2. **Clonar el repo:**
   - SSH: `git clone git@github.com:JoseGallegos21/bunnyrabbit-whatsapp.git` (requiere una llave SSH registrada
     en GitHub → Settings → SSH keys).
   - o HTTPS: `git clone https://github.com/JoseGallegos21/bunnyrabbit-whatsapp.git` (pide login o un token PAT).
3. `cd bunnyrabbit-whatsapp && npm install`.
4. **Copiar los secretos** desde el servidor a la raíz del proyecto (una vez tengas acceso SSH):
   `scp -i ~/.ssh/bunnyrabbit root@68.183.131.170:/root/bunnyrabbit-whatsapp/.env .` y lo mismo con `gcal-sa.json`.
   (Ambos están en `.gitignore` y no se suben al repo a propósito.)
5. **Llaves SSH en la máquina nueva** (colócalas en `~/.ssh/`, en Windows es `C:\Users\<tu-usuario>\.ssh\`):
   - **GitHub:** genera una llave (`ssh-keygen -t ed25519`) y agrega la `.pub` en GitHub, o copia la existente.
   - **Servidor:** copia la llave privada `bunnyrabbit` de la Mac, o genera una nueva y agrega su `.pub` a
     `~/.ssh/authorized_keys` del servidor. Prueba: `ssh -i ~/.ssh/bunnyrabbit root@68.183.131.170 'echo ok'`.
6. **Desplegar** igual que siempre: `git push origin main` → en el server `ssh ... './deploy.sh main'`.

Windows-tip: los comandos son idénticos en Git Bash. En PowerShell, `ssh`/`scp`/`git` también existen; solo cambia
la ruta de las llaves (`$HOME\.ssh\bunnyrabbit`).

## Notas de dominio
- **Roles:** admin, supervisor, recepcionista (chat + remarketing), técnica (calendario + asistencia).
- **Coexistencia (WhatsApp):** números conectados por Embedded Signup; el historial llega por webhook `field:history`
  (arreglos `messages`/`message_echoes`, se guardan con `origen='historial'`). Re-disparo: `POST /{pnid}/smb_app_data`
  con `sync_type:'history'`.
- **Google Calendar:** cuenta de servicio lee calendarios compartidos con
  `bunnyrabbit-calendar@bunnyrabbit-calendario.iam.gserviceaccount.com`; mapeo sucursal→calendar_id en Admin → 📅 Calendario.
- **Asistencia/cortes:** tabla `asistencias` (palomeo Vino/No vino en tecnica.html); base para el sistema de cortes.
