/**
 * Known event categories emitted by the parcel-tracker raw ingest contract.
 */
export type KnownTrackerEventType =
  | "heartbeat"
  | "gps_fix"
  | "gps_no_fix"
  | "gps_cell_fallback"
  | "ble_scan"
  | "rfid_scan";

/**
 * Event type is intentionally open-ended to stay forward-compatible with new contract events.
 */
export type TrackerEventType = KnownTrackerEventType | (string & {});

/**
 * Optional location transport/method metadata from raw events.
 */
export type TrackerLocationMethod = "gnss" | "cell_lbs_native" | (string & {});

/**
 * Canonical telemetry point shape consumed by map/chart UI.
 * All incoming payloads are normalized into this structure.
 */
export type TrackerPoint = {
  id: string;
  lat: number;
  lng: number;
  timestamp: number;
  speedKmh: number;
  heading?: number;
  accuracy?: number;
  altitude?: number;
  battery?: number;
  eventType?: TrackerEventType;
  trackerId?: string;
  ingestTsMs?: number;
  locationMethod?: TrackerLocationMethod;
  locationMode?: string;
  beaconId?: string;
  raw: Record<string, unknown>;
};

/**
 * Normalized raw event row from the new Convex raw ingest model.
 */
export type TrackerRawEvent = {
  id: string;
  eventId: string;
  trackerId: string;
  eventType: TrackerEventType;
  trackerTsMs: number;
  ingestTsMs?: number;
  seq?: number;
  beaconId?: string;
  locationMode?: string;
  location?: {
    lat: number;
    lon: number;
    speedKmh?: number;
    altM?: number;
    hdop?: number;
    method?: TrackerLocationMethod;
    accuracyM?: number;
    source?: string;
  };
  raw: Record<string, unknown>;
};

/**
 * Per-tracker liveness snapshot.
 */
export type TrackerLivenessSnapshot = {
  trackerId: string;
  lastTrackerTsMs: number;
  lastIngestTsMs: number;
  lastEventType?: TrackerEventType;
  locationMode?: string;
  raw: Record<string, unknown>;
};

/**
 * Aggregated metrics shown in the KPI cards.
 */
export type TrackerStats = {
  distanceKm: number;
  durationMinutes: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
};

/**
 * Event-level operational metrics derived from raw ingest history.
 */
export type TrackerEventInsights = {
  totalEvents: number;
  gpsFixCount: number;
  gpsCellFallbackCount: number;
  gpsNoFixCount: number;
  heartbeatCount: number;
  bleScanCount: number;
  rfidScanCount: number;
  withLocationCount: number;
  avgIngestLagSeconds: number;
  p95IngestLagSeconds: number;
  cellFallbackRatio: number;
  noFixRatio: number;
};

/**
 * Unified payload parse result used by the dashboard.
 */
export type TrackerSourceModel = {
  sourceType: "raw_events" | "legacy_points";
  points: TrackerPoint[];
  events: TrackerRawEvent[];
  liveness: TrackerLivenessSnapshot[];
};

// Supported source field aliases (Convex payloads can vary by producer/version).
const LAT_KEYS = ["lat", "latitude", "y", "gpsLat"];
const LNG_KEYS = ["lng", "lon", "long", "longitude", "x", "gpsLng", "gpsLon"];
const SPEED_KEYS = ["speed", "speedKmh", "velocity", "velocityKmh", "kmh"];
const HEADING_KEYS = ["heading", "bearing", "course", "direction"];
const ACCURACY_KEYS = ["accuracy", "accuracyMeters", "horizontalAccuracy"];
const ALTITUDE_KEYS = ["altitude", "alt", "elevation"];
const BATTERY_KEYS = ["battery", "batteryPct", "batteryLevel"];
const TIMESTAMP_KEYS = ["timestamp", "time", "ts", "createdAt", "updatedAt", "recordedAt", "date"];

/**
 * Parses a candidate value into a finite number.
 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Safely narrows unknown objects.
 */
function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Returns the first present key value from an object, preserving unknown typing.
 */
function getAny(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj) return obj[key];
  }
  return undefined;
}

/**
 * Normalizes timestamps from either ISO strings, seconds, or milliseconds.
 * Falls back to a synthetic value when no timestamp exists.
 */
