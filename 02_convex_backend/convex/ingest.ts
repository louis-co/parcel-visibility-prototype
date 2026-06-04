import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const CURRENT_CONTRACT_VERSION = "1.0.0";
export const MIN_COMPATIBLE_MAJOR = 1;

const EVENT_TYPES = [
  "heartbeat",
  "gps_fix",
  "gps_no_fix",
  "gps_cell_fallback",
  "ble_scan",
  "rfid_scan",
] as const;

type EventType = (typeof EVENT_TYPES)[number];

const LOCATION_MODES = ["gnss_fix", "cell_fallback", "no_fix"] as const;
type LocationMode = (typeof LOCATION_MODES)[number];

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

function parseSemverMajor(version: string): number | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

function assertCompatibleContractVersion(contractVersion: string) {
  const major = parseSemverMajor(contractVersion);
  if (major === null) {
    throw new Error(`Invalid contractVersion '${contractVersion}'. Expected semver format x.y.z.`);
  }
  if (major !== MIN_COMPATIBLE_MAJOR) {
    throw new Error(
      `Incompatible contractVersion '${contractVersion}'. Expected major ${MIN_COMPATIBLE_MAJOR}.`,
    );
  }
}

function assertEventSemantics(args: {
  eventType: EventType;
  beaconId?: string;
  location?: {
    lat: number;
    lon: number;
    speedKmh?: number;
    altM?: number;
    hdop?: number;
    method: "gnss" | "cell_lbs_native";
    accuracyM?: number;
    source?: string;
  };
  status?: { locationMode?: LocationMode };
}) {
  if ((args.eventType === "ble_scan" || args.eventType === "rfid_scan") && !args.beaconId) {
    throw new Error(`${args.eventType} requires beaconId.`);
  }

  if (args.eventType === "gps_fix") {
    if (!args.location) {
      throw new Error("gps_fix requires location.");
    }
    if (args.location.method !== "gnss") {
      throw new Error("gps_fix requires location.method='gnss'.");
    }
  }

  if (args.eventType === "gps_cell_fallback") {
    if (!args.location) {
      throw new Error("gps_cell_fallback requires location.");
    }
    if (args.location.method !== "cell_lbs_native") {
      throw new Error("gps_cell_fallback requires location.method='cell_lbs_native'.");
    }
    if (typeof args.location.accuracyM !== "number") {
      throw new Error("gps_cell_fallback requires location.accuracyM.");
    }
    if (args.location.source !== "sim7670_clbs") {
      throw new Error("gps_cell_fallback requires location.source='sim7670_clbs'.");
    }
  }
}

function deriveLocationMode(eventType: EventType, explicitMode?: LocationMode): LocationMode | undefined {
  if (eventType === "gps_fix") {
    return "gnss_fix";
  }
  if (eventType === "gps_cell_fallback") {
    return "cell_fallback";
  }
  if (eventType === "gps_no_fix") {
    return "no_fix";
  }
  return explicitMode;
}

export const ingestRawEvent = mutation({
  args: {
    eventId: v.string(),
    contractVersion: v.string(),
    trackerId: v.string(),
    eventType: eventTypeValidator,
    trackerTsMs: v.number(),
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
  },
  handler: async (ctx, args) => {
    assertCompatibleContractVersion(args.contractVersion);
    assertEventSemantics(args);

    // Idempotency gate: if this eventId already exists, do not create another raw row.
    const existing = await ctx.db
      .query("ingest_dedupe")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .first();

    if (existing) {
      return {
        ok: true,
        duplicate: true,
        rawEventId: existing.rawEventId,
      };
    }

    const ingestTsMs = Date.now();
    const rawEventId = await ctx.db.insert("raw_events", {
      ...args,
      ingestTsMs,
    });

    await ctx.db.insert("ingest_dedupe", {
      eventId: args.eventId,
      trackerId: args.trackerId,
      rawEventId,
      createdTsMs: ingestTsMs,
    });

    const derivedLocationMode = deriveLocationMode(args.eventType, args.status?.locationMode);
    const existingLiveness = await ctx.db
      .query("tracker_liveness")
      .withIndex("by_tracker", (q) => q.eq("trackerId", args.trackerId))
      .first();

    // Keep an up-to-date "last seen" snapshot for fast liveness checks per tracker.
    if (existingLiveness) {
      await ctx.db.patch(existingLiveness._id, {
        lastTrackerTsMs: args.trackerTsMs,
        lastIngestTsMs: ingestTsMs,
        lastEventType: args.eventType,
        locationMode: derivedLocationMode,
      });
    } else {
      await ctx.db.insert("tracker_liveness", {
        trackerId: args.trackerId,
        lastTrackerTsMs: args.trackerTsMs,
        lastIngestTsMs: ingestTsMs,
        lastEventType: args.eventType,
        locationMode: derivedLocationMode,
      });
    }

    return {
      ok: true,
      duplicate: false,
      rawEventId,
    };
  },
});
