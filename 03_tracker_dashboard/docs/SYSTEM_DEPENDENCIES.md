# TrackerDashboard System Dependencies

This document explains how `TrackerDashboard` depends on the other parcel tracker repositories.

## Where this repo sits in the system

`TrackerDashboard` is the operator-facing read layer.
It does not ingest events directly from the Raspberry Pi.
Instead, it reads already-ingested data from `parcel-tracker-convex`.

High-level flow:

1. `parcel-tracker-pi` sends raw event payloads to Convex `POST /ingest`.
2. `parcel-tracker-convex` validates and stores those payloads.
3. `TrackerDashboard` reads Convex public query responses and renders the UI.

## Direct runtime dependencies

1. `parcel-tracker-convex`
- Required for data queries.
- Required query path by default: `queries:getTrackerEventHistory`.
- Contract metadata endpoint used by this UI: `GET /contract/version`.

2. `parcel-tracker-contract`
- Indirect dependency through Convex data semantics.
- The dashboard assumes event shapes and event types from the shared contract.
- If contract major version changes, dashboard parsing/visualization may need updates.

3. `parcel-tracker-pi`
- Indirect dependency through produced event quality.
- Missing GNSS fix, cell fallback accuracy, and beacon event frequency all affect dashboard output.

## Data assumptions this dashboard makes

This repo expects Convex responses to include one of the following models:

1. Raw model (preferred)
- `raw_events`
- optional `tracker_liveness`

2. Legacy point array model
- Older point-style payloads still parse via fallback logic.

The parser in `src/lib/tracker.ts` normalizes both models into a canonical dashboard shape.

## Failure modes caused by upstream repos

1. Pi emits invalid payloads
- Convex rejects events; dashboard appears stale.

2. Contract changes without coordinated rollout
- Convex may reject Pi payloads, or dashboard may misinterpret fields.

3. Convex query path changes
- Dashboard will show query errors until `NEXT_PUBLIC_TRACKER_FUNCTION_PATH` is updated.

4. Convex returns only non-location events
- Dashboard can still show liveness/event intelligence while route map is empty.

## Upgrade coordination checklist

When changing the contract or ingest behavior:

1. Update `parcel-tracker-contract` first (schema + version policy).
2. Update `parcel-tracker-convex` validation/compatibility rules.
3. Deploy Convex.
4. Update `parcel-tracker-pi` emit logic and `CONTRACT_VERSION`.
5. Verify dashboard query payload shape remains compatible.
6. Validate in `TrackerDashboard` map, liveness cards, and event breakdown.

## Environment settings in this repo tied to dependencies

1. `NEXT_PUBLIC_CONVEX_URL`
- Must point to the Convex deployment that receives Pi ingest.

2. `NEXT_PUBLIC_TRACKER_FUNCTION_PATH`
- Must match an existing public query in `parcel-tracker-convex`.

3. `NEXT_PUBLIC_TRACKER_FUNCTION_ARGS`
- Must match the selected query's expected args.

## Related files in this repo

- `src/components/tracker-dashboard.tsx`
- `src/lib/tracker.ts`
- `src/components/route-map.tsx`