function readTimestamp(obj: Record<string, unknown>, fallback: number): number {
  const value = getAny(obj, TIMESTAMP_KEYS);
  if (typeof value === "string") {
    const millis = Date.parse(value);
    if (!Number.isNaN(millis)) return millis;
    const numeric = toNumber(value);
    if (numeric !== null) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const numeric = toNumber(value);
  if (numeric !== null) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  return fallback;
}

/**
 * Timestamp reader with explicit key priority.
 */
function readTimestampByKeys(obj: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      const millis = Date.parse(value);
      if (!Number.isNaN(millis)) return millis;
      const numeric = toNumber(value);
      if (numeric !== null) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }

    const numeric = toNumber(value);
    if (numeric !== null) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  return fallback;
}

/**
 * Collects array-shaped candidates from common envelope keys.
 * This keeps parsing robust across Convex query response wrappers.
 */
function collectArrayCandidates(payload: unknown): unknown[][] {
  if (Array.isArray(payload)) return [payload];

  const root = toObject(payload);
  if (!root) return [];

  const arrays: unknown[][] = [];
  const pushArray = (value: unknown) => {
    if (Array.isArray(value)) arrays.push(value);
  };

  const preferredKeys = [
    "events",
    "rawEvents",
    "raw_events",
    "liveness",
    "tracker_liveness",
    "points",
    "route",
    "locations",
    "positions",
    "records",
    "entries",
    "data",
    "items",
    "result",
    "value",
  ];

  for (const key of preferredKeys) pushArray(root[key]);

  for (const value of Object.values(root)) {
    pushArray(value);
    const nested = toObject(value);
    if (!nested) continue;
    for (const nestedValue of Object.values(nested)) {
      pushArray(nestedValue);
    }
  }

  return arrays;
}

/**
 * Great-circle distance between two coordinates in kilometers.
 */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

/**
 * True when the object appears to be from raw_events.
 */
function isRawEventLike(raw: unknown): raw is Record<string, unknown> {
  const obj = toObject(raw);
  if (!obj) return false;

  const eventType = obj.eventType;
  if (typeof eventType !== "string" || eventType.length === 0) return false;

  const hasEventId = typeof obj.eventId === "string" || typeof obj._id === "string";
  const hasTrackerTs =
    toNumber(obj.trackerTsMs) !== null ||
    toNumber(obj.trackerTs) !== null ||
    toNumber(obj.trackerTimeMs) !== null ||
    toNumber(obj.ts) !== null;

  return hasEventId || hasTrackerTs || typeof obj.trackerId === "string";
}

/**
 * True when the object appears to be a tracker_liveness snapshot.
 */
function isLivenessLike(raw: unknown): raw is Record<string, unknown> {
  const obj = toObject(raw);
  if (!obj) return false;
  if (typeof obj.trackerId !== "string" || obj.trackerId.length === 0) return false;

  const hasAnyLivenessTimestamp =
    toNumber(obj.lastTrackerTsMs) !== null ||
    toNumber(obj.lastIngestTsMs) !== null ||
    toNumber(obj.lastTrackerTs) !== null ||
    toNumber(obj.lastIngestTs) !== null;

  return hasAnyLivenessTimestamp || typeof obj.lastEventType === "string";
}

/**
 * Guard that validates the minimum coordinate shape for legacy telemetry entries.
 */
function isLegacyPointLike(raw: unknown): raw is Record<string, unknown> {
  const obj = toObject(raw);
  if (!obj) return false;

  const lat = toNumber(getAny(obj, LAT_KEYS));
  const lng = toNumber(getAny(obj, LNG_KEYS));
  return lat !== null && lng !== null;
}

/**
 * Parses a nested raw-event location object.
 */
function parseRawLocation(locationLike: unknown): TrackerRawEvent["location"] | undefined {
  const locationObj = toObject(locationLike);
  if (!locationObj) return undefined;

  const lat = toNumber(getAny(locationObj, ["lat", "latitude"]));
  const lon = toNumber(getAny(locationObj, ["lon", "lng", "longitude"]));
  if (lat === null || lon === null) return undefined;

  return {
    lat,
    lon,
    speedKmh: toNumber(getAny(locationObj, ["speedKmh", "speed", "velocityKmh", "velocity"])) ?? undefined,
    altM: toNumber(getAny(locationObj, ["altM", "altitude", "alt"])) ?? undefined,
    hdop: toNumber(locationObj.hdop) ?? undefined,
    method: (typeof locationObj.method === "string" ? locationObj.method : undefined) as TrackerLocationMethod | undefined,
    accuracyM: toNumber(getAny(locationObj, ["accuracyM", "accuracy", "accuracyMeters"])) ?? undefined,
    source: typeof locationObj.source === "string" ? locationObj.source : undefined,
  };
}

