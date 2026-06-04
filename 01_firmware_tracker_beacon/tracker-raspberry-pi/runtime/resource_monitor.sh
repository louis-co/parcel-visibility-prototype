#!/usr/bin/env bash
set -euo pipefail

INTERVAL_SEC="${MONITOR_INTERVAL_SEC:-60}"
LOG_FILE="${MONITOR_LOG_FILE:-/var/log/parcel-tracker/health.log}"
STATE_FILE="${MONITOR_STATE_FILE:-/var/lib/parcel-tracker/resource_monitor.last_ts}"
JOURNAL_UNITS="${MONITOR_JOURNAL_UNITS:-location_uplink.service ble_receiver.service rfid_uplink.service lte-init.service}"
MAX_JOURNAL_LINES="${MONITOR_MAX_JOURNAL_LINES:-200}"

PREV_CPU_TOTAL=""
PREV_CPU_IDLE=""
PREV_NET_RX=""
PREV_NET_TX=""
PREV_NET_TS=""

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATE_FILE")"
touch "$LOG_FILE"

if [[ ! -f "$STATE_FILE" ]]; then
  date +%s > "$STATE_FILE"
fi

log_line() {
  local msg="$1"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg" >> "$LOG_FILE"
}

snapshot_resources() {
  local uptime_sec loadavg
  local mem_total_kb mem_available_kb mem_free_kb mem_used_kb mem_used_pct
  local swap_total_kb swap_free_kb swap_used_kb swap_used_pct
  local disk_total disk_used disk_avail disk_pct
  local inode_total inode_used inode_avail inode_pct
  local cpu_temp_c cpu_freq_mhz cpu_busy_pct
  local route_if route_gw route_ip
  local net_rx_bytes net_tx_bytes net_rx_rate_bps net_tx_rate_bps now_ts
  local throttled_raw throttled_val
  local uv_now uv_since_boot freqcap_now freqcap_since_boot
  local throttled_now throttled_since_boot softtemp_now softtemp_since_boot
  local c_user c_nice c_system c_idle c_iowait c_irq c_softirq c_steal
  local c_total c_idle_all d_total d_idle

  uptime_sec="$(cut -d' ' -f1 /proc/uptime)"
  loadavg="$(cut -d' ' -f1-3 /proc/loadavg)"

  mem_total_kb="$(awk '/MemTotal:/ {print $2}' /proc/meminfo)"
  mem_free_kb="$(awk '/MemFree:/ {print $2}' /proc/meminfo)"
  mem_available_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
  mem_used_kb=$((mem_total_kb - mem_available_kb))
  mem_used_pct=$((mem_used_kb * 100 / mem_total_kb))

  swap_total_kb="$(awk '/SwapTotal:/ {print $2}' /proc/meminfo)"
  swap_free_kb="$(awk '/SwapFree:/ {print $2}' /proc/meminfo)"
  swap_used_kb=$((swap_total_kb - swap_free_kb))
  if [[ "$swap_total_kb" -gt 0 ]]; then
    swap_used_pct=$((swap_used_kb * 100 / swap_total_kb))
  else
    swap_used_pct=0
  fi

  read -r disk_total disk_used disk_avail disk_pct < <(df -Pk / | awk 'NR==2 {print $2, $3, $4, $5}')
  read -r inode_total inode_used inode_avail inode_pct < <(df -Pi / | awk 'NR==2 {print $2, $3, $4, $5}')

  if [[ -f /sys/class/thermal/thermal_zone0/temp ]]; then
    cpu_temp_c="$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp)"
  else
    cpu_temp_c="na"
  fi

  if [[ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq ]]; then
    cpu_freq_mhz="$(awk '{printf "%.0f", $1/1000}' /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq)"
  else
    cpu_freq_mhz="na"
  fi

  read -r c_user c_nice c_system c_idle c_iowait c_irq c_softirq c_steal _ < <(awk '/^cpu / {print $2, $3, $4, $5, $6, $7, $8, $9}' /proc/stat)
  c_total=$((c_user + c_nice + c_system + c_idle + c_iowait + c_irq + c_softirq + c_steal))
  c_idle_all=$((c_idle + c_iowait))
  if [[ -n "$PREV_CPU_TOTAL" ]]; then
    d_total=$((c_total - PREV_CPU_TOTAL))
    d_idle=$((c_idle_all - PREV_CPU_IDLE))
    if (( d_total > 0 )); then
      cpu_busy_pct="$(awk -v dt="$d_total" -v di="$d_idle" 'BEGIN {printf "%.1f", (dt-di)*100/dt}')"
    else
      cpu_busy_pct="na"
    fi
  else
    cpu_busy_pct="na"
  fi
  PREV_CPU_TOTAL="$c_total"
  PREV_CPU_IDLE="$c_idle_all"

  route_if="$(ip route show default 2>/dev/null | awk 'NR==1 {print $5}')"
  route_gw="$(ip route show default 2>/dev/null | awk 'NR==1 {print $3}')"
  route_ip="na"
  if [[ -n "${route_if:-}" ]]; then
    route_ip="$(ip -4 addr show dev "$route_if" 2>/dev/null | awk '/inet / {print $2; exit}')"
  fi
  route_if="${route_if:-na}"
  route_gw="${route_gw:-na}"
  route_ip="${route_ip:-na}"

  net_rx_bytes="na"
  net_tx_bytes="na"
  net_rx_rate_bps="na"
  net_tx_rate_bps="na"
  now_ts="$(date +%s)"
  if [[ "$route_if" != "na" ]] && [[ -r "/sys/class/net/${route_if}/statistics/rx_bytes" ]] && [[ -r "/sys/class/net/${route_if}/statistics/tx_bytes" ]]; then
    net_rx_bytes="$(cat "/sys/class/net/${route_if}/statistics/rx_bytes")"
    net_tx_bytes="$(cat "/sys/class/net/${route_if}/statistics/tx_bytes")"
    if [[ -n "$PREV_NET_TS" ]] && (( now_ts > PREV_NET_TS )); then
      net_rx_rate_bps=$(( (net_rx_bytes - PREV_NET_RX) / (now_ts - PREV_NET_TS) ))
      net_tx_rate_bps=$(( (net_tx_bytes - PREV_NET_TX) / (now_ts - PREV_NET_TS) ))
      if (( net_rx_rate_bps < 0 )); then net_rx_rate_bps=0; fi
      if (( net_tx_rate_bps < 0 )); then net_tx_rate_bps=0; fi
    fi
    PREV_NET_RX="$net_rx_bytes"
    PREV_NET_TX="$net_tx_bytes"
    PREV_NET_TS="$now_ts"
  fi

  throttled_raw="na"
  uv_now="na"
  uv_since_boot="na"
  freqcap_now="na"
  freqcap_since_boot="na"
  throttled_now="na"
  throttled_since_boot="na"
  softtemp_now="na"
  softtemp_since_boot="na"

  if command -v vcgencmd >/dev/null 2>&1; then
    throttled_raw="$(vcgencmd get_throttled 2>/dev/null | awk -F= '/throttled=/{print $2}')"
    if [[ -n "$throttled_raw" ]]; then
      throttled_val=$((throttled_raw))
      if (( throttled_val & 0x1 )); then uv_now=1; else uv_now=0; fi
      if (( throttled_val & 0x2 )); then freqcap_now=1; else freqcap_now=0; fi
      if (( throttled_val & 0x4 )); then throttled_now=1; else throttled_now=0; fi
      if (( throttled_val & 0x8 )); then softtemp_now=1; else softtemp_now=0; fi
      if (( throttled_val & 0x10000 )); then uv_since_boot=1; else uv_since_boot=0; fi
      if (( throttled_val & 0x20000 )); then freqcap_since_boot=1; else freqcap_since_boot=0; fi
      if (( throttled_val & 0x40000 )); then throttled_since_boot=1; else throttled_since_boot=0; fi
      if (( throttled_val & 0x80000 )); then softtemp_since_boot=1; else softtemp_since_boot=0; fi
    fi
  fi

  log_line "resource_snapshot uptimeSec=${uptime_sec} loadavg=${loadavg} cpuBusyPct=${cpu_busy_pct} cpuFreqMHz=${cpu_freq_mhz} memUsedKb=${mem_used_kb} memUsedPct=${mem_used_pct} memAvailKb=${mem_available_kb} memFreeKb=${mem_free_kb} swapUsedKb=${swap_used_kb} swapUsedPct=${swap_used_pct} diskUsedKb=${disk_used} diskTotalKb=${disk_total} diskAvailKb=${disk_avail} diskUsePct=${disk_pct} inodeUsed=${inode_used} inodeTotal=${inode_total} inodeUsePct=${inode_pct} cpuTempC=${cpu_temp_c} routeIf=${route_if} routeGw=${route_gw} routeIp=${route_ip} netRxBytes=${net_rx_bytes} netTxBytes=${net_tx_bytes} netRxBps=${net_rx_rate_bps} netTxBps=${net_tx_rate_bps} throttledRaw=${throttled_raw} uvNow=${uv_now} uvSinceBoot=${uv_since_boot} freqCapNow=${freqcap_now} freqCapSinceBoot=${freqcap_since_boot} throttledNow=${throttled_now} throttledSinceBoot=${throttled_since_boot} softTempNow=${softtemp_now} softTempSinceBoot=${softtemp_since_boot}"
}

