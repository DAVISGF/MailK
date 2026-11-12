# Registros DNS por dominio (Stalwart)

Stalwart genera los registros exactos de cada dominio, con las claves DKIM incluidas. Para obtenerlos, usa una de estas dos vías:

- **Panel:** Domains → Domains → menú `⋯` del dominio → **View Zone File**.
- **Terminal:** `./admin.sh zone midominio.com`

Copia cada línea en el panel DNS donde está alojado el dominio (registrador, Cloudflare, etc.).
Ejemplos con `principal.com` (dominio del servidor) y `otro.com` (dominio adicional). Servidor: `mail.principal.com`, IP `203.0.113.10`.

## 1. Solo una vez, en el dominio principal

| Tipo | Nombre | Valor | Para qué |
|---|---|---|---|
| A | `mail.principal.com` | `203.0.113.10` | IP del servidor |
| TXT | `mail.principal.com` | `v=spf1 a -all` | SPF del propio servidor |
| PTR | *(en el panel del VPS, no en el DNS)* | `mail.principal.com` | DNS inverso; sin esto Gmail/Outlook rechazan |

## 2. En cada dominio (también el principal)

| Tipo | Nombre | Valor (ejemplo) | Para qué |
|---|---|---|---|
| MX | `otro.com` | `10 mail.principal.com` | Recibir correo |
| TXT | `otro.com` | `v=spf1 mx -all` | SPF: solo este servidor envía |
| TXT | `v1-ed25519-AAAAMMDD._domainkey.otro.com` | `v=DKIM1; k=ed25519; ...` | Firma DKIM (copiar tal cual) |
| TXT | `v1-rsa-AAAAMMDD._domainkey.otro.com` | `v=DKIM1; k=rsa; ...` | Firma DKIM RSA (copiar tal cual; si el panel DNS lo pide, une los dos fragmentos entre comillas en uno solo) |
| TXT | `_dmarc.otro.com` | `v=DMARC1; p=reject; rua=mailto:postmaster@otro.com` | Política DMARC (ver nota) |
| CNAME | `mta-sts.otro.com` | `mail.principal.com` | MTA-STS (TLS obligatorio entre servidores) |
| TXT | `_mta-sts.otro.com` | `v=STSv1; id=...` | MTA-STS |
| TXT | `_smtp._tls.otro.com` | `v=TLSRPTv1; rua=mailto:postmaster@otro.com` | Reportes TLS |
| CNAME | `autoconfig.otro.com` | `mail.principal.com` | Configuración automática (Thunderbird) |
| CNAME | `autodiscover.otro.com` | `mail.principal.com` | Configuración automática (Outlook) |
| CNAME | `ua-auto-config.otro.com` | `mail.principal.com` | Configuración automática |
| TXT | `_ua-auto-config.otro.com` | `v=UAAC1; ...` | Configuración automática |
| SRV | `_imaps._tcp.otro.com` | `0 1 993 mail.principal.com` | Descubrimiento IMAP |
| SRV | `_pop3s._tcp.otro.com` | `0 1 995 mail.principal.com` | Descubrimiento POP3 |
| SRV | `_submissions._tcp.otro.com` | `0 1 465 mail.principal.com` | Descubrimiento SMTP de envío |
| SRV | `_jmap._tcp.otro.com` | `0 1 443 mail.principal.com` | JMAP |
| SRV | `_caldavs._tcp.otro.com`, `_carddavs._tcp.otro.com` | `0 1 443 mail.principal.com` | Calendario y contactos (opcional) |

## Notas importantes

- **Si un dominio ya envía correo desde otro servicio** (Google Workspace, Mailchimp, la web de tu hosting), el SPF de Stalwart (`v=spf1 mx -all`) lo bloquearía. Agrega esos servicios, por ejemplo `v=spf1 mx include:_spf.google.com -all`. Además, empieza con `p=none` en DMARC durante 1–2 semanas y revisa los reportes antes de subir a `quarantine`/`reject`.
- **Dominio sin correo previo:** `p=reject` (lo que propone Stalwart) es lo recomendado.
- **`postmaster@` en cada dominio:** DMARC y TLS-RPT envían reportes ahí. Crea esa dirección como alias del administrador (RUNBOOK.md, sección 4).
- **Solo un SPF por nombre:** si ya existe un TXT `v=spf1 ...`, edítalo; no agregues un segundo.
- **No cambies el nombre del selector DKIM** (`v1-...-AAAAMMDD`): debe coincidir con la clave guardada en el servidor.

## Verificación

```bash
dig +short MX otro.com
dig +short TXT otro.com
dig +short TXT _dmarc.otro.com
dig +short TXT v1-ed25519-AAAAMMDD._domainkey.otro.com
dig +short -x 203.0.113.10        # debe responder mail.principal.com.
```

Prueba final: envía un correo a la dirección que te da https://www.mail-tester.com (meta: 9/10 o más). Otra opción es enviar uno a Gmail y abrir "Mostrar original": deben verse `SPF: PASS`, `DKIM: PASS` y `DMARC: PASS`.