/**
 * Parses raw_events rows from a query payload.
 */
export function normalizeRawEvents(payload: unknown): TrackerRawEvent[] {
  const arrays = collectArrayCandidates(payload);
  const baseTime = Date.now();

  let candidates: unknown[] = [];
  for (const array of arrays) {
    if (array.some((entry) => isRawEventLike(entry))) {
      candidates = array;
      break;
    }
  }

  if (candidates.length === 0 && isRawEventLike(payload)) {
    candidates = [payload];
  }

  const events: TrackerRawEvent[] = [];

  candidates.forEach((entry, index) => {
    const obj = toObject(entry);
    if (!obj || !isRawEventLike(obj)) return;

    const fallbackTs = baseTime + index * 1000;
    const trackerTsMs = readTimestampByKeys(
      obj,
      ["trackerTsMs", "trackerTs", "trackerTimeMs", "ts", "timestamp", "time", "_creationTime"],
      fallbackTs,
    );

    const ingestTsMs = readTimestampByKeys(
      obj,
      ["ingestTsMs", "lastIngestTsMs", "ingestTs", "ingestedAt", "_creationTime"],
      trackerTsMs,
    );

    const statusObj = toObject(obj.status);

    events.push({
      id: String(obj._id ?? obj.eventId ?? `event-${index}`),
      eventId: String(obj.eventId ?? obj._id ?? `event-${index}`),
      trackerId: typeof obj.trackerId === "string" ? obj.trackerId : "unknown-tracker",
      eventType: typeof obj.eventType === "string" ? (obj.eventType as TrackerEventType) : "heartbeat",
      trackerTsMs,
      ingestTsMs,
      seq: toNumber(obj.seq) ?? undefined,
      beaconId: typeof obj.beaconId === "string" ? obj.beaconId : undefined,
      locationMode:
        typeof statusObj?.locationMode === "string"
          ? statusObj.locationMode
          : typeof obj.locationMode === "string"
            ? obj.locationMode
            : undefined,
      location: parseRawLocation(obj.location),
      raw: obj,
    });
  });

  events.sort((a, b) => (a.trackerTsMs - b.trackerTsMs) || ((a.ingestTsMs ?? 0) - (b.ingestTsMs ?? 0)));
  return events;
}

/**
 * Converts raw ingest events into map/chart points.
 * Only events with coordinates are materialized as route points.
 */
export function rawEventsToTrackerPoints(events: TrackerRawEvent[]): TrackerPoint[] {
  const points: TrackerPoint[] = [];

  for (const event of events) {
    if (!event.location) continue;

    points.push({
      id: event.id,
      lat: event.location.lat,
      lng: event.location.lon,
      timestamp: event.trackerTsMs,
      speedKmh: event.location.speedKmh ?? 0,
      altitude: event.location.altM,
      accuracy: event.location.accuracyM,
      eventType: event.eventType,
      trackerId: event.trackerId,
      ingestTsMs: event.ingestTsMs,
      locationMethod: event.location.method,
      locationMode: event.locationMode,
      beaconId: event.beaconId,
      raw: event.raw,
    });
  }

  points.sort((a, b) => a.timestamp - b.timestamp);

  // Fill missing speed from geodesic distance over elapsed time.
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point.speedKmh > 0) continue;
    const previous = points[i - 1];
    const seconds = (point.timestamp - previous.timestamp) / 1000;
    if (seconds <= 0) continue;
    const km = haversineKm(previous, point);
    point.speedKmh = (km / seconds) * 3600;
  }

  return points;
}

/**
 * Parses tracker_liveness snapshots from a query payload.
 */
