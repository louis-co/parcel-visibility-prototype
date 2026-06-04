# parcel-tracker-pi

Raspberry Pi runtime for parcel tracker ingestion into Convex.

## Installed modem HAT (documented)

Based on runtime config, AT command usage, and captured modem identity logs, this Pi is using a SIM7670-series cellular/GNSS board:

- Detected modem module: `SIM7670G-MNGV` (from `mmcli` output on the Pi)
- HAT family used by this repo: SIM7670G LTE Cat-1/GNSS HAT for Raspberry Pi

Primary documentation:

- Waveshare wiki (board bring-up, pinout, UART/USB modes, GNSS examples):
  - https://www.waveshare.com/wiki/SIM7670G_LTE_Cat-1/GNSS_HAT
- Waveshare product page (hardware feature overview):
  - https://www.waveshare.com/sim7670g-lte-cat-1-gnss-hat.htm
- SIMCom A76XX documentation entry (AT command manual + GNSS/LBS notes for the module family):
  - https://en.simcom.com/product/A7672G.html

Quick verification commands on the Pi:

```bash
mmcli -L
mmcli -m 0
# Optional direct AT identity query (adjust AT port if needed):
printf 'AT+CGMM\r' > /dev/ttyACM2 && timeout 1.5 cat /dev/ttyACM2
```

This runtime uses four main runtime services:
- `location_uplink.py` (GNSS + SIM7670 LBS fallback)
- `ble_uplink.py` (BLE beacon scans -> unified `/ingest`)
- `rfid_uplink.py` (RFID scans -> unified `/ingest`)
- `resource_monitor.sh` (local resource + error logging)

The location, BLE, and RFID uplink services emit the same raw envelope contract and post to:
- `POST /ingest` on Convex

## What changed

BLE and RFID are fully migrated to the unified ingest path.
No legacy `/ble` or `/rfid` backend route is required for new runtime files in this repo.

## Repo layout

- `runtime/location_uplink.py`
- `runtime/ble_uplink.py`
- `runtime/rfid_uplink.py`
- `runtime/resource_monitor.sh`
- `runtime/lte-init.sh`
- `runtime/location_uplink.service`
- `runtime/ble_receiver.service`
- `runtime/rfid_uplink.service`
- `runtime/resource_monitor.service`
- `runtime/lte-init.service`
- `runtime/config/location.env.example`
- `runtime/config/ble.env.example`
- `runtime/config/rfid.env.example`
- `runtime/config/resource_monitor.env.example`
- `runtime/config/99-rfid-hid.rules`
- `runtime/requirements.txt`
- `docs/CRITICAL_SERVICES.md`
- `scripts/audit_services.sh`
- `scripts/smoke_test_no_rfid.sh`

## Runtime behavior

### Location uplink

Priority order (highest to lowest):
1. GNSS (real GPS fix from satellites)
2. CLBS provider lookup from the modem/network (`AT+CLBS=1,1`, fallback `AT+CLBS=4,1`)
3. No fix (if neither source can provide an acceptable location)

In each cycle, the runtime picks the first method that works.

#### No-GNSS backup details (tiered fallback from Pi point of view)

From this runtime's point of view (`runtime/location_uplink.py`):

1. Pi asks modem for GNSS first:
- `AT+CGPSINFO`, then fallback `AT+CGNSSINFO`
2. If GNSS has no usable fix, Pi runs native provider LBS fallback:
- `AT+CLBS=1,1`, then fallback `AT+CLBS=4,1`
- Accepts only if `accuracyM <= LBS_MAX_ACCURACY_M` (default `1000m`)
3. Event emitted when fallback succeeds:
- `gps_cell_fallback` with:
  - `location.method = cell_lbs_native`
  - `location.source = sim7670_clbs`
  - `location.accuracyM`
4. If neither GNSS nor acceptable fallback result is available:
- Pi emits `gps_no_fix`

#### GNSS recovery controls during repeated no-fix cycles

To improve recovery after repeated indoor/no-signal cycles, the runtime includes two controls:

