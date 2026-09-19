#!/usr/bin/env bash
# scripts/lan.sh — run Rasta for phones on the same Wi-Fi: locally trusted https on every LAN address.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"
if ! command -v mkcert >/dev/null; then
  echo "mkcert is not installed. On macOS: brew install mkcert && mkcert -install" >&2; exit 1
fi
mkdir -p data/certs
# every IPv4 address this machine has, plus localhost and its .local name
IPS=$(ifconfig 2>/dev/null | awk '/inet /&&$2!="127.0.0.1"{print $2}' | tr '\n' ' ')
HOSTNAME_LOCAL=$(hostname -s 2>/dev/null || echo rasta).local
NAMES="localhost 127.0.0.1 ::1 $HOSTNAME_LOCAL $IPS"
if [ ! -f data/certs/cert.pem ] || ! openssl x509 -in data/certs/cert.pem -noout -ext subjectAltName 2>/dev/null | grep -q "$(echo $IPS | awk '{print $1}')"; then
  echo "Creating certificate for: $NAMES"
  mkcert -cert-file data/certs/cert.pem -key-file data/certs/key.pem $NAMES
fi
echo
echo "Phones on this Wi-Fi: open one of"
for ip in $IPS; do echo "   https://$ip:$PORT"; done
echo "   https://$HOSTNAME_LOCAL:$PORT"
echo "First time on a phone: trust mkcert's root ($(mkcert -CAROOT)/rootCA.pem) or accept the warning."
echo
exec node server.js