export function normalizeLiveness(payload: unknown): TrackerLivenessSnapshot[] {
  const arrays = collectArrayCandidates(payload);
  const snapshots: TrackerLivenessSnapshot[] = [];

  let candidates: unknown[] = [];
  for (const array of arrays) {
    if (array.some((entry) => isLivenessLike(entry))) {
      candidates = array;
      break;
    }
  }

  if (candidates.length === 0 && isLivenessLike(payload)) {
    candidates = [payload];
  }

  candidates.forEach((entry) => {
    const obj = toObject(entry);
    if (!obj || !isLivenessLike(obj)) return;

    const now = Date.now();

    snapshots.push({
      trackerId: obj.trackerId as string,
      lastTrackerTsMs: readTimestampByKeys(obj, ["lastTrackerTsMs", "lastTrackerTs", "trackerTsMs"], now),
      lastIngestTsMs: readTimestampByKeys(obj, ["lastIngestTsMs", "lastIngestTs", "ingestTsMs", "_creationTime"], now),
      lastEventType: typeof obj.lastEventType === "string" ? (obj.lastEventType as TrackerEventType) : undefined,
      locationMode: typeof obj.locationMode === "string" ? obj.locationMode : undefined,
      raw: obj,
    });
  });

  snapshots.sort((a, b) => a.lastIngestTsMs - b.lastIngestTsMs);

  const deduped = new Map<string, TrackerLivenessSnapshot>();
  for (const snapshot of snapshots) {
    const existing = deduped.get(snapshot.trackerId);
    if (!existing || snapshot.lastIngestTsMs >= existing.lastIngestTsMs) {
      deduped.set(snapshot.trackerId, snapshot);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => a.lastIngestTsMs - b.lastIngestTsMs);
}

/**
 * Derives liveness snapshots from event history when explicit liveness rows are unavailable.
 */
export function deriveLivenessFromEvents(events: TrackerRawEvent[]): TrackerLivenessSnapshot[] {
  const latestByTracker = new Map<string, TrackerRawEvent>();

  for (const event of events) {
    const existing = latestByTracker.get(event.trackerId);
    const existingTs = existing?.ingestTsMs ?? existing?.trackerTsMs ?? 0;
    const incomingTs = event.ingestTsMs ?? event.trackerTsMs;
    if (!existing || incomingTs >= existingTs) {
      latestByTracker.set(event.trackerId, event);
    }
  }

  return Array.from(latestByTracker.values())
    .map((event) => ({
      trackerId: event.trackerId,
      lastTrackerTsMs: event.trackerTsMs,
      lastIngestTsMs: event.ingestTsMs ?? event.trackerTsMs,
      lastEventType: event.eventType,
      locationMode: event.locationMode,
      raw: event.raw,
    }))
    .sort((a, b) => a.lastIngestTsMs - b.lastIngestTsMs);
}

/**
 * Legacy parser for pre-raw-events GPS point payloads.
 */
function normalizeLegacyPoints(payload: unknown): TrackerPoint[] {
  const arrays = collectArrayCandidates(payload);

  let candidates: unknown[] = [];
  for (const array of arrays) {
    if (array.some((entry) => isLegacyPointLike(entry))) {
      candidates = array;
      break;
    }
  }

  if (candidates.length === 0 && isLegacyPointLike(payload)) {
    candidates = [payload];
  }

  const baseTime = Date.now();
  const points: TrackerPoint[] = [];

  candidates.forEach((entry, index) => {
    if (!isLegacyPointLike(entry)) return;

    const obj = entry as Record<string, unknown>;
    const lat = toNumber(getAny(obj, LAT_KEYS));
    const lng = toNumber(getAny(obj, LNG_KEYS));
    if (lat === null || lng === null) return;

    const fallback = baseTime + index * 60_000;
    const timestamp = readTimestamp(obj, fallback);

    let speed = toNumber(getAny(obj, SPEED_KEYS));
    const mph = typeof obj.mph === "number" ? obj.mph : toNumber(obj.mph);
    if (mph !== null && speed === null) speed = mph * 1.60934;

    points.push({
      id: String(obj._id ?? obj.id ?? `point-${index}`),
      lat,
      lng,
      timestamp,
      speedKmh: speed ?? 0,
      heading: toNumber(getAny(obj, HEADING_KEYS)) ?? undefined,
      accuracy: toNumber(getAny(obj, ACCURACY_KEYS)) ?? undefined,
      altitude: toNumber(getAny(obj, ALTITUDE_KEYS)) ?? undefined,
      battery: toNumber(getAny(obj, BATTERY_KEYS)) ?? undefined,
      raw: obj,
    });
  });

  points.sort((a, b) => a.timestamp - b.timestamp);

  // Fill missing speed from geodesic distance over elapsed time.
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point.speedKmh > 0) continue;
    const previous = points[i - 1];
    const seconds = (point.timestamp - previous.timestamp) / 1000;
    if (seconds <= 0) continue;
    const km = haversineKm(previous, point);
    point.speedKmh = (km / seconds) * 3600;
  }

  return points;
}

/**
 * Unified source parser for both legacy point payloads and new raw-event payloads.
 */
