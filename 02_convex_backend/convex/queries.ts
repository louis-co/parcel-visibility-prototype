import { query } from "./_generated/server";
import { v } from "convex/values";
import { CURRENT_CONTRACT_VERSION, MIN_COMPATIBLE_MAJOR } from "./ingest";

const eventTypeValidator = v.union(
  v.literal("heartbeat"),
  v.literal("gps_fix"),
  v.literal("gps_no_fix"),
  v.literal("gps_cell_fallback"),
  v.literal("ble_scan"),
  v.literal("rfid_scan"),
);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function normalizeLimit(limit?: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }
  const rounded = Math.floor(limit);
  if (rounded < 1) return 1;
  if (rounded > MAX_LIMIT) return MAX_LIMIT;
  return rounded;
}

function assertValidRange(start?: number, end?: number) {
  if (typeof start === "number" && typeof end === "number" && end < start) {
    throw new Error("Invalid range: end timestamp must be greater than or equal to start timestamp.");
  }
}

export const getContractVersion = query({
  args: {},
  handler: async () => {
    return {
      contractVersion: CURRENT_CONTRACT_VERSION,
      minCompatibleMajor: MIN_COMPATIBLE_MAJOR,
    };
  },
});

export const listPublicQueries = query({
  args: {},
  handler: async () => {
    return [
      {
        name: "queries:getContractVersion",
        args: {},
        description: "Returns ingest contract metadata (same values as GET /contract/version).",
      },
      {
        name: "queries:listPublicQueries",
        args: {},
        description: "Returns this list of callable public query names and argument shapes.",
      },
      {
        name: "queries:getEventById",
        args: { eventId: "string (required)" },
        description: "Fetches a single raw event by eventId (or null if missing).",
      },
      {
        name: "queries:listTrackerLiveness",
        args: {
          trackerId: "string (optional)",
          limit: "number 1..500 (optional, default 100)",
        },
        description:
          "Returns latest liveness rows. With trackerId, returns at most one row in an array.",
      },
      {
        name: "queries:listRecentRawEvents",
        args: {
          sinceIngestTsMs: "number (optional)",
          limit: "number 1..500 (optional, default 100)",
        },
        description: "Returns newest raw events ordered by ingestTsMs descending.",
      },
      {
        name: "queries:getTrackerEventHistory",
        args: {
          trackerId: "string (required)",
          startTrackerTsMs: "number (optional)",
          endTrackerTsMs: "number (optional)",
          limit: "number 1..500 (optional, default 100)",
        },
        description: "Returns tracker-specific raw events ordered by trackerTsMs descending.",
      },
      {
        name: "queries:getEventsByType",
        args: {
          eventType:
            "'heartbeat' | 'gps_fix' | 'gps_no_fix' | 'gps_cell_fallback' | 'ble_scan' | 'rfid_scan' (required)",
          startTrackerTsMs: "number (optional)",
          endTrackerTsMs: "number (optional)",
          limit: "number 1..500 (optional, default 100)",
        },
        description: "Returns raw events for one eventType ordered by trackerTsMs descending.",
      },
      {
        name: "queries:getBeaconHistory",
        args: {
          beaconId: "string (required)",
          startTrackerTsMs: "number (optional)",
          endTrackerTsMs: "number (optional)",
          limit: "number 1..500 (optional, default 100)",
        },
        description: "Returns BLE/RFID events for one beacon ordered by trackerTsMs descending.",
      },
    ];
  },
});

export const getEventById = query({
  args: {
    eventId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("raw_events")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .first();
  },
});

export const listTrackerLiveness = query({
  args: {
    trackerId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = normalizeLimit(args.limit);
    if (args.trackerId) {
      const row = await ctx.db
        .query("tracker_liveness")
        .withIndex("by_tracker", (q) => q.eq("trackerId", args.trackerId as string))
        .first();
      return row ? [row] : [];
    }

    const rows = await ctx.db.query("tracker_liveness").collect();
    rows.sort((a, b) => b.lastIngestTsMs - a.lastIngestTsMs);
    return rows.slice(0, limit);
  },
});

export const listRecentRawEvents = query({
  args: {
    sinceIngestTsMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = normalizeLimit(args.limit);
    return await ctx.db
      .query("raw_events")
      .withIndex("by_ingest_ts", (q) => {
        if (typeof args.sinceIngestTsMs === "number") {
          return q.gte("ingestTsMs", args.sinceIngestTsMs);
        }
        return q;
      })
      .order("desc")
      .take(limit);
  },
});

export const getTrackerEventHistory = query({
  args: {
    trackerId: v.string(),
    startTrackerTsMs: v.optional(v.number()),
    endTrackerTsMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertValidRange(args.startTrackerTsMs, args.endTrackerTsMs);
    const limit = normalizeLimit(args.limit);

    return await ctx.db
      .query("raw_events")
      .withIndex("by_tracker_ts", (q) => {
        let range = q.eq("trackerId", args.trackerId);
        if (typeof args.startTrackerTsMs === "number") {
          range = range.gte("trackerTsMs", args.startTrackerTsMs);
        }
        if (typeof args.endTrackerTsMs === "number") {
          range = range.lte("trackerTsMs", args.endTrackerTsMs);
        }
        return range;
      })
      .order("desc")
      .take(limit);
  },
});

export const getEventsByType = query({
  args: {
    eventType: eventTypeValidator,
    startTrackerTsMs: v.optional(v.number()),
    endTrackerTsMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertValidRange(args.startTrackerTsMs, args.endTrackerTsMs);
    const limit = normalizeLimit(args.limit);

    return await ctx.db
      .query("raw_events")
      .withIndex("by_event_type_ts", (q) => {
        let range = q.eq("eventType", args.eventType);
        if (typeof args.startTrackerTsMs === "number") {
          range = range.gte("trackerTsMs", args.startTrackerTsMs);
        }
        if (typeof args.endTrackerTsMs === "number") {
          range = range.lte("trackerTsMs", args.endTrackerTsMs);
        }
        return range;
      })
      .order("desc")
      .take(limit);
  },
});

export const getBeaconHistory = query({
  args: {
    beaconId: v.string(),
    startTrackerTsMs: v.optional(v.number()),
    endTrackerTsMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertValidRange(args.startTrackerTsMs, args.endTrackerTsMs);
    const limit = normalizeLimit(args.limit);

    return await ctx.db
      .query("raw_events")
      .withIndex("by_beacon_ts", (q) => {
        let range = q.eq("beaconId", args.beaconId);
        if (typeof args.startTrackerTsMs === "number") {
          range = range.gte("trackerTsMs", args.startTrackerTsMs);
        }
        if (typeof args.endTrackerTsMs === "number") {
          range = range.lte("trackerTsMs", args.endTrackerTsMs);
        }
        return range;
      })
      .order("desc")
      .take(limit);
  },
});
