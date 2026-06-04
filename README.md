# Parcel Visibility Prototype

This repository contains the implementation and evaluation material for a parcel visibility prototype. The system combines BLE beacons, RFID tags, a Raspberry Pi tracker, a Convex backend, and a dashboard for visualizing tracker state and event history.

## Repository Structure

- `01_firmware_tracker_beacon/` contains the device-side code:
  - Raspberry Pi tracker runtime services for GNSS/cellular fallback, BLE, RFID, LTE initialization, and resource monitoring.
  - ESP32-C3 BLE beacon firmware variants for normal beacon operation and density testing.
- `02_convex_backend/` contains the Convex backend:
  - HTTP ingest endpoint.
  - Raw event validation and deduplication.
  - Tracker liveness state.
  - Dashboard-facing query functions.
- `03_tracker_dashboard/` contains the Next.js dashboard:
  - Map-based route visualization.
  - Event and liveness summaries.
  - BLE/RFID activity views.
  - Configurable Convex data source settings.
- `04event_contract/` contains the shared event contract:
  - Contract version.
  - JSON Schema for raw tracker events.
  - Example payloads.
- `99_eval_tests/` contains evaluation evidence:
  - BLE, RFID, road-test, backend, dashboard, and tracker runtime test data.
  - CSV/JSON summaries, rendered figures, and selected raw logs.

## System Flow

1. BLE beacons advertise UUID-like identifiers.
2. The Raspberry Pi tracker reads BLE advertisements, RFID tags, GNSS/cellular location data, and runtime health state.
3. The tracker sends contract-compatible raw events to the Convex backend through `POST /ingest`.
4. Convex validates, deduplicates, stores, and exposes the event data.
5. The dashboard queries Convex and visualizes route, liveness, and event activity.

## Main Event Types

The shared event contract currently covers:

- `heartbeat`
- `gps_fix`
- `gps_no_fix`
- `gps_cell_fallback`
- `ble_scan`
- `rfid_scan`

The active contract version is `1.0.0`.

## Quick Start Pointers

- Start with `01_firmware_tracker_beacon/README.md` for tracker and beacon code.
- Use `02_convex_backend/README.md` for backend setup, deployment, endpoints, and query names.
- Use `03_tracker_dashboard/README.md` for dashboard setup and configuration.
- Use `04event_contract/README.md` for the raw event schema.
- Use `99_eval_tests/README.md` to navigate the evaluation evidence.

## Notes

This repository is organized as a publication-ready bundle rather than a single deployable monorepo. Each numbered implementation folder keeps its own setup instructions and runtime assumptions.
