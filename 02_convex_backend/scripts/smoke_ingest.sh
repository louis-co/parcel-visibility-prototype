#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${CONVEX_BASE_URL:-}}"
if [[ -z "${BASE_URL}" ]]; then
  echo "Usage: $0 <convex-base-url>"
  echo "Example: $0 https://your-deployment.convex.site"
  exit 1
fi

BASE_URL="${BASE_URL%/}"
TRACKER_ID="${TRACKER_ID:-smoke-tracker-01}"
CONTRACT_VERSION="${CONTRACT_VERSION:-1.0.0}"

now_ms=$(( $(date +%s) * 1000 ))
if command -v uuidgen >/dev/null 2>&1; then
  event_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
else
  event_id="smoke-${now_ms}"
fi

payload=$(cat <<JSON
{
  "eventId": "${event_id}",
  "contractVersion": "${CONTRACT_VERSION}",
  "trackerId": "${TRACKER_ID}",
  "eventType": "heartbeat",
  "trackerTsMs": ${now_ms},
  "seq": ${now_ms},
  "status": { "locationMode": "no_fix" }
}
JSON
)

request_with_status() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  if [[ "$method" == "GET" ]]; then
    curl -sS -w $'\n%{http_code}' "$url"
  else
    curl -sS -w $'\n%{http_code}' -X "$method" -H "content-type: application/json" -d "$body" "$url"
  fi
}

print_result() {
  local label="$1"
  local response="$2"
  local body status
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  echo "${label}: status=${status} body=${body}"
}

echo "[1/4] contract endpoint"
contract_resp="$(request_with_status GET "${BASE_URL}/contract/version")"
print_result "contract/version" "$contract_resp"
[[ "${contract_resp##*$'\n'}" == "200" ]] || { echo "FAIL: contract/version is not 200"; exit 1; }

echo "[2/4] ingest first event"
first_resp="$(request_with_status POST "${BASE_URL}/ingest" "$payload")"
print_result "ingest#1" "$first_resp"
[[ "${first_resp##*$'\n'}" == "200" ]] || { echo "FAIL: first ingest is not 200"; exit 1; }
echo "${first_resp%$'\n'*}" | grep -q '"ok":true' || { echo "FAIL: first ingest missing ok=true"; exit 1; }
echo "${first_resp%$'\n'*}" | grep -q '"duplicate":false' || { echo "FAIL: first ingest expected duplicate=false"; exit 1; }

echo "[3/4] ingest duplicate eventId"
second_resp="$(request_with_status POST "${BASE_URL}/ingest" "$payload")"
print_result "ingest#2" "$second_resp"
[[ "${second_resp##*$'\n'}" == "200" ]] || { echo "FAIL: second ingest is not 200"; exit 1; }
echo "${second_resp%$'\n'*}" | grep -q '"ok":true' || { echo "FAIL: second ingest missing ok=true"; exit 1; }
echo "${second_resp%$'\n'*}" | grep -q '"duplicate":true' || { echo "FAIL: second ingest expected duplicate=true"; exit 1; }

echo "[4/4] invalid payload check"
invalid_resp="$(request_with_status POST "${BASE_URL}/ingest" '{}')"
print_result "ingest_invalid" "$invalid_resp"
[[ "${invalid_resp##*$'\n'}" == "400" ]] || { echo "FAIL: invalid payload did not return 400"; exit 1; }

echo "PASS: Convex ingest smoke test completed"