1. `NOFIX_GNSS_POWER_REASSERT_EVERY`
- Reasserts modem GNSS power (`AT+CGNSSPWR=1`) every N consecutive no-fix cycles.
- Set `0` to disable.

2. `NOFIX_COLDSTART_AFTER`
- Runs GNSS cold start (`AT+CGPSCOLD`) once no-fix streak reaches N.
- Resets no-fix streak after cold start.
- Set `0` to disable.

LBS safety control:

3. `LBS_ALLOW_ZERO_COORDS`
- Default `false`.
- When `false`, CLBS responses at exactly `0,0` are ignored as invalid fallback location.

### BLE uplink

1. Scans advertisements with Bleak.
2. Parses manufacturer data using configured company ID.
3. Emits `ble_scan` with:
   - `beaconId = ble:<parsed_id>`
   - optional RSSI in `signal.rssi`
4. Cooldown suppresses rapid duplicates.

### RFID uplink

1. Reads HID frames from configured reader device.
2. Extracts EPC and emits `rfid_scan` with:
   - `beaconId = rfid:<EPC>`
3. Cooldown suppresses rapid duplicates.

### Resource monitor

1. Every interval (default `60s`) logs host resources to local file:
   - uptime + load averages
   - CPU busy percent + current CPU frequency (MHz)
   - memory usage (`used`, `available`, `free`)
   - swap usage
   - disk usage (`/`) + inode usage (`/`)
   - CPU temperature (if exposed)
   - default route interface/gateway/IP
   - network bytes + per-second rates on default route interface
   - Raspberry Pi throttle/undervoltage flags (`vcgencmd get_throttled`)
2. Logs active/enabled states for critical services.
3. Scrapes new `journalctl` errors (`err..alert`) for critical units and appends them to the same log file.
4. Health log file location:
   - `/var/log/parcel-tracker/health.log`
5. Example checks:
   - `sudo tail -f /var/log/parcel-tracker/health.log`
   - `sudo grep -E 'resource_snapshot|journal_error|service_state' /var/log/parcel-tracker/health.log | tail -n 50`

## Install on Pi

```bash
sudo apt-get update
sudo apt-get install -y python3-serial python3-pip
python3 -m pip install --user -r /opt/parcel-tracker-pi/runtime/requirements.txt
```

Install service files:

```bash
sudo install -m 0644 /opt/parcel-tracker-pi/runtime/location_uplink.service /etc/systemd/system/location_uplink.service
sudo install -m 0644 /opt/parcel-tracker-pi/runtime/ble_receiver.service /etc/systemd/system/ble_receiver.service
sudo install -m 0644 /opt/parcel-tracker-pi/runtime/rfid_uplink.service /etc/systemd/system/rfid_uplink.service
sudo install -m 0755 /opt/parcel-tracker-pi/runtime/resource_monitor.sh /usr/local/bin/resource_monitor.sh
sudo install -m 0644 /opt/parcel-tracker-pi/runtime/resource_monitor.service /etc/systemd/system/resource_monitor.service
sudo install -m 0755 /opt/parcel-tracker-pi/runtime/lte-init.sh /usr/local/bin/lte-init.sh
sudo install -m 0644 /opt/parcel-tracker-pi/runtime/lte-init.service /etc/systemd/system/lte-init.service
```

Install env files:

```bash
sudo cp /opt/parcel-tracker-pi/runtime/config/location.env.example /etc/default/location_uplink
sudo cp /opt/parcel-tracker-pi/runtime/config/ble.env.example /etc/default/ble_uplink
sudo cp /opt/parcel-tracker-pi/runtime/config/rfid.env.example /etc/default/rfid_uplink
sudo cp /opt/parcel-tracker-pi/runtime/config/resource_monitor.env.example /etc/default/resource_monitor
```

Install udev hotplug rule for RFID:

```bash
sudo install -m 0644 /opt/parcel-tracker-pi/runtime/config/99-rfid-hid.rules /etc/udev/rules.d/99-rfid-hid.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Enable services:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lte-init.service
sudo systemctl enable --now location_uplink.service
sudo systemctl enable --now ble_receiver.service
sudo systemctl enable --now rfid_uplink.service
sudo systemctl enable --now resource_monitor.service
```