export function parseTrackerSourcePayload(payload: unknown): TrackerSourceModel {
  const events = normalizeRawEvents(payload);
  const liveness = normalizeLiveness(payload);
  const legacyPoints = normalizeLegacyPoints(payload);

  // Treat liveness-only payloads as raw model when no legacy points are present.
  if (events.length > 0 || (liveness.length > 0 && legacyPoints.length === 0)) {
    return {
      sourceType: "raw_events",
      points: rawEventsToTrackerPoints(events),
      events,
      liveness: liveness.length > 0 ? liveness : deriveLivenessFromEvents(events),
    };
  }

  return {
    sourceType: "legacy_points",
    points: legacyPoints,
    events: [],
    liveness,
  };
}

/**
 * Backward-compatible point-only parser.
 */
export function normalizeTrackerPayload(payload: unknown): TrackerPoint[] {
  return parseTrackerSourcePayload(payload).points;
}

/**
 * Produces aggregate distance/speed/time metrics for the current route window.
 */
export function getTrackerStats(points: TrackerPoint[]): TrackerStats {
  if (points.length === 0) {
    return {
      distanceKm: 0,
      durationMinutes: 0,
      avgSpeedKmh: 0,
      maxSpeedKmh: 0,
    };
  }

  let distanceKm = 0;
  let maxSpeedKmh = 0;
  let speedSum = 0;

  for (let i = 1; i < points.length; i += 1) {
    distanceKm += haversineKm(points[i - 1], points[i]);
  }

  for (const point of points) {
    maxSpeedKmh = Math.max(maxSpeedKmh, point.speedKmh);
    speedSum += point.speedKmh;
  }

  const durationMinutes = Math.max(0, (points.at(-1)!.timestamp - points[0].timestamp) / 60_000);

  return {
    distanceKm,
    durationMinutes,
    avgSpeedKmh: speedSum / points.length,
    maxSpeedKmh,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/**
 * Event analytics tailored for the new raw ingest schema.
 */
export function getEventInsights(events: TrackerRawEvent[]): TrackerEventInsights {
  if (events.length === 0) {
    return {
      totalEvents: 0,
      gpsFixCount: 0,
      gpsCellFallbackCount: 0,
      gpsNoFixCount: 0,
      heartbeatCount: 0,
      bleScanCount: 0,
      rfidScanCount: 0,
      withLocationCount: 0,
      avgIngestLagSeconds: 0,
      p95IngestLagSeconds: 0,
      cellFallbackRatio: 0,
      noFixRatio: 0,
    };
  }

  let gpsFixCount = 0;
  let gpsCellFallbackCount = 0;
  let gpsNoFixCount = 0;
  let heartbeatCount = 0;
  let bleScanCount = 0;
  let rfidScanCount = 0;
  let withLocationCount = 0;
  const lagSeconds: number[] = [];

  for (const event of events) {
    if (event.location) withLocationCount += 1;

    switch (event.eventType) {
      case "gps_fix":
        gpsFixCount += 1;
        break;
      case "gps_cell_fallback":
        gpsCellFallbackCount += 1;
        break;
      case "gps_no_fix":
        gpsNoFixCount += 1;
        break;
      case "heartbeat":
        heartbeatCount += 1;
        break;
      case "ble_scan":
        bleScanCount += 1;
        break;
      case "rfid_scan":
        rfidScanCount += 1;
        break;
      default:
        break;
    }

    if (typeof event.ingestTsMs === "number" && Number.isFinite(event.ingestTsMs)) {
      const lag = (event.ingestTsMs - event.trackerTsMs) / 1000;
      if (Number.isFinite(lag) && lag >= 0) lagSeconds.push(lag);
    }
  }

  const totalEvents = events.length;
  const avgIngestLagSeconds = lagSeconds.length > 0 ? lagSeconds.reduce((sum, value) => sum + value, 0) / lagSeconds.length : 0;

  return {
    totalEvents,
    gpsFixCount,
    gpsCellFallbackCount,
    gpsNoFixCount,
    heartbeatCount,
    bleScanCount,
    rfidScanCount,
    withLocationCount,
    avgIngestLagSeconds,
    p95IngestLagSeconds: percentile(lagSeconds, 95),
    cellFallbackRatio: totalEvents > 0 ? gpsCellFallbackCount / totalEvents : 0,
    noFixRatio: totalEvents > 0 ? gpsNoFixCount / totalEvents : 0,
  };
}
