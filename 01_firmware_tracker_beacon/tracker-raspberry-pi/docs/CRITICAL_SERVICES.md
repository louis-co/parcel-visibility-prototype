# Critical Service Chain (Pi)

This document captures what is required on the tracker Pi for end-to-end ingestion.

Observed live on `tracker` on 2026-02-16:

## Enabled at startup

- `location_uplink.service`
- `ble_receiver.service`
- `rfid_uplink.service`
- `resource_monitor.service`
- `lte-init.service`
- `ModemManager.service`
- `NetworkManager.service`
- `NetworkManager-dispatcher.service`
- `NetworkManager-wait-online.service`
- `tailscaled.service`

## Currently running

- `location_uplink.service`
- `ble_receiver.service`
- `resource_monitor.service`
- `ModemManager.service`
- `NetworkManager.service`
- `tailscaled.service`

`rfid_uplink.service` is enabled but runs only when `/dev/rfid_reader` exists.

## Service roles

1. `lte-init.service`
- One-shot modem bootstrap on boot.
- Unlocks SIM (if required), applies APN, opens data stack, and repairs DNS for SIM route.

2. `location_uplink.service`
- Sends GPS/triangulation/LBS/heartbeat events to Convex `/ingest`.

3. `ble_receiver.service`
- Sends `ble_scan` events to Convex `/ingest`.

4. `rfid_uplink.service`
- Sends `rfid_scan` events to Convex `/ingest`.
- Auto-starts when reader appears through udev rule creating `/dev/rfid_reader`.

5. `ModemManager.service` + `NetworkManager.service`
- Keep LTE modem and network stack managed.

6. `resource_monitor.service`
- Writes local resource and error snapshots to `/var/log/parcel-tracker/health.log`.

7. `tailscaled.service`
- Remote access path for maintenance and debugging over cellular network.

## Boot and dependency notes

- `location_uplink` and `ble_receiver` depend on network-online target.
- `rfid_uplink` additionally depends on `dev-rfid_reader.device` and `ConditionPathExists=/dev/rfid_reader`.
- `lte-init` runs once and remains in exited-success state.

## Quick health checks

```bash
systemctl is-active location_uplink.service ble_receiver.service rfid_uplink.service lte-init.service resource_monitor.service
systemctl is-enabled location_uplink.service ble_receiver.service rfid_uplink.service lte-init.service resource_monitor.service
sudo journalctl -u location_uplink.service -n 100 --no-pager
sudo journalctl -u ble_receiver.service -n 100 --no-pager
sudo journalctl -u rfid_uplink.service -n 100 --no-pager
sudo journalctl -u lte-init.service -n 100 --no-pager
sudo journalctl -u resource_monitor.service -n 100 --no-pager
sudo tail -n 100 /var/log/parcel-tracker/health.log
sudo /opt/parcel-tracker-pi/scripts/smoke_test_no_rfid.sh
```
