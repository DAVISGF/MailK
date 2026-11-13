#!/usr/bin/env bash
# Administración de Stalwart por su API JMAP (probado con v1.1.0).
#
# Uso:
#   export STALWART_URL=https://mail.midominio.com      # hostname del servidor
#   export STALWART_ADMIN=admin@midominio.com           # usuario administrador
#   export STALWART_PASS='...'                          # clave del administrador
#   ./admin.sh domains                                  # lista dominios
#   ./admin.sh add-domain otrodominio.com               # crea dominio (DKIM automático)
#   ./admin.sh zone otrodominio.com                     # registros DNS a publicar (formato BIND)
#   ./admin.sh users                                    # lista buzones
#   ./admin.sh add-user ana@otrodominio.com 'Clave-Fuerte' "Ana Pérez"
#   ./admin.sh passwd ana@otrodominio.com 'Nueva-Clave'
#   ./admin.sh del-user ana@otrodominio.com
#
# Requiere curl y python3. Opcional: STALWART_INSECURE=1 para certificados autofirmados (solo pruebas).
set -euo pipefail

: "${STALWART_URL:?Define STALWART_URL, p. ej. https://mail.midominio.com}"
: "${STALWART_ADMIN:?Define STALWART_ADMIN (usuario administrador)}"
: "${STALWART_PASS:?Define STALWART_PASS (clave del administrador)}"

CURL_OPTS=(-sS --fail-with-body -u "$STALWART_ADMIN:$STALWART_PASS" -H 'content-type: application/json')
[[ "${STALWART_INSECURE:-0}" == "1" ]] && CURL_OPTS+=(-k)
[[ -n "${STALWART_CURL_EXTRA:-}" ]] && read -r -a extra <<<"$STALWART_CURL_EXTRA" && CURL_OPTS+=("${extra[@]}")

# Llama a la API JMAP con una lista de methodCalls (JSON) y devuelve la respuesta.
jmap() {
  local out
  if ! out="$(curl "${CURL_OPTS[@]}" "$STALWART_URL/jmap/" \
      -d "{\"using\":[\"urn:ietf:params:jmap:core\"],\"methodCalls\":$1}" 2>&1)"; then
    echo "Error de API: ${out:-sin respuesta}. Revisa STALWART_URL, STALWART_ADMIN y STALWART_PASS." >&2
    exit 1
  fi
  printf '%s' "$out"
}

# Procesa la respuesta JMAP con un fragmento de Python que recibe 'r' (lista de respuestas).
py() { python3 -c "import json,sys
raw=sys.stdin.read()
if not raw.strip(): sys.exit(1)
r=json.loads(raw)['methodResponses']
$1"; }

# Devuelve el id interno de un dominio por nombre.
domain_id() {
  jmap '[["x:Domain/get",{"accountId":"b","properties":["name"]},"0"]]' |
    DOMAIN="$1" py "
import os
ids=[d['id'] for d in r[0][1]['list'] if d['name']==os.environ['DOMAIN']]
print(ids[0] if ids else '')"
}

# Devuelve el id interno de un buzón por dirección.
account_id() {
  jmap '[["x:Account/get",{"accountId":"b","properties":["emailAddress"]},"0"]]' |
    ADDR="$1" py "
import os
ids=[a['id'] for a in r[0][1]['list'] if a.get('emailAddress')==os.environ['ADDR']]
print(ids[0] if ids else '')"
}

# Verifica que una respuesta /set no traiga errores.
check_set() {
  py "
res=r[0][1]
errs={**res.get('notCreated',{}),**res.get('notUpdated',{}),**res.get('notDestroyed',{})}
if errs: print('Error:', json.dumps(errs, ensure_ascii=False)); sys.exit(1)
print('OK')"
}

json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  domains)
    jmap '[["x:Domain/get",{"accountId":"b","properties":["name"]},"0"]]' |
      py "print('\n'.join(sorted(d['name'] for d in r[0][1]['list'])))"
    ;;
  add-domain)
    d="${1:?Uso: add-domain <dominio>}"
    jmap "[[\"x:Domain/set\",{\"accountId\":\"b\",\"create\":{\"n\":{\"name\":$(json_str "$d")}}},\"0\"]]" | check_set
    echo "Ahora publica sus registros DNS: ./admin.sh zone $d"
    ;;
  zone)
    d="${1:?Uso: zone <dominio>}"; id="$(domain_id "$d")"
    [[ -n "$id" ]] || { echo "Dominio no encontrado: $d" >&2; exit 1; }
    jmap "[[\"x:Domain/get\",{\"accountId\":\"b\",\"ids\":[\"$id\"],\"properties\":[\"dnsZoneFile\"]},\"0\"]]" |
      py "print(r[0][1]['list'][0].get('dnsZoneFile') or 'Sin datos de zona (revisa el panel: Domains > ... > View Zone File)')"
    ;;
  users)
    jmap '[["x:Account/get",{"accountId":"b","properties":["emailAddress","description","@type"]},"0"]]' |
      py "print('\n'.join(sorted(a.get('emailAddress','?')+'  '+(a.get('description') or '') for a in r[0][1]['list'])))"
    ;;
  add-user)
    addr="${1:?Uso: add-user <correo> <clave> [nombre]}"; pass="${2:?Falta la clave}"; name="${3:-}"
    user="${addr%@*}"; d="${addr#*@}"; id="$(domain_id "$d")"
    [[ -n "$id" ]] || { echo "Primero crea el dominio: ./admin.sh add-domain $d" >&2; exit 1; }
    jmap "[[\"x:Account/set\",{\"accountId\":\"b\",\"create\":{\"n\":{\"@type\":\"User\",\"name\":$(json_str "$user"),\"domainId\":\"$id\",\"description\":$(json_str "$name"),\"roles\":{\"@type\":\"User\"},\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":$(json_str "$pass")}}}}},\"0\"]]" | check_set
    ;;
  passwd)
    addr="${1:?Uso: passwd <correo> <clave>}"; pass="${2:?Falta la clave}"; id="$(account_id "$addr")"
    [[ -n "$id" ]] || { echo "Buzón no encontrado: $addr" >&2; exit 1; }
    jmap "[[\"x:Account/set\",{\"accountId\":\"b\",\"update\":{\"$id\":{\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":$(json_str "$pass")}}}}},\"0\"]]" | check_set
    ;;
  del-user)
    addr="${1:?Uso: del-user <correo>}"; id="$(account_id "$addr")"
    [[ -n "$id" ]] || { echo "Buzón no encontrado: $addr" >&2; exit 1; }
    jmap "[[\"x:Account/set\",{\"accountId\":\"b\",\"destroy\":[\"$id\"]},\"0\"]]" | check_set
    ;;
  *)
    sed -n '2,17p' "$0"; exit 1 ;;
esac
