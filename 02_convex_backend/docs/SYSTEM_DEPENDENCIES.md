# parcel-tracker-convex System Dependencies

This document explains how the Convex backend depends on and serves the other parcel tracker repositories.

## Where this repo sits in the system

`parcel-tracker-convex` is the ingest and storage backend.
It is the central runtime dependency between Pi producers and dashboard consumers.

High-level flow:

1. `parcel-tracker-pi` sends raw events to `POST /ingest`.
2. This backend validates and stores events in `raw_events`.
3. This backend updates tracker liveness in `tracker_liveness`.
4. `TrackerDashboard` reads through public Convex queries.

## Direct dependencies

1. `parcel-tracker-contract`
- Contract version + event semantics reference.
- Validation in `convex/ingest.ts` must stay aligned with contract expectations.

2. `parcel-tracker-pi`
- Producer behavior determines event volume, field quality, and edge cases.
- Backend must remain robust to retries and mixed event types.

3. `TrackerDashboard`
- Consumer expectations influence query design and shape stability.
- Query outputs should remain compatible during backend evolution.

## Contract enforcement responsibilities in this repo

This backend enforces three gates:

1. Contract compatibility
- `contractVersion` semver format.
- `major` must match configured compatible major.

2. Event semantics
- `gps_fix`, `gps_cell_fallback`, `ble_scan`, and `rfid_scan` conditional requirements.

3. Idempotency
- Duplicate `eventId` accepted as retry without duplicate `raw_events` insert.

## External interfaces provided by this repo

1. HTTP routes (`.site`)
- `POST /ingest`
- `GET /contract/version`

2. Public query APIs (`.cloud`)
- `queries:getTrackerEventHistory`
- `queries:listRecentRawEvents`
- `queries:listTrackerLiveness`
- `queries:getEventsByType`
- `queries:getBeaconHistory`
- plus discovery/support queries

## Upgrade coordination checklist

When changing contract or event semantics:

1. Update `parcel-tracker-contract` schema/version.
2. Update this repo validation and deploy.
3. Update `parcel-tracker-pi` payload generation.
4. Verify dashboard parsing/visualization in `TrackerDashboard`.
