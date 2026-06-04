# parcel-tracker-contract System Dependencies

This document explains how the shared contract repository relates to the other parcel tracker repositories.

## Where this repo sits in the system

`parcel-tracker-contract` is the schema authority.
It does not run a service itself.
It defines the payload envelope and event-specific requirements used by producer and backend.

## Direct consumers

1. `parcel-tracker-pi`
- Event producer.
- Must emit payloads compatible with `schemas/raw_event.schema.json`.

2. `parcel-tracker-convex`
- Ingest backend.
- Must enforce compatibility rules and event semantics consistent with this contract.

## Indirect consumers

1. `TrackerDashboard`
- Uses data produced under this contract.
- Depends on stable semantics of `eventType`, `location`, `status`, and `beaconId`.

## Core responsibilities of this repo

1. Define shape
- Keep `schemas/raw_event.schema.json` as canonical envelope definition.

2. Define version
- Keep `CONTRACT_VERSION` synchronized with intended release state.

3. Define examples
- Keep `examples/` payloads useful for smoke tests and operator checks.

## Release coordination rules

When changing contract fields or semantics:

1. Edit schema and update examples.
2. Bump version according to semver impact.
3. Update backend compatibility logic in `parcel-tracker-convex`.
4. Deploy backend.
5. Update Pi emit logic/env defaults in `parcel-tracker-pi`.
6. Validate dashboard behavior in `TrackerDashboard`.

## Why this split is useful

Keeping contract in its own repository avoids hidden drift:

1. Pi and backend can evolve independently.
2. Contract changes are explicit and reviewable.
3. Operators can quickly identify version mismatch root causes.

## Related files in this repo

- `CONTRACT_VERSION`
- `schemas/raw_event.schema.json`
- `examples/raw_event.heartbeat.json`
- `examples/raw_event.ble_scan.json`
- `examples/raw_event.gps_cell_fallback.json`
