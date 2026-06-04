import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const eventTypeValidator = v.union(
  v.literal("heartbeat"),
  v.literal("gps_fix"),
  v.literal("gps_no_fix"),
  v.literal("gps_cell_fallback"),
  v.literal("ble_scan"),
  v.literal("rfid_scan"),
);

const locationModeValidator = v.union(
  v.literal("gnss_fix"),
  v.literal("cell_fallback"),
  v.literal("no_fix"),
);

const locationValidator = v.object({
  lat: v.number(),
  lon: v.number(),
  speedKmh: v.optional(v.number()),
  altM: v.optional(v.number()),
  hdop: v.optional(v.number()),
  method: v.union(v.literal("gnss"), v.literal("cell_lbs_native")),
  accuracyM: v.optional(v.number()),
  source: v.optional(v.string()),
});

export default defineSchema({
  raw_events: defineTable({
    eventId: v.string(),
    contractVersion: v.string(),
    trackerId: v.string(),
    eventType: eventTypeValidator,
    trackerTsMs: v.number(),
    ingestTsMs: v.number(),
    seq: v.number(),
    beaconId: v.optional(v.string()),
    location: v.optional(locationValidator),
    signal: v.optional(
      v.object({
        rssi: v.optional(v.number()),
      }),
    ),
    status: v.optional(
      v.object({
        locationMode: v.optional(locationModeValidator),
      }),
    ),
    sourcePayload: v.optional(v.any()),
  })
    .index("by_event_id", ["eventId"])
    .index("by_tracker_ts", ["trackerId", "trackerTsMs"])
    .index("by_event_type_ts", ["eventType", "trackerTsMs"])
    .index("by_beacon_ts", ["beaconId", "trackerTsMs"])
    .index("by_ingest_ts", ["ingestTsMs"]),

  ingest_dedupe: defineTable({
    eventId: v.string(),
    trackerId: v.string(),
    rawEventId: v.id("raw_events"),
    createdTsMs: v.number(),
  }).index("by_event_id", ["eventId"]),

  tracker_liveness: defineTable({
    trackerId: v.string(),
    lastTrackerTsMs: v.number(),
    lastIngestTsMs: v.number(),
    lastEventType: eventTypeValidator,
    locationMode: v.optional(locationModeValidator),
  }).index("by_tracker", ["trackerId"]),

  tracker_plate_assignments: defineTable({
    trackerName: v.string(),
    licensePlate: v.string(),
    updatedAtMs: v.number(),
  })
    .index("by_tracker_name", ["trackerName"])
    .index("by_license_plate", ["licensePlate"]),
});
