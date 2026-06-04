# Tracker and Beacon Firmware

This folder contains the device-side implementation for the parcel visibility prototype. It includes the Raspberry Pi tracker runtime and the ESP32-C3 BLE beacon firmware variants.

## Contents

- `tracker-raspberry-pi/` contains the Raspberry Pi runtime services for GNSS/cellular fallback, BLE scanning, RFID scanning, LTE modem initialization, and local resource monitoring.
- `beacon_esp32c3/` contains PlatformIO firmware for Seeed Studio XIAO ESP32-C3 BLE beacons.

## Tracker Runtime

The tracker runtime sends contract-compatible raw events to the Convex backend through `POST /ingest`.

Main emitted event types:

- `heartbeat`
- `gps_fix`
- `gps_no_fix`
- `gps_cell_fallback`
- `ble_scan`
- `rfid_scan`

See `tracker-raspberry-pi/README.md` for installation, service setup, environment files, and smoke-test instructions.

## BLE Beacon Firmware

The beacon firmware uses a UUID v2 BLE manufacturer-data payload that the Raspberry Pi BLE scanner converts into backend-facing IDs shaped as `ble:<beaconUuid>`.

Included variants:

- `beacon_esp32c3/variants/single-beacon-uuid-v2/` for ordinary single-beacon operation.
- `beacon_esp32c3/variants/density-test-60-uuid-v2/` for density and coexistence tests that simulate many BLE identities from one device.

See `beacon_esp32c3/README.md` and the variant-level READMEs for PlatformIO build and flash commands.

## Relationship to Other Folders

- `02_convex_backend` receives and stores events from the tracker runtime.
- `03_tracker_dashboard` visualizes the events stored by the backend.
- `04event_contract` defines the shared event envelope and event-specific rules.
- `99_eval_tests` contains test evidence generated from these firmware/runtime components.
