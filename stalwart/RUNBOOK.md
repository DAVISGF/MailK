# Stalwart: correo real multi-dominio (guía de operación)

MailK (raíz del repo) es el servidor de **pruebas**. Esta carpeta es para tu servidor de correo **real**: recibe y envía desde internet, para muchos dominios.

**Versión probada:** Stalwart v1.1.0, en local. Se probó el asistente inicial, varios dominios, buzones, envío firmado con DKIM entre dominios, recepción por el puerto 25, antispam, rechazo de relay abierto, IMAP con carpetas y `admin.sh`. El despliegue en un VPS real no se pudo probar desde el entorno de desarrollo.

## 1. Crear el VPS

Recomendado: **Vultr, región Santiago**, Ubuntu 24.04, 1 vCPU / 2 GB (~$10–12/mes) con backups automáticos activados (~$2/mes).

1. Crea el servidor y anota su **IP pública**.
2. **Desbloquea el puerto 25 de salida.** Vultr lo bloquea en cuentas nuevas: abre un ticket en Support → "Request to open SMTP port 25 for my own mail server at `<IP>`". Sin esto puedes recibir, pero no enviar.
3. **DNS inverso (PTR):** en el panel del servidor → Settings → IPv4 → Reverse DNS → `mail.<tu-dominio-principal>`.
4. En el DNS del dominio principal crea el registro **A** `mail.<dominio-principal>` → IP del VPS. Debe existir **antes** del paso 3, porque Let's Encrypt lo necesita.

## 2. Instalar Stalwart

Desde tu computador, con esta carpeta del repo:

```bash
scp -r stalwart root@<IP>:/root/
ssh root@<IP> "bash /root/stalwart/setup-vps.sh mail.<dominio-principal>"
```

El script hace lo siguiente:
- Actualiza el sistema e instala Docker y el firewall.
- Abre solo los puertos de correo y SSH.
- Levanta Stalwart en `/opt/stalwart`.
- Comprueba si el puerto 25 de salida está abierto.
- Muestra la **clave temporal** del administrador.

**Asistente inicial (una sola vez):**

1. Abre un túnel desde tu computador y entra a `http://127.0.0.1:8080/admin` con el usuario `admin` y la clave temporal:
   ```bash
   ssh -L 8080:127.0.0.1:8080 root@<IP>
   ```
