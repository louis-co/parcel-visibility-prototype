#!/bin/bash
set -euo pipefail

PORT=${LTE_AT_PORT:-/dev/serial/by-id/usb-QualComm_QualComm_Compo_000000000001-if06}
[[ -e "$PORT" ]] || PORT=${LTE_AT_PORT_FALLBACK:-/dev/ttyACM2}
PIN=${LTE_SIM_PIN:-8513}
APN=${LTE_APN:-gprs.swisscom.ch}

# Ensure Tailscale daemon is up on boot for remote access over SIM.
if systemctl list-unit-files | grep -q '^tailscaled\.service'; then
  systemctl enable tailscaled >/dev/null 2>&1 || true
  systemctl start tailscaled >/dev/null 2>&1 || true
fi

# Wait for the modem device node to appear
for i in {1..30}; do
  [[ -e "$PORT" ]] && break
  sleep 1
done
[[ -e "$PORT" ]] || exit 1

stty -F "$PORT" 115200 raw -echo

# Send AT and read response with a hard timeout (prevents hanging)
at() {
  local cmd="$1"
  printf '%s\r' "$cmd" > "$PORT"
  timeout 1.2 cat "$PORT" 2>/dev/null || true
}

# Basic sync
for i in {1..5}; do
  r="$(at "AT")"
  echo "$r" | grep -q "OK" && break
  sleep 1
done

# Check SIM state
r="$(at "AT+CPIN?")"
if echo "$r" | grep -q "SIM PIN"; then
  at "AT+CPIN=$PIN" >/dev/null
  sleep 3
fi

# Configure APN (idempotent)
at "AT+CGDCONT=1,\"IP\",\"$APN\"" >/dev/null

# Bring up data stack (idempotent)
at "AT+NETOPEN" >/dev/null || true
sleep 2
at "AT+NETOPEN?" >/dev/null || true
at "AT+CGPADDR=1" >/dev/null || true

# DNS self-heal for SIM-only operation.
# If usb0 is default route, enforce deterministic resolv.conf order.
GW=$(ip route | awk '/default .* usb0/ {print $3; exit}')
if [[ -n "${GW:-}" ]]; then
  {
    echo '# Managed by lte-init'
    echo "nameserver $GW"
    echo 'nameserver 1.1.1.1'
    echo 'nameserver 8.8.8.8'
  } > /etc/resolv.conf
  chmod 644 /etc/resolv.conf
fi

exit 0