## One-line update command on Pi

```bash
git -C /opt/parcel-tracker-pi pull --ff-only origin main && sudo install -m 0755 /opt/parcel-tracker-pi/runtime/lte-init.sh /usr/local/bin/lte-init.sh && sudo install -m 0644 /opt/parcel-tracker-pi/runtime/lte-init.service /etc/systemd/system/lte-init.service && sudo install -m 0755 /opt/parcel-tracker-pi/runtime/resource_monitor.sh /usr/local/bin/resource_monitor.sh && sudo install -m 0644 /opt/parcel-tracker-pi/runtime/resource_monitor.service /etc/systemd/system/resource_monitor.service && sudo systemctl daemon-reload && sudo systemctl restart lte-init.service location_uplink.service ble_receiver.service rfid_uplink.service resource_monitor.service
```

## Log checks

```bash
sudo journalctl -u location_uplink.service -f
sudo journalctl -u ble_receiver.service -f
sudo journalctl -u rfid_uplink.service -f
sudo journalctl -u resource_monitor.service -f
sudo tail -f /var/log/parcel-tracker/health.log
```

Expected:
- repeated `status=200` sends
- no watchdog restart loops

## Current operational target

All services should point to:
- `https://your-deployment.convex.site/ingest`

## Troubleshooting

1. BLE service starts but no events
- Check Bluetooth stack and beacon company ID.
- Verify `BLE_COMPANY_ID` in `/etc/default/ble_uplink`.

2. RFID service starts but no events
- Verify `RFID_DEVICE` exists and permissions are correct.
- Confirm udev rule still maps reader to `/dev/rfid_reader`.
- If reader is unplugged, `rfid_uplink.service` remains inactive by design.
- As soon as reader is plugged back in, udev starts `rfid_uplink.service` automatically.

### RFID hotplug design

- Stable device path: `/dev/rfid_reader`
- Port independence: matched by USB VID/PID, not physical USB port number
- Auto-start on plug: udev rule emits `SYSTEMD_WANTS=rfid_uplink.service`
- Auto-stop on removal: service is bound to `dev-rfid_reader.device`

3. 4xx from ingest
- Check `CONTRACT_VERSION`, required fields, and event formatting.
- Tail logs to inspect payload-level errors.

4. Watchdog restarts
- Confirm latest scripts are deployed from this repo.
- Confirm service files match this repo versions.

5. Need a quick critical-chain snapshot
- Run `/opt/parcel-tracker-pi/scripts/audit_services.sh`
- See startup/service expectations in `docs/CRITICAL_SERVICES.md`

## No-RFID smoke test (with BLE beacon)

If you do not have the RFID reader connected, you can still run a full core-chain smoke test.

What it checks:
1. Core services active and enabled (`location`, `BLE`, `LTE init`, `resource monitor`)
2. RFID service enabled (and inactive is accepted when reader is absent)
3. Convex contract endpoint reachable from Pi
4. Recent location event flow in journals
5. BLE event flow in journals (optional check)
6. Resource monitor health log freshness

Run on Pi:

```bash
sudo /opt/parcel-tracker-pi/scripts/smoke_test_no_rfid.sh
```

If BLE beacon is temporarily not in range:

```bash
sudo EXPECT_BLE_EVENTS=0 /opt/parcel-tracker-pi/scripts/smoke_test_no_rfid.sh
```

## Cross-Repo Dependencies

This runtime is one part of a 4-repository system:

1. `parcel-tracker-pi` (this repo)
- Produces contract-compliant raw events (`heartbeat`, `gps_fix`, `gps_no_fix`, `gps_cell_fallback`, `ble_scan`, `rfid_scan`).

2. `parcel-tracker-contract`
- Defines the event envelope schema and contract version rules that this runtime must emit.

3. `parcel-tracker-convex`
- Receives events at `POST /ingest`, validates contract semantics, and stores accepted events.

4. `TrackerDashboard`
- Reads Convex query output and visualizes these events for operators.

Detailed integration notes are documented in:
- `docs/SYSTEM_DEPENDENCIES.md`
