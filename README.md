# MailK

Servidor de correos de prueba independiente (Node.js/TypeScript). Captura correos por **SMTP**, los guarda en **SQLite** agrupados por proyecto y los expone por **IMAP**, **POP3**, **API HTTP** y una **UI web** simple. Nunca entrega correo a internet salvo que configures un relay.

> **¿Necesitas correo real** (enviar y recibir desde internet, varios dominios)? MailK no es para eso. Usa la carpeta [`stalwart/`](stalwart/RUNBOOK.md): Stalwart Mail Server en un VPS, con scripts de instalación, administración por terminal y guía de DNS.

## Uso rápido

```bash
npm install
npm run dev          # o: npm run build && npm start
# o con Docker
docker compose up --build
```

| Servicio | Puerto | TLS (si hay certificado) |
|---|---|---|
| SMTP | 1025 | 1465 |
| IMAP | 1143 | 1993 |
| POP3 | 1110 | 1995 |
| API + UI | 8025 | (usa un proxy HTTPS en la nube) |

Cualquier app envía a `127.0.0.1:1025` sin credenciales (modo local). Lee los correos en `http://localhost:8025`.

## Cuentas, grupos y etiquetas

- **Auto-creación** (`MAILK_AUTO_CREATE=on`, por defecto): al llegar un correo a una dirección nueva se crea su buzón en el grupo `MAILK_DEFAULT_GROUP`.
- El grupo y las etiquetas del correo se pueden fijar al enviar con cabeceras: `X-MailK-Group: proyecto-a`, `X-MailK-Tags: registro,qa`.
- **Por API**: crea cuentas con grupo, clave, etiquetas y relay opcional.

```bash
curl -X POST localhost:8025/api/accounts -H 'content-type: application/json' \
  -d '{"address":"ana@proyecto-a.test","group":"proyecto-a","password":"pw","tags":["qa"]}'
curl 'localhost:8025/api/messages?group=proyecto-a&tag=qa'
curl -X DELETE localhost:8025/api/groups/proyecto-a/messages   # limpia el proyecto
```

IMAP/POP3: usuario = dirección completa. En modo local cualquier clave sirve; con `MAILK_AUTH=on` debe coincidir con la clave de la cuenta.

## API

| Método | Ruta |
|---|---|
| GET/POST | `/api/groups` |
| DELETE | `/api/groups/:g`, `/api/groups/:g/messages` |
| GET | `/api/groups/:g/accounts` |
| GET/POST | `/api/accounts` (`?group=`) |
| PATCH/DELETE | `/api/accounts/:address` |
| DELETE | `/api/accounts/:address/messages` |
| GET | `/api/messages?group=&account=&tag=&q=&limit=` |
| GET/DELETE | `/api/messages/:id` |
| GET | `/api/messages/:id/raw`, `/api/messages/:id/attachments/:n` |

## Configuración (variables de entorno)

| Variable | Defecto | Descripción |
|---|---|---|
| `MAILK_AUTH` | off | `on` exige token API, AUTH SMTP y clave de buzón |
| `MAILK_API_TOKEN` | – | Token `Authorization: Bearer` (obligatorio con auth) |
| `MAILK_SMTP_USER` / `MAILK_SMTP_PASS` | – | Credenciales SMTP (obligatorias con auth) |
| `MAILK_DB` | `./data/mailk.db` | Archivo SQLite |
| `MAILK_AUTO_CREATE` | on | Auto-crear buzones al recibir |
| `MAILK_DEFAULT_GROUP` | default | Grupo por defecto |
| `MAILK_*_PORT` | ver tabla | `SMTP`, `IMAP`, `POP3`, `HTTP`, `SMTPS`, `IMAPS`, `POP3S` |
| `MAILK_TLS_CERT` / `MAILK_TLS_KEY` | – | Ruta o contenido PEM; activa los puertos TLS |
| `MAILK_RELAY_URL` | – | Transporte nodemailer (`smtp://user:pass@host:587`); se usa con cuentas que tengan `relayTo` |
| `MAILK_PUBLIC_HOST` | – | Host o IP que usan tus apps para conectarse; la UI lo muestra en «Conectar tu app» |

## Despliegue en la nube

1. Despliega la imagen con un volumen en `/data`.
2. Define `MAILK_AUTH=on`, `MAILK_API_TOKEN`, `MAILK_SMTP_USER`, `MAILK_SMTP_PASS`.
3. Opcional: monta certificado y clave y define `MAILK_TLS_CERT`/`MAILK_TLS_KEY`.
4. Publica 8025 detrás de HTTPS. SMTP/IMAP/POP3 requieren exponer TCP (no todos los PaaS lo permiten; un VPS o Railway con TCP proxy sirve).

### Fly.io (despliegue actual)

La configuración está en `fly.toml` (app `mailk`, región `gru`, volumen `mailk_data` en `/data`).

- API + UI: `https://mailk.fly.dev`
- SMTP `149.248.217.64:1025`, IMAP `149.248.217.64:1143`, POP3 `149.248.217.64:1110` (IPv4 dedicada, ~$2/mes).
- También por la IPv6 dedicada `2a09:8280:1::1fe:286c:0` en los mismos puertos (`fly ips list -a mailk`).

Primer despliegue en una cuenta nueva:

```bash
fly apps create mailk
fly volumes create mailk_data -r gru -s 1
fly secrets set MAILK_API_TOKEN=... MAILK_SMTP_USER=... MAILK_SMTP_PASS=...
fly deploy
```

Actualizaciones posteriores: `fly deploy` desde la raíz del repo.

## Límites conocidos

- IMAP: una sola carpeta (`INBOX`) por cuenta; sin `APPEND`, `COPY`, `IDLE` ni `STARTTLS` (usa el puerto TLS implícito). `BODYSTRUCTURE` es simplificado (una sola parte).
- SMTP: `STARTTLS` disponible en el puerto 1025 solo si hay certificado configurado; además existe el puerto TLS implícito 1465.
- Pensado para pruebas, no para producción de correo real.

## Tests

```bash
npm test
```
