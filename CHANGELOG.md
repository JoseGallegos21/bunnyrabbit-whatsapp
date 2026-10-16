# Changelog — BunnyRabbit

## v1.14.0 — Sistema de Cortes (rama `feature/cortes`, octubre 2026)

### Nuevo
- **Técnica — palomeo con cobro:** al marcar "✓ Vino" se registra el cobro (tipo, servicio, precio, forma de pago incl. mixto, propina). "✗ No vino" anula. Un servicio por cita (`servicios.event_id`); re-palomear actualiza.
- **Técnica — pestaña "Comisiones":** sus comisiones de la semana (solo lectura).
- **Recepción — Corte del día** (`index.html` → Corte → Día): total vendido, efectivo en caja, terminal, transferencias; ingresos; cuadre; servicios del día; por técnica; egresos (anulables); cierre con efectivo contado y diferencia (`corte_cierres`), aviso si cambia tras el cierre.
- **Recepción — Corte semanal** (Corte → Semana): equivalente al "Corte por fecha" del Excel; gastos fijos (`corte_fijos`), comisión bancaria (`configuracion.corte_tasa_banco`, 2.5%), utilidad, efectivo/tarjeta por día, sobrante de efectivo.
- **Nómina:** comisiones, sueldo, propinas, bonos (manuales), descuentos; "💵 Pagar" (`corte_pagos`, pagos parciales, colaboradores sin usuario por nombre) y "Ajustar" (`corte_ajustes`).
- **Excel del corte (Google Sheets):** escritura automática de servicios → "Respuestas de formulario 1", egresos → "Egresos", pagos → "Comisiones Externas", con el formato del Google Form; marca `BR-S/E/P<id>` para actualizar/anular en sitio; reintento cada 5 min; indicador de estado. Config por número en `corte_sheet_config` (`/api/corte/excel-config`).

### Reglas de cálculo (validadas contra el Excel, semana real 5–11 oct 2026: cuadra al centavo)
- Comisión: 25.5% micropigmentación · 29.75% pestañas · 0% pomada (`corte_tasas`, regla por servicio `servicio:pomada`). Sin redondeo por fila.
- Comisión bancaria: 2.5% × (tarjeta + anticipos a futuro con tarjeta + propinas con tarjeta).
- Utilidad: total − comisiones − sueldos − bonos − propinas − gastos − gastos fijos − comisión bancaria.
- Pagado: pagos tipo "Pagado" o "Comisión" en Comisiones Externas.

### Endpoints
`/api/servicios` (+ `/:id/anular`), `/api/corte/mi-corte`, `/api/corte/dia`, `/api/corte/cerrar`, `/api/corte/semana`, `/api/corte/ajustes`, `/api/corte/fijos`, `/api/corte/pagos` (+ `/:id/borrar`), `/api/corte/egresos` (+ `/:id/borrar`), `/api/corte/excel-estado`, `/api/corte/excel-config`.

### Herramientas
- `import_real.js DESDE HASTA` — importa al laboratorio una semana real del Excel (solo lectura).
- `cotejo.js DESDE HASTA` — compara el corte semanal de la app contra la pestaña Cortes del Excel.

### Pendiente antes de activar en producción
- Registrar ventas/servicios **sin cita** desde recepción (p. ej. pomadas).
- Escribir en "Comisiones Externas" las filas de concepto "Sueldo"/"Bono" de cada semana (el Excel las lee de ahí).
- Configurar la hoja REAL en `corte_sheet_config` y `usuarios.nombre_corte` en producción; cerrar el Google Form.

### Infraestructura (aplicado en el servidor, fuera del repo)
- Drop-in `pm2-root.service.d/override.conf` (Type=oneshot, sin PIDFile): corrige el ciclo de reinicios cada ~46 s causado por SELinux.
- Respaldo completo `/root/scripts/backup_full.sh` (bases + uploads + config) descargado 2×/día a la PC de administración.

## v1.13.0 — cambios en producción desde v1.12.2 (agosto–septiembre 2026, sin etiquetar)
Asistencias (palomeo Vino/No vino), CPL (hoja de compras → etiqueta "Compró"), plantillas con imagen/botones, chats estilo WhatsApp, agenda tipo Google Calendar, envío de fotos, confirmación de citas por WhatsApp, citas con acompañante, estado en línea en admin, remarketing del supervisor, mejoras móviles.
