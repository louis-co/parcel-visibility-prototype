# parcel-tracker-contract

Shared contract for every raw tracker event sent from Raspberry Pi devices to Convex.

This repo exists to keep **Pi runtime code** and **Convex ingest code** synchronized without forcing them into one Git repository.

In this publication bundle, the contract is included as `04event_contract/`.

## Why this repo exists

Without a shared contract repo, the Pi can send payloads that the backend no longer accepts (or vice versa). This repo prevents that by making event shape and versioning explicit.

You should pin this repo as a submodule (or mirror it) in both:
- `parcel-tracker-pi`
- `parcel-tracker-convex`

## Repository layout

- `CONTRACT_VERSION`
  - Current contract version in semver format (`MAJOR.MINOR.PATCH`).
- `schemas/raw_event.schema.json`
  - JSON Schema for the raw event envelope.
- `examples/`
  - Ready-to-use sample payloads for manual ingest tests.

## Current contract

- Version: `1.0.0`
- File: `schemas/raw_event.schema.json`

## Event types

Allowed `eventType` values:
- `heartbeat`
- `gps_fix`
- `gps_no_fix`
- `gps_cell_fallback`
- `ble_scan`
- `rfid_scan`

## Key conditional rules in schema

1. `gps_fix`
- Must include `location`
- Must set `location.method = "gnss"`

2. `gps_cell_fallback`
- Must include `location`
- Must set `location.method = "cell_lbs_native"`
- Must include `location.accuracyM`
- Must set `location.source = "sim7670_clbs"`

3. `ble_scan` / `rfid_scan`
- Must include `beaconId`

4. Heartbeat status mode
- `status.locationMode` can be:
  - `gnss_fix`
  - `cell_fallback`
  - `no_fix`

## Versioning policy

Use semantic versioning:

1. `PATCH` (x.y.Z)
- Bug fix only.
- No payload shape changes.

2. `MINOR` (x.Y.z)
- Backward-compatible additions.
- Example: new optional field.

3. `MAJOR` (X.y.z)
- Breaking changes.
- Example: required field added/renamed/removed.

## Compatibility rule used by backend

Current backend expects `major == 1`.

That means:
- `1.0.0`, `1.2.0`, `1.9.5` are accepted.
- `2.0.0` is rejected until backend compatibility is explicitly updated.

## Recommended release process

1. Update schema in `schemas/raw_event.schema.json`.
2. If needed, update `CONTRACT_VERSION`.
3. Commit with clear message including compatibility impact.
4. Update `parcel-tracker-convex` to accept/reject correctly.
5. Update `parcel-tracker-pi` to emit new fields/version.
6. Deploy backend before rolling new Pi runtime.

## What you can test right now (without RFID hardware)

1. Confirm schema files are present and readable.
2. Use `examples/raw_event.heartbeat.json` and `examples/raw_event.ble_scan.json` to test backend ingest.
3. Validate that backend still rejects malformed payloads (for example `{}`).
4. Keep `examples/raw_event.gps_cell_fallback.json` for indoor fallback validation.

### Sample files

- `examples/raw_event.heartbeat.json`
- `examples/raw_event.ble_scan.json`
- `examples/raw_event.gps_cell_fallback.json`

### Quick operator flow

1. Run Convex smoke script on dev:
   - `parcel-tracker-convex/scripts/smoke_ingest.sh https://your-deployment.convex.site`
2. Run Pi smoke script on tracker:
   - `sudo /opt/parcel-tracker-pi/scripts/smoke_test_no_rfid.sh`
3. If both pass, core contract path is healthy for heartbeat/GPS/BLE.

## Example validation (optional local check)

You can validate payloads with any JSON Schema validator (Ajv, python-jsonschema, etc.).

Example using Node + Ajv:

```bash
npm i ajv ajv-formats
```

```js
import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "./schemas/raw_event.schema.json" assert { type: "json" };

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const validate = ajv.compile(schema);
const ok = validate(payload);
if (!ok) console.log(validate.errors);
```

## Notes for non-technical operators

- If Pi logs show `contractVersion` errors, Pi and backend are out of sync.
- Deploy backend first, then update Pi code.
- Keep this repo version aligned in both runtime and backend repos.

## Cross-Repo Dependencies

This contract is shared by the other three repositories:

1. `parcel-tracker-pi`
- Must emit payloads that satisfy this schema and contract version policy.

2. `parcel-tracker-convex`
- Must validate ingest payloads according to this schema/semantics and compatibility rules.

3. `TrackerDashboard`
- Reads data created from these event shapes and event types.

Detailed integration notes are documented in:
- `docs/SYSTEM_DEPENDENCIES.md`
