# parcel-tracker-pi System Dependencies

This document explains how the Pi runtime depends on the other parcel tracker repositories.

## Where this repo sits in the system

`parcel-tracker-pi` is the event producer.
It is the only repository that runs directly on the Raspberry Pi device.

High-level flow:

1. Collect sensor and modem data on device.
2. Build contract-compliant raw event payloads.
3. Send payloads to Convex `POST /ingest`.

## Direct dependencies

1. `parcel-tracker-contract`
- Source of truth for payload envelope fields and event-specific rules.
- Runtime env key `CONTRACT_VERSION` must stay compatible with backend expectations.

2. `parcel-tracker-convex`
- Ingest destination for runtime payloads (`INGEST_URL`).
- Backend validates contract compatibility and event semantics.

## Indirect dependencies

1. `TrackerDashboard`
- Not called directly by Pi runtime.
- Dashboard output quality depends on the data quality this runtime emits.

## Contract responsibilities in this repo

This repo must emit events that remain compatible with:

1. Contract version policy
- `contractVersion` must be semver.
- Backend currently enforces compatible major version.

2. Event semantics
- `gps_fix` requires `location.method = gnss`.
- `gps_cell_fallback` requires CLBS-specific location fields.
- `ble_scan` and `rfid_scan` require `beaconId`.

## Runtime settings that affect compatibility

Primary compatibility keys in `runtime/config/location.env.example`:

- `CONTRACT_VERSION`
- `INGEST_URL`
- `LBS_ENABLED`
- `LBS_MAX_ACCURACY_M`
- `LBS_ALLOW_ZERO_COORDS`
- `NOFIX_GNSS_POWER_REASSERT_EVERY`
- `NOFIX_COLDSTART_AFTER`

These settings change what events are produced and what location metadata is present.

## Typical failure modes and where to debug

1. Backend returns 4xx on ingest
- Likely contract mismatch or missing required field.
- Check Pi service logs and compare payload against contract schema.

2. Backend accepts events but map has little/no movement
- Pi may be indoors and emitting `gps_no_fix`/heartbeats.
- Check GNSS and CLBS fallback behavior.

3. Duplicate events are not visible as new rows
- Expected behavior: backend deduplicates by `eventId` for idempotency.

## Upgrade coordination checklist

When changing event shape or semantics:

1. Update `parcel-tracker-contract` first.
2. Update `parcel-tracker-convex` validation and deploy backend.
3. Update this repo emit logic and env defaults.
4. Roll out Pi services.
5. Validate dashboard output in `TrackerDashboard`.

## Related files in this repo

- `runtime/location_uplink.py`
- `runtime/ble_uplink.py`
- `runtime/rfid_uplink.py`
- `runtime/config/location.env.example`
