# BETSAM — Parlay del día con suscripción por Yappy

App web (se instala en iPhone y Android desde el navegador) donde:

- Tú publicas cada día el parlay desde el **Panel** (selecciones, cuotas, cuota combinada calculada sola, inversión sugerida y notas).
- Los clientes crean su cuenta con su celular, eligen un plan y **pagan por Yappy**.
- Tú confirmas el pago en tu Yappy Comercial y lo apruebas en el panel: la suscripción se activa sola por los días del plan (si renueva antes de vencer, los días se suman).
- Sin suscripción, el cliente ve que hay parlay hoy y cuántas selecciones tiene, pero borroso.
- La pestaña **Resultados** muestra públicamente los parlays ganados y perdidos de los últimos 45 días (sirve para vender).

## Cómo funciona el pago con Yappy

1. El cliente elige plan → la app le muestra tu `@Directorio` o celular Yappy, el monto y un **código único** (ej. `BS7KQ2M`).
2. Paga en Yappy poniendo ese código en el mensaje.
3. Escribe en la app el número de confirmación de Yappy y sube la captura.
4. Te llega a **Panel → Pagos**. Lo buscas en Yappy Comercial, tocas **Aprobar**, y listo.
5. Opcional: el cliente toca "Avisar por WhatsApp" y te llega el mensaje con su código.

## Publicar en Railway (igual que SAMGERS ODDS)

1. Sube esta carpeta a un repositorio nuevo en GitHub.
2. En Railway: **New Project → Deploy from GitHub repo** → elige el repo.
3. En el mismo proyecto: **New → Database → PostgreSQL**.
4. En el servicio de la app, pestaña **Variables**, agrega:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referencia a la base de datos) |
| `JWT_SECRET` | una frase larga y secreta cualquiera |
| `ADMIN_PHONE` | tu celular (ej. `6XXX-XXXX`) |
| `ADMIN_PASSWORD` | tu contraseña de administrador |
| `ADMIN_NAME` | tu nombre (opcional) |
| `APP_NAME` | el nombre de la app (opcional, por defecto `BETSAM`) |
| `NODE_ENV` | `production` |

5. **Settings → Networking → Generate Domain** para tener el enlace público.
6. Entra con tu celular y contraseña → **Panel → Ajustes** y llena tu `@Directorio` Yappy, celular, nombre, WhatsApp y precios de los planes.

Las tablas se crean solas al arrancar. Planes iniciales: Semanal $10 (7 días) y Mensual $30 (30 días); cámbialos en Ajustes.

## Instalar en el celular

- **iPhone (Safari):** Compartir → Agregar a pantalla de inicio.
- **Android (Chrome):** menú ⋮ → Instalar app / Agregar a pantalla principal.

## Probar en tu computadora

```bash
npm install
DATABASE_URL=postgres://usuario:clave@localhost:5432/picks JWT_SECRET=algo ADMIN_PHONE=60000000 ADMIN_PASSWORD=admin123 npm start
```

Abre http://localhost:3000

## Siguiente paso posible: Botón de Pago Yappy automático

Si abres una cuenta **Yappy Comercial** y activas el *Botón de Pago Yappy*, Yappy te da credenciales de comercio y avisa a tu servidor cuando el pago se completa. Con eso se puede quitar la aprobación manual y activar la suscripción al instante. Yappy cobra una comisión por transacción en ese modo.
