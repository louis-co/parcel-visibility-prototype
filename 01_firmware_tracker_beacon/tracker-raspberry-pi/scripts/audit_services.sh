#!/usr/bin/env bash
set -euo pipefail

services=(
  location_uplink
  ble_receiver
  rfid_uplink
  resource_monitor
  lte-init
  ModemManager
  NetworkManager
  tailscaled
)

echo "== Active / Enabled =="
for s in "${services[@]}"; do
  active=$(systemctl is-active "${s}.service" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "${s}.service" 2>/dev/null || true)
  printf "%-16s active=%-8s enabled=%s\n" "$s" "$active" "$enabled"
done

echo
echo "== Running units =="
systemctl list-units --type=service --state=running | egrep -i 'location_uplink|ble_receiver|rfid_uplink|resource_monitor|lte-init|ModemManager|NetworkManager|tailscaled' || true

echo
echo "== Recent logs =="
for s in location_uplink ble_receiver rfid_uplink resource_monitor lte-init; do
  echo "--- ${s}.service ---"
  journalctl -u "${s}.service" -n 30 --no-pager || true
  echo
done

echo
echo "== Local health log tail =="
tail -n 30 /var/log/parcel-tracker/health.log 2>/dev/null || true