snapshot_service_states() {
  local svc active enabled
  for svc in location_uplink.service ble_receiver.service rfid_uplink.service lte-init.service resource_monitor.service; do
    active="$(systemctl is-active "${svc}" 2>/dev/null || true)"
    enabled="$(systemctl is-enabled "${svc}" 2>/dev/null || true)"
    log_line "service_state unit=${svc} active=${active} enabled=${enabled}"
  done
}

snapshot_journal_errors() {
  local last_ts now_ts
  local -a args
  local unit lines

  last_ts="$(cat "$STATE_FILE" 2>/dev/null || true)"
  if [[ -z "$last_ts" ]]; then
    last_ts="$(date +%s)"
  fi

  now_ts="$(date +%s)"
  if (( now_ts <= last_ts )); then
    echo "$now_ts" > "$STATE_FILE"
    return
  fi

  args=(--since "@${last_ts}" --until "@${now_ts}" -p err..alert --no-pager -o short-iso)
  for unit in $JOURNAL_UNITS; do
    args+=(-u "$unit")
  done

  lines="$(journalctl "${args[@]}" 2>/dev/null | sed '/^-- No entries --$/d' | sed '/^$/d' | tail -n "$MAX_JOURNAL_LINES" || true)"
  if [[ -n "$lines" ]]; then
    log_line "journal_errors_begin from=${last_ts} to=${now_ts}"
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      log_line "journal_error ${line}"
    done <<< "$lines"
    log_line "journal_errors_end"
  fi

  echo "$now_ts" > "$STATE_FILE"
}

log_line "resource_monitor_started intervalSec=${INTERVAL_SEC}"

while true; do
  snapshot_resources
  snapshot_service_states
  snapshot_journal_errors
  sleep "$INTERVAL_SEC"
done
