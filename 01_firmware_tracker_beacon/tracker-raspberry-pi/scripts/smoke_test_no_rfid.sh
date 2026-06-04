#!/usr/bin/env bash
set -euo pipefail

LOOKBACK_MIN="${LOOKBACK_MIN:-10}"
EXPECT_BLE_EVENTS="${EXPECT_BLE_EVENTS:-1}"
MIN_LOCATION_SENDS="${MIN_LOCATION_SENDS:-8}"
MAX_HEALTH_LOG_AGE_SEC="${MAX_HEALTH_LOG_AGE_SEC:-180}"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

check_service_active_enabled() {
  local svc="$1"
  local active enabled
  active="$(systemctl is-active "${svc}" 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "${svc}" 2>/dev/null || true)"
  [[ "$active" == "active" ]] || fail "${svc} is not active (got: ${active})"
  [[ "$enabled" == "enabled" ]] || fail "${svc} is not enabled (got: ${enabled})"
  pass "${svc} active+enabled"
}

echo "== Core service checks =="
check_service_active_enabled location_uplink.service
check_service_active_enabled ble_receiver.service
check_service_active_enabled resource_monitor.service
check_service_active_enabled lte-init.service

rfid_enabled="$(systemctl is-enabled rfid_uplink.service 2>/dev/null || true)"
[[ "$rfid_enabled" == "enabled" ]] || fail "rfid_uplink.service must be enabled"
if [[ -e /dev/rfid_reader ]]; then
  rfid_active="$(systemctl is-active rfid_uplink.service 2>/dev/null || true)"
  [[ "$rfid_active" == "active" ]] || fail "RFID reader present but rfid_uplink.service not active"
  pass "RFID reader present and rfid_uplink active"
else
  pass "RFID reader absent and service enabled (expected for no-RFID test)"
fi

echo
echo "== Ingest endpoint health =="
if [[ -f /etc/default/location_uplink ]]; then
  # shellcheck disable=SC1091
  source /etc/default/location_uplink
else
  fail "/etc/default/location_uplink missing"
fi

[[ -n "${INGEST_URL:-}" ]] || fail "INGEST_URL missing in /etc/default/location_uplink"
base_url="${INGEST_URL%/ingest}"
contract_resp="$(curl -sS -w $'\n%{http_code}' "${base_url}/contract/version")"
contract_status="${contract_resp##*$'\n'}"
[[ "$contract_status" == "200" ]] || fail "contract/version check failed (status=${contract_status})"
pass "Convex contract/version reachable"

echo
echo "== Event flow checks (${LOOKBACK_MIN} min window) =="
location_sent="$(journalctl -u location_uplink.service --since "-${LOOKBACK_MIN} min" --no-pager | grep -c 'sent eventId' || true)"
[[ "$location_sent" -ge "$MIN_LOCATION_SENDS" ]] || fail "location_uplink low event volume (${location_sent} < ${MIN_LOCATION_SENDS})"
pass "location_uplink sent ${location_sent} events"

if [[ "$EXPECT_BLE_EVENTS" == "1" ]]; then
  ble_sent="$(journalctl -u ble_receiver.service --since "-${LOOKBACK_MIN} min" --no-pager | grep -c 'sent beaconId' || true)"
  [[ "$ble_sent" -ge 1 ]] || fail "no BLE events in last ${LOOKBACK_MIN} min"
  pass "BLE events observed (${ble_sent})"
else
  echo "INFO: BLE event count check skipped (EXPECT_BLE_EVENTS=${EXPECT_BLE_EVENTS})"
fi

echo
echo "== Resource monitor freshness =="
health_log="/var/log/parcel-tracker/health.log"
[[ -f "$health_log" ]] || fail "${health_log} missing"
last_update_epoch="$(stat -c %Y "$health_log")"
now_epoch="$(date +%s)"
age_sec=$((now_epoch - last_update_epoch))
[[ "$age_sec" -le "$MAX_HEALTH_LOG_AGE_SEC" ]] || fail "health log is stale (${age_sec}s > ${MAX_HEALTH_LOG_AGE_SEC}s)"
pass "health log fresh (${age_sec}s old)"

echo
echo "PASS: no-RFID smoke test completed"