2. **Server Identity:** Hostname `mail.<dominio-principal>`, Default domain `<dominio-principal>`. Deja **activados** "Automatically Obtain TLS Certificate" (Let's Encrypt) y "Generate Email Signing Keys" (DKIM).
3. **Storage:** RocksDB (por defecto). **Directory:** interno (por defecto). **Logging:** por defecto (`/var/log/stalwart/`, que ya tiene su volumen).
4. **DNS Management:** "Manual" (salvo que tu DNS esté en un proveedor soportado y quieras automatizarlo).
5. **Finish setup:** aparece el administrador definitivo (`admin@<dominio-principal>`) con su clave. **Anótala: no se vuelve a mostrar.**
6. Reinicia:
   ```bash
   ssh root@<IP> "cd /opt/stalwart && docker compose restart stalwart"
   ```
7. Desde ahora, el panel está en **`https://mail.<dominio-principal>/admin`**. Después de configurar el servidor, el login por `127.0.0.1:8080` ya no funciona, porque está atado al hostname.

## 3. Agregar dominios

Por panel (Domains → Create domain) o por terminal, con `admin.sh` (instalado en `/opt/stalwart`):

```bash
export STALWART_URL=https://mail.<dominio-principal>
export STALWART_ADMIN=admin@<dominio-principal>
export STALWART_PASS='<clave-admin>'
./admin.sh add-domain otro.com
./admin.sh zone otro.com      # registros a publicar en el DNS de otro.com
```

Publica los registros siguiendo [dns-checklist.md](dns-checklist.md). Después, en el panel: Domains → otro.com → **TLS → Certificate Management: ACME**, para que el certificado cubra `mta-sts`, `autoconfig` y `autodiscover` de ese dominio.

## 4. Buzones, alias y postmaster

```bash
./admin.sh add-user ana@otro.com 'Frase-Larga-Y-Unica-2026' "Ana Pérez"
./admin.sh passwd   ana@otro.com 'Otra-Frase-Larga-2026'
./admin.sh users
./admin.sh del-user ana@otro.com
```

- **Contraseñas:** Stalwart rechaza claves débiles (por ejemplo `Uno-1111`). Usa frases de 3–4 palabras.
- **Alias** (otra dirección que llega al mismo buzón), **catch-all** y **cuotas:** en el panel → Directory → Accounts → cuenta → Email Aliases / Quotas; catch-all en Domains → dominio → Email.
- **`postmaster@<dominio>`:** créalo como alias del administrador en **cada** dominio. Recibe los reportes DMARC y TLS.

## 5. Configurar clientes (Thunderbird, Outlook, celular)

Con los registros autoconfig/SRV publicados, basta con poner el correo y la clave. Configuración manual:

| | Servidor | Puerto | Seguridad |
|---|---|---|---|
| IMAP | `mail.<dominio-principal>` | 993 | SSL/TLS |
| POP3 | `mail.<dominio-principal>` | 995 | SSL/TLS |
| SMTP (envío) | `mail.<dominio-principal>` | 465 | SSL/TLS, usuario = correo completo |

El puerto **587 (STARTTLS)** no viene abierto por defecto. Si algún cliente o equipo lo necesita:
1. En el panel, agrega un listener de *submission* en el 587.
2. Agrega `- "587:587"` en `docker-compose.yml`.
3. Ejecuta `ufw allow 587/tcp` y `docker compose up -d`.

## 6. Respaldo y restauración

Todo vive en tres volúmenes de Docker: `stalwart_stalwart-etc`, `stalwart_stalwart-data` y `stalwart_stalwart-logs`.

- **Backups del VPS (Vultr):** activarlos es la vía más simple (copia diaria de todo el disco).
- **Copia manual de los datos:**
  ```bash
  cd /opt/stalwart && docker compose stop stalwart
  docker run --rm -v stalwart_stalwart-data:/d -v stalwart_stalwart-etc:/e -v /root:/out alpine \
    tar czf /out/stalwart-$(date +%F).tgz -C / d e
  docker compose start stalwart
  ```
- **Restaurar en un VPS nuevo:**
  1. Ejecuta `setup-vps.sh`.
  2. Detén Stalwart con `docker compose stop stalwart`.
  3. Extrae el `.tgz` en los mismos volúmenes.
  4. Inicia con `docker compose start stalwart`.
  5. Actualiza el registro A y el PTR a la nueva IP.

## 7. Actualizar Stalwart

1. Lee las notas de la versión en https://github.com/stalwartlabs/stalwart/releases. Por ejemplo, la 1.1.0 pide reiniciar una vez con `STALWART_UPDATE_ROLE_PERMISSIONS=true`.
2. Haz un respaldo (sección 6).
3. Cambia la etiqueta `image:` en `docker-compose.yml`, en **los dos** servicios.
4. Aplica el cambio:
   ```bash
   docker compose pull && docker compose up -d
   ```

## 8. Si Gmail/Outlook marcan tus correos como spam

1. Revisa que SPF, DKIM y DMARC den `PASS` (dns-checklist.md, "Verificación") y que el PTR esté bien.
2. Revisa listas negras: https://mxtoolbox.com/blacklists.aspx con la IP del VPS.
3. Una IP nueva necesita "calentarse": envía poco volumen al principio.
4. **Plan B: relay de envío** (Amazon SES, Postmark, Mailgun).
   - Cómo: en el panel, busca "Routes" con el buscador (Ctrl K). Crea una ruta "relay" hacia el SMTP del proveedor, con su usuario y clave, y úsala para la entrega remota.
   - Recepción: no cambia.
   - SPF de cada dominio: agrega el `include:` que indique el proveedor.

## 9. Recuperar el acceso de administrador

Si pierdes la clave del administrador:
1. Agrega `STALWART_RECOVERY_ADMIN: "admin:<clave-fuerte>"` en `environment:` del servicio `stalwart`.
2. Aplica con `docker compose up -d`.
3. Entra con usuario `admin` y esa clave. Funciona en el panel y en `admin.sh`.
4. Cambia la clave del administrador real.
5. **Quita** la variable y vuelve a aplicar `docker compose up -d`.

## 10. Notas técnicas (verificadas en v1.1.0)

- **Panel web:** se descarga desde GitHub en el primer arranque, así que el VPS necesita salida HTTPS a `github.com`.
- **Puertos abiertos tras el asistente:** 25, 465, 993, 995, 4190, 443 y 8080. No abre 587, 143 ni 110.
- **Logs:** el asistente propone `/var/log/stalwart/`, que la imagen no trae. El servicio `logs-init` del compose crea esa carpeta con los permisos correctos.
- **Antispam:** el correo entrante sin SPF/DKIM de dominios desconocidos va a "Junk Mail".
- **Relay abierto:** el envío a dominios externos sin autenticación se rechaza (`550 5.7.1 Relay not allowed`).
- **DKIM:** al crear un dominio se generan claves Ed25519 y RSA. La rotación automática requiere DNS automático.
