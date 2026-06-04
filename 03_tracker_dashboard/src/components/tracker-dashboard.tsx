"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format, formatDistanceStrict, subHours } from "date-fns";
import {
  Activity,
  CalendarClock,
  CalendarIcon,
  Check,
  ChevronsUpDown,
  Gauge,
  GitBranch,
  LocateFixed,
  RefreshCw,
  Route,
  Search,
  Settings2,
  Timer,
  TriangleAlert,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { RouteMap } from "@/components/route-map";
import { Calendar } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  deriveLivenessFromEvents,
  getEventInsights,
  getTrackerStats,
  parseTrackerSourcePayload,
  rawEventsToTrackerPoints,
  type TrackerLivenessSnapshot,
  type TrackerPoint,
  type TrackerRawEvent,
  type TrackerSourceModel,
} from "@/lib/tracker";

const STORAGE_KEY = "tracker-dashboard-settings";
const DEFAULT_CONVEX_CLOUD_URL = "https://your-deployment.convex.cloud";
const DEFAULT_RECOMMENDED_PATH = "queries:getTrackerEventHistory";
const DEFAULT_RECOMMENDED_ARGS = '{"trackerId":"pi-5-gateway-01","limit":500}';
const DEFAULT_ALL_EVENTS_PATH = "queries:listRecentRawEvents";
const DEFAULT_ALL_EVENTS_ARGS = '{"limit":500}';
const ALL_TRACKERS_FILTER = "__all_trackers__";
const LEGACY_FUNCTION_PATHS = new Set(["gps:getPoints", "dashboard:getRawEvents"]);
const DEFAULT_CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? DEFAULT_CONVEX_CLOUD_URL;
const DEFAULT_FUNCTION_PATH = normalizeFunctionPath(
  process.env.NEXT_PUBLIC_TRACKER_FUNCTION_PATH ?? DEFAULT_RECOMMENDED_PATH,
);
const DEFAULT_ARGS = process.env.NEXT_PUBLIC_TRACKER_FUNCTION_ARGS ?? DEFAULT_RECOMMENDED_ARGS;
const SETTINGS_VERSION = 5;
const LEGACY_CONVEX_HOST_FRAGMENTS: string[] = [];
const MPH_TO_KMH = 1.60934;
const HOURS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));

type SpeedUnit = "kmh" | "mph";

/**
 * Persisted dashboard runtime settings.
 * Values are mirrored between in-memory state and localStorage.
 */
type DashboardSettings = {
  convexUrl: string;
  functionPath: string;
  argsJson: string;
  trackerFilter: string;
  autoRefresh: boolean;
  refreshSeconds: number;
  incomingSpeedUnit: SpeedUnit;
  displaySpeedUnit: SpeedUnit;
  incrementalSync: boolean;
  timeFromIso: string;
  timeToIso: string;
};

type StoredDashboardSettings = Partial<DashboardSettings> & {
  __version?: number;
};

/**
 * Minimal server response shape expected from Convex /api/query.
 */
type QueryResponse = {
  status?: string;
  value?: unknown;
  result?: unknown;
  errorMessage?: string;
  message?: string;
};

type ContractVersionResponse = {
  contractVersion: string;
  minCompatibleMajor: number;
};

type TrackerPlateAssignment = {
  trackerName: string;
  licensePlate: string;
  updatedAtMs: number | null;
};

type TrackerDirectoryOption = {
  trackerId: string;
  licensePlate: string | null;
  updatedAtMs: number | null;
};

/**
 * Provides first-run defaults and fallback values when persisted state is invalid.
 */
function initialSettings(): DashboardSettings {
  const now = new Date();
  const from = subHours(now, 24);
  return {
    convexUrl: DEFAULT_CONVEX_URL,
    functionPath: DEFAULT_FUNCTION_PATH,
    argsJson: DEFAULT_ARGS,
    trackerFilter: ALL_TRACKERS_FILTER,
    autoRefresh: true,
    refreshSeconds: 20,
    incomingSpeedUnit: "mph",
    displaySpeedUnit: "kmh",
    incrementalSync: true,
    timeFromIso: from.toISOString(),
    timeToIso: now.toISOString(),
  };
}

/**
 * Converts known legacy query paths to the current raw-events query.
 * This prevents stale clients from repeatedly calling removed Convex functions.
 */
function normalizeFunctionPath(path: string) {
  const trimmed = path.trim();
  if (LEGACY_FUNCTION_PATHS.has(trimmed)) return DEFAULT_RECOMMENDED_PATH;
  return trimmed.length > 0 ? trimmed : DEFAULT_RECOMMENDED_PATH;
}

/**
 * Treats old function paths as legacy defaults that should be replaced by the
 * current Convex source automatically.
 */
function shouldUpgradeStoredSource(settings: StoredDashboardSettings) {
  const lowerUrl = (settings.convexUrl ?? "").toLowerCase();
  const legacyUrl = LEGACY_CONVEX_HOST_FRAGMENTS.some((fragment) => lowerUrl.includes(fragment));
  const legacyFunction = LEGACY_FUNCTION_PATHS.has((settings.functionPath ?? "").trim());

  return legacyUrl || legacyFunction;
}

/**
 * Migrates persisted settings while preserving user customizations when possible.
 */
function migrateStoredSettings(stored: StoredDashboardSettings): DashboardSettings {
  const merged: DashboardSettings = {
    ...initialSettings(),
    ...stored,
  };

  const needsDefaultUpgrade = stored.__version !== SETTINGS_VERSION && shouldUpgradeStoredSource(stored);
  const shouldCanonicalizeExampleHost =
    stored.__version !== SETTINGS_VERSION &&
    typeof stored.convexUrl === "string" &&
    stored.convexUrl.includes("your-deployment.convex.site");

  if (needsDefaultUpgrade) {
    merged.convexUrl = DEFAULT_CONVEX_URL;
    merged.functionPath = DEFAULT_FUNCTION_PATH;
    merged.argsJson = DEFAULT_ARGS;
  } else if (shouldCanonicalizeExampleHost) {
    // Keep user-selected query/args but normalize host to the canonical .cloud URL.
    merged.convexUrl = DEFAULT_CONVEX_CLOUD_URL;
  }

  merged.functionPath = normalizeFunctionPath(merged.functionPath);
  merged.trackerFilter =
    typeof merged.trackerFilter === "string" && merged.trackerFilter.trim().length > 0
      ? merged.trackerFilter
      : ALL_TRACKERS_FILTER;

  return merged;
}

/**
 * Formats metric values for KPI cards.
 */
function formatMetric(value: number, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "0.0";
}

/**
 * Merges raw events by deterministic id/eventId keys and keeps chronological ordering.
 */
function mergeRawEvents(existing: TrackerRawEvent[], incoming: TrackerRawEvent[]) {
  const merged = new Map<string, TrackerRawEvent>();
  const keyFor = (event: TrackerRawEvent) =>
    event.eventId && event.eventId !== "" ? event.eventId : event.id;

  for (const event of existing) merged.set(keyFor(event), event);
  for (const event of incoming) merged.set(keyFor(event), event);

  return Array.from(merged.values()).sort(
    (a, b) => (a.trackerTsMs - b.trackerTsMs) || ((a.ingestTsMs ?? 0) - (b.ingestTsMs ?? 0)),
  );
}

/**
 * Merges liveness snapshots by tracker id, preferring newest ingest timestamp.
 */
function mergeLivenessSnapshots(
  existing: TrackerLivenessSnapshot[],
  incoming: TrackerLivenessSnapshot[],
) {
  const merged = new Map<string, TrackerLivenessSnapshot>();

  for (const snapshot of existing) merged.set(snapshot.trackerId, snapshot);
  for (const snapshot of incoming) {
    const current = merged.get(snapshot.trackerId);
    if (!current || snapshot.lastIngestTsMs >= current.lastIngestTsMs) {
      merged.set(snapshot.trackerId, snapshot);
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.lastIngestTsMs - b.lastIngestTsMs);
}

/**
 * Trims trailing slashes to prevent malformed URL joins.
 */
function sanitizeUrl(url: string) {
  return url.replace(/\/+$/, "");
}

/**
 * Builds a normalized URL instance while tolerating missing protocols in manual input.
 */
function toUrl(url: string) {
  const normalized = sanitizeUrl(url.trim());
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return new URL(normalized);
  }

  return new URL(`https://${normalized}`);
}

/**
 * Convex queries are served on .convex.cloud.
 * If user provides .convex.site (HTTP actions host), convert to .cloud automatically.
 */
function resolveQueryBase(url: string) {
  const parsed = toUrl(url);
  if (parsed.hostname.endsWith(".convex.site")) {
    parsed.hostname = parsed.hostname.replace(/\.convex\.site$/, ".convex.cloud");
  }

  return parsed.origin;
}

/**
 * /contract/version typically lives on .convex.site (HTTP actions).
 * Provide fallbacks so either host works from user input.
 */
function resolveContractBases(url: string) {
  const parsed = toUrl(url);
  const bases: string[] = [];

  if (parsed.hostname.endsWith(".convex.site")) {
    bases.push(parsed.origin);
    const cloud = new URL(parsed.origin);
    cloud.hostname = cloud.hostname.replace(/\.convex\.site$/, ".convex.cloud");
    bases.push(cloud.origin);
  } else if (parsed.hostname.endsWith(".convex.cloud")) {
    const site = new URL(parsed.origin);
    site.hostname = site.hostname.replace(/\.convex\.cloud$/, ".convex.site");
    bases.push(site.origin);
    bases.push(parsed.origin);
  } else {
    bases.push(parsed.origin);
  }

  return Array.from(new Set(bases));
}

/**
 * Expands opaque Convex errors into actionable guidance for dashboard operators.
 */
function normalizeQueryError(message: string, functionPath: string, queryBase: string) {
  const trimmed = message.trim();

  if (trimmed.includes("No matching routes found")) {
    return `Convex query route not found at ${queryBase}/api/query. Use the deployment URL (convex.site or convex.cloud) and ensure API routing is enabled.`;
  }

  if (trimmed.includes("Server Error")) {
    return `${trimmed}. The deployment responded, but '${functionPath}' likely does not exist as a public query or it threw in the backend.`;
  }

  return trimmed;
}

/**
 * Extracts tracker identity from query args when present.
 */
function readPreferredTrackerId(argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    const candidate = parsed.trackerId ?? parsed.deviceId ?? parsed.tracker;
    return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Safe object narrowing for unknown query results.
 */
function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Pulls tracker ids from listTrackerLiveness query payloads.
 */
function parseTrackerIdsFromLiveness(payload: unknown) {
  if (!Array.isArray(payload)) return [] as string[];
  const ids = new Set<string>();
  for (const row of payload) {
    const obj = toRecord(row);
    if (!obj) continue;
    if (typeof obj.trackerId === "string" && obj.trackerId.trim().length > 0) {
      ids.add(obj.trackerId.trim());
    }
  }
  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

/**
 * Parses tracker plate assignment rows.
 */
function parseTrackerPlateAssignment(payload: unknown): TrackerPlateAssignment | null {
  const obj = toRecord(payload);
  if (!obj) return null;
  if (typeof obj.trackerName !== "string" || typeof obj.licensePlate !== "string") return null;
  const updatedAtCandidate =
    typeof obj.updatedAtMs === "number" && Number.isFinite(obj.updatedAtMs) ? obj.updatedAtMs : null;
  return {
    trackerName: obj.trackerName.trim(),
    licensePlate: obj.licensePlate.trim(),
    updatedAtMs: updatedAtCandidate,
  };
}

/**
 * Human-readable speed unit label.
 */
function speedUnitLabel(unit: SpeedUnit) {
  return unit === "mph" ? "mph" : "km/h";
}

/**
 * Converts speed values from canonical km/h into the selected display unit.
 */
function displaySpeed(kmh: number, unit: SpeedUnit) {
  return unit === "mph" ? kmh / MPH_TO_KMH : kmh;
}

/**
 * Heartbeat entries are currently encoded as 0,0 coordinates.
 * These records are retained for status monitoring but excluded from route rendering.
 */
function isHeartbeatPoint(point: TrackerPoint) {
  return Math.abs(point.lat) < 1e-8 && Math.abs(point.lng) < 1e-8;
}

/**
 * Normalizes upstream speed unit into canonical km/h.
 */
function normalizeSpeedUnit(points: TrackerPoint[], incoming: SpeedUnit): TrackerPoint[] {
  if (incoming === "kmh") return points;
  return points.map((point) => ({
    ...point,
    speedKmh: point.speedKmh * MPH_TO_KMH,
  }));
}

/**
 * Deterministic merge used by incremental sync:
 * - keeps existing points
 * - upserts newer payload entries
 * - returns time-ordered array
 */
function mergePoints(existing: TrackerPoint[], incoming: TrackerPoint[]) {
  const merged = new Map<string, TrackerPoint>();

  const keyFor = (point: TrackerPoint) =>
    point.id && point.id !== "" ? point.id : `${point.timestamp}-${point.lat.toFixed(6)}-${point.lng.toFixed(6)}`;

  for (const point of existing) merged.set(keyFor(point), point);
  for (const point of incoming) merged.set(keyFor(point), point);

  return Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Parses user-provided JSON args and optionally appends sinceTs for incremental sync.
 */
function buildArgs(base: string, sinceTs?: number, functionPath?: string, trackerFilterId?: string | null) {
  const parsed = base.trim().length === 0 ? {} : JSON.parse(base);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Function args must be a JSON object.");
  }

  const next = { ...(parsed as Record<string, unknown>) };
  const path = functionPath ?? "";

  if (trackerFilterId) {
    const supportsTrackerArg =
      "trackerId" in next ||
      path.includes("getTrackerEventHistory") ||
      path.includes("listTrackerLiveness") ||
      path.includes("getByTrackerName");

    if (supportsTrackerArg) {
      next.trackerId = trackerFilterId;
    }
  }

  if (!sinceTs) return next;

  // Map incremental cursor key to common Convex query signatures.
  if ("sinceIngestTsMs" in next || path.includes("listRecentRawEvents")) {
    next.sinceIngestTsMs = sinceTs;
    return next;
  }

  if (
    "startTrackerTsMs" in next ||
    path.includes("getTrackerEventHistory") ||
    path.includes("getEventsByType") ||
    path.includes("getBeaconHistory")
  ) {
    next.startTrackerTsMs = sinceTs;
    return next;
  }

  next.sinceTs = sinceTs;
  return next;
}

/**
 * Defensive date parsing to avoid runtime errors in date-driven controls.
 */
function toDateSafe(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
}

/**
 * Returns ISO date with replaced hour component.
 */
function withHour(sourceIso: string, hour: string) {
  const base = toDateSafe(sourceIso);
  base.setHours(Number(hour), 0, 0, 0);
  return base.toISOString();
}

/**
 * Returns ISO date with replaced calendar day while preserving the time component.
 */
function withDay(sourceIso: string, day: Date) {
  const base = toDateSafe(sourceIso);
  base.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  return base.toISOString();
}

/**
 * Predefined rolling window helper used by quick range preset buttons.
 */
function presetWindow(hours: number) {
  const now = new Date();
  const from = subHours(now, hours);
  from.setMinutes(0, 0, 0);
  now.setMinutes(59, 59, 999);
  return {
    timeFromIso: from.toISOString(),
    timeToIso: now.toISOString(),
  };
}

/**
 * Local fallback route to demo layout/interaction without a live backend.
 */
function createDemoRoute(): TrackerPoint[] {
  const baseTime = Date.now() - 75 * 60_000;
  const points: TrackerPoint[] = [];

  for (let i = 0; i < 34; i += 1) {
    const lat = 48.853 + i * 0.0012 + Math.sin(i * 0.33) * 0.0014;
    const lng = 2.32 + i * 0.0017 + Math.cos(i * 0.4) * 0.001;
    const speed = 28 + Math.abs(Math.sin(i * 0.55) * 42);

    points.push({
      id: `demo-${i}`,
      lat,
      lng,
      timestamp: baseTime + i * 140_000,
      speedKmh: speed,
      heading: 85 + i * 3.5,
      accuracy: 3 + (i % 4),
      battery: 82 - i,
      raw: { lat, lng, speed },
    });
  }

  return points;
}

/**
 * Builds synthetic raw_events from demo points so raw-event analytics can be previewed offline.
 */
function createDemoRawEvents(points: TrackerPoint[]): TrackerRawEvent[] {
  const trackerId = "pi-001";
  const events: TrackerRawEvent[] = [];

  points.forEach((point, index) => {
    const isCellFallback = index > 0 && index % 9 === 0;
    const eventType = isCellFallback ? "gps_cell_fallback" : "gps_fix";
    const trackerTsMs = point.timestamp;
    const ingestTsMs = trackerTsMs + (isCellFallback ? 12_000 : 3_000) + (index % 4) * 600;

    events.push({
      id: `demo-event-${index}`,
      eventId: `demo-event-${index}`,
      trackerId,
      eventType,
      trackerTsMs,
      ingestTsMs,
      seq: index + 1,
      locationMode: isCellFallback ? "cell_fallback" : "gnss_fix",
      location: {
        lat: point.lat,
        lon: point.lng,
        speedKmh: point.speedKmh,
        altM: point.altitude,
        method: isCellFallback ? "cell_lbs_native" : "gnss",
        accuracyM: isCellFallback ? 420 : 6,
        source: isCellFallback ? "sim7670_clbs" : "gnss_receiver",
      },
      raw: {
        eventType,
        trackerId,
        trackerTsMs,
        ingestTsMs,
      },
    });

    if (index > 0 && index % 8 === 0) {
      events.push({
        id: `demo-heartbeat-${index}`,
        eventId: `demo-heartbeat-${index}`,
        trackerId,
        eventType: "heartbeat",
        trackerTsMs: trackerTsMs + 40_000,
        ingestTsMs: ingestTsMs + 44_000,
        seq: 1000 + index,
        raw: {
          eventType: "heartbeat",
          trackerId,
          trackerTsMs: trackerTsMs + 40_000,
        },
      });
    }

    if (index > 0 && index % 11 === 0) {
      events.push({
        id: `demo-ble-${index}`,
        eventId: `demo-ble-${index}`,
        trackerId,
        eventType: "ble_scan",
        trackerTsMs: trackerTsMs + 22_000,
        ingestTsMs: ingestTsMs + 25_000,
        seq: 2000 + index,
        beaconId: `beacon-${String(index).padStart(3, "0")}`,
        raw: {
          eventType: "ble_scan",
          trackerId,
          trackerTsMs: trackerTsMs + 22_000,
          beaconId: `beacon-${String(index).padStart(3, "0")}`,
        },
      });
    }
  });

  events.sort((a, b) => (a.trackerTsMs - b.trackerTsMs) || ((a.ingestTsMs ?? 0) - (b.ingestTsMs ?? 0)));
  return events;
}

export function TrackerDashboard() {
  // Source + display state.
  const [settings, setSettings] = useState<DashboardSettings>(() => initialSettings());
  const [draftSettings, setDraftSettings] = useState<DashboardSettings>(() => initialSettings());
  const [points, setPoints] = useState<TrackerPoint[]>([]);
  const [events, setEvents] = useState<TrackerRawEvent[]>([]);
  const [liveness, setLiveness] = useState<TrackerLivenessSnapshot[]>([]);
  const [sourceModel, setSourceModel] = useState<TrackerSourceModel["sourceType"]>("legacy_points");
  const [contractVersion, setContractVersion] = useState<ContractVersionResponse | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [popupOpen, setPopupOpen] = useState(true);
  const [popupVersion, setPopupVersion] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recenterToken, setRecenterToken] = useState(0);
  const [trackerOptions, setTrackerOptions] = useState<TrackerDirectoryOption[]>([]);
  const [trackerFilterOpen, setTrackerFilterOpen] = useState(false);
  const [trackerFilterSearch, setTrackerFilterSearch] = useState("");
  const [isTrackerOptionsLoading, setIsTrackerOptionsLoading] = useState(false);
  const [plateAssignTrackerName, setPlateAssignTrackerName] = useState("");
  const [plateAssignValue, setPlateAssignValue] = useState("");
  const [isAssigningPlate, setIsAssigningPlate] = useState(false);
  const [plateAssignFeedback, setPlateAssignFeedback] = useState<string | null>(null);
  const pointsRef = useRef<TrackerPoint[]>([]);
  const eventsRef = useRef<TrackerRawEvent[]>([]);
  const livenessRef = useRef<TrackerLivenessSnapshot[]>([]);

  // Mutable ref avoids stale closures during background sync cycles.
  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    livenessRef.current = liveness;
  }, [liveness]);

  // Restore persisted settings on client boot.
  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as StoredDashboardSettings;
      const merged = migrateStoredSettings(parsed);
      setSettings(merged);
      setDraftSettings(merged);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...merged, __version: SETTINGS_VERSION }));
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  /**
   * Centralized settings persistence to keep UI state and localStorage in sync.
   */
  const persistSettings = useCallback((nextSettings: DashboardSettings) => {
    const normalized = {
      ...nextSettings,
      functionPath: normalizeFunctionPath(nextSettings.functionPath),
      trackerFilter:
        typeof nextSettings.trackerFilter === "string" && nextSettings.trackerFilter.trim().length > 0
          ? nextSettings.trackerFilter
          : ALL_TRACKERS_FILTER,
    };
    setSettings(normalized);
    setDraftSettings(normalized);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...normalized, __version: SETTINGS_VERSION }));
  }, []);

  /**
   * Executes a Convex function call against /api/query.
   */
  const runConvexQuery = useCallback(
    async (path: string, args: Record<string, unknown>) => {
      const normalizedPath = normalizeFunctionPath(path);
      const queryBase = resolveQueryBase(settings.convexUrl);
      const response = await fetch(`${queryBase}/api/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: normalizedPath, args, format: "json" }),
      });

      const raw = await response.text();
      let body: QueryResponse | null = null;
      try {
        body = JSON.parse(raw) as QueryResponse;
      } catch {
        body = null;
      }

      const message =
        body?.errorMessage ??
        body?.message ??
        (typeof raw === "string" ? raw : "") ??
        "Failed to fetch tracker points from Convex.";

      if (!response.ok || body?.status === "error") {
        throw new Error(normalizeQueryError(message, normalizedPath, queryBase));
      }

      return body?.value ?? body?.result ?? body ?? raw;
    },
    [settings.convexUrl],
  );

  /**
   * Dashboard primary data query helper (uses selected function path from settings).
   */
  const runQuery = useCallback(
    async (args: Record<string, unknown>, pathOverride?: string) => {
      const queryPath = pathOverride ?? settings.functionPath;
      return runConvexQuery(queryPath, args);
    },
    [runConvexQuery, settings.functionPath],
  );

  /**
   * Executes Convex mutation calls (used for license plate assignment).
   */
  const runMutation = useCallback(
    async (path: string, args: Record<string, unknown>) => {
      const queryBase = resolveQueryBase(settings.convexUrl);
      const response = await fetch(`${queryBase}/api/mutation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      });

      const raw = await response.text();
      let body: QueryResponse | null = null;
      try {
        body = JSON.parse(raw) as QueryResponse;
      } catch {
        body = null;
      }

      const message =
        body?.errorMessage ??
        body?.message ??
        (typeof raw === "string" ? raw : "") ??
        "Failed to run Convex mutation.";

      if (!response.ok || body?.status === "error") {
        throw new Error(message.trim());
      }

      return body?.value ?? body?.result ?? body ?? raw;
    },
    [settings.convexUrl],
  );

  const knownTrackerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of liveness) {
      if (row.trackerId.trim().length > 0) ids.add(row.trackerId);
    }
    for (const event of events) {
      if (event.trackerId.trim().length > 0) ids.add(event.trackerId);
    }
    for (const point of points) {
      if (typeof point.trackerId === "string" && point.trackerId.trim().length > 0) {
        ids.add(point.trackerId);
      }
    }
    return Array.from(ids).sort((a, b) => a.localeCompare(b));
  }, [events, liveness, points]);

  /**
   * Loads tracker list + plate assignments for the searchable tracker filter.
   */
  const loadTrackerOptions = useCallback(async () => {
    setIsTrackerOptionsLoading(true);
    try {
      const livenessPayload = await runConvexQuery("queries:listTrackerLiveness", { limit: 250 });
      const livenessTrackerIds = parseTrackerIdsFromLiveness(livenessPayload);
      const trackerIds = livenessTrackerIds;

      if (trackerIds.length === 0) {
        setTrackerOptions([]);
        return;
      }

      const rows = await Promise.all(
        trackerIds.map(async (trackerId) => {
          try {
            const rowPayload = await runConvexQuery("trackerPlates:getByTrackerName", { trackerName: trackerId });
            return parseTrackerPlateAssignment(rowPayload);
          } catch {
            return null;
          }
        }),
      );

      const byTracker = new Map<string, TrackerPlateAssignment>();
      for (const row of rows) {
        if (!row) continue;
        byTracker.set(row.trackerName, row);
      }

      setTrackerOptions(
        trackerIds.map((trackerId) => ({
          trackerId,
          licensePlate: byTracker.get(trackerId)?.licensePlate ?? null,
          updatedAtMs: byTracker.get(trackerId)?.updatedAtMs ?? null,
        })),
      );
    } catch {
      // Keep existing options when metadata endpoints are temporarily unavailable.
    } finally {
      setIsTrackerOptionsLoading(false);
    }
  }, [runConvexQuery]);

  useEffect(() => {
    void loadTrackerOptions();
  }, [loadTrackerOptions]);

  useEffect(() => {
    if (!trackerFilterOpen) return;
    void loadTrackerOptions();
  }, [loadTrackerOptions, trackerFilterOpen]);

  const assignLicensePlate = useCallback(async () => {
    const trackerName = plateAssignTrackerName.trim();
    const licensePlate = plateAssignValue.trim().toUpperCase();

    if (!trackerName || !licensePlate) {
      setPlateAssignFeedback("Enter both tracker name and license plate.");
      return;
    }

    setIsAssigningPlate(true);
    setPlateAssignFeedback(null);
    try {
      await runMutation("trackerPlates:assignLicensePlate", { trackerName, licensePlate });
      setPlateAssignFeedback(`Assigned ${licensePlate} to ${trackerName}.`);
      setPlateAssignValue(licensePlate);
      await loadTrackerOptions();
    } catch (assignmentError) {
      const message =
        assignmentError instanceof Error ? assignmentError.message : "Could not assign license plate in Convex.";
      setPlateAssignFeedback(message);
    } finally {
      setIsAssigningPlate(false);
    }
  }, [loadTrackerOptions, plateAssignTrackerName, plateAssignValue, runMutation]);

  /**
   * Reads ingest contract metadata when available.
   * This endpoint exists in the new raw-events backend and is optional for legacy sources.
   */
  useEffect(() => {
    let cancelled = false;

    const fetchContractVersion = async () => {
      const candidates = resolveContractBases(settings.convexUrl);

      for (const base of candidates) {
        try {
          const response = await fetch(`${base}/contract/version`);
          if (!response.ok) continue;
          const body = (await response.json()) as Partial<ContractVersionResponse>;
          if (cancelled) return;

          if (typeof body.contractVersion === "string" && typeof body.minCompatibleMajor === "number") {
            setContractVersion({
              contractVersion: body.contractVersion,
              minCompatibleMajor: body.minCompatibleMajor,
            });
            return;
          }
        } catch {
          // Try next candidate host.
        }
      }

      if (!cancelled) setContractVersion(null);
    };

    void fetchContractVersion();
    return () => {
      cancelled = true;
    };
  }, [settings.convexUrl]);

  /**
   * Route sync pipeline:
   * - optional incremental query (sinceTs)
   * - fallback to full query if backend rejects sinceTs
   * - normalize schema and speed units
   * - merge or replace point set depending on sync mode
   */
  const fetchRoute = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      if (background) {
        setIsSyncing(true);
      } else {
        setError(null);
        if (pointsRef.current.length === 0) setIsLoading(true);
      }

      try {
        const latestPoints = pointsRef.current;
        const latestEvents = eventsRef.current;
        const latestLiveness = livenessRef.current;
        const useIncremental =
          background && settings.incrementalSync && (latestPoints.length > 0 || latestEvents.length > 0);
        const sinceTs = useIncremental
          ? latestEvents[latestEvents.length - 1]?.trackerTsMs ?? latestPoints[latestPoints.length - 1]?.timestamp
          : undefined;
        const trackerFilterId = settings.trackerFilter !== ALL_TRACKERS_FILTER ? settings.trackerFilter : null;

        let payload: unknown;
        const baseArgs = buildArgs(settings.argsJson, undefined, settings.functionPath, trackerFilterId);

        if (useIncremental && sinceTs) {
          try {
            payload = await runQuery(buildArgs(settings.argsJson, sinceTs, settings.functionPath, trackerFilterId));
          } catch {
            // If incremental args are unsupported by the selected function,
            // retry a full fetch to keep dashboard compatibility high.
            payload = await runQuery(baseArgs);
          }
        } else {
          payload = await runQuery(baseArgs);
        }

        const parsed = parseTrackerSourcePayload(payload);

        const normalizedPoints =
          parsed.sourceType === "legacy_points"
            ? normalizeSpeedUnit(parsed.points, settings.incomingSpeedUnit)
            : parsed.points;

        const nextPoints = useIncremental ? mergePoints(latestPoints, normalizedPoints) : normalizedPoints;
        const nextEvents = useIncremental ? mergeRawEvents(latestEvents, parsed.events) : parsed.events;

        const incomingLiveness = parsed.liveness.length > 0 ? parsed.liveness : deriveLivenessFromEvents(parsed.events);
        const nextLiveness = useIncremental
          ? mergeLivenessSnapshots(latestLiveness, incomingLiveness)
          : incomingLiveness;

        if (nextPoints.length === 0 && nextEvents.length === 0 && latestPoints.length === 0 && latestEvents.length === 0) {
          throw new Error("No tracker telemetry found in the response.");
        }

        setPoints(nextPoints);
        setEvents(nextEvents);
        setLiveness(nextLiveness.length > 0 ? nextLiveness : deriveLivenessFromEvents(nextEvents));
        setSourceModel(parsed.sourceType);
        setLastUpdatedAt(Date.now());
        setError(null);
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : "Unknown error while loading data.";
        setError(message);
        if (!background) {
          setPoints([]);
          setEvents([]);
          setLiveness([]);
        }
      } finally {
        setIsLoading(false);
        setIsSyncing(false);
      }
    },
    [
      runQuery,
      settings.argsJson,
      settings.functionPath,
      settings.incomingSpeedUnit,
      settings.incrementalSync,
      settings.trackerFilter,
    ],
  );

  // Initial load.
  useEffect(() => {
    void fetchRoute();
  }, [fetchRoute]);

  // Periodic background sync.
  useEffect(() => {
    if (!settings.autoRefresh) return;
    const id = window.setInterval(() => {
      void fetchRoute({ background: true });
    }, Math.max(5, settings.refreshSeconds) * 1000);
    return () => window.clearInterval(id);
  }, [fetchRoute, settings.autoRefresh, settings.refreshSeconds]);

  const argsTrackerId = useMemo(() => readPreferredTrackerId(settings.argsJson), [settings.argsJson]);
  const activeTrackerId = settings.trackerFilter !== ALL_TRACKERS_FILTER ? settings.trackerFilter : argsTrackerId;

  useEffect(() => {
    if (!activeTrackerId) return;
    if (plateAssignTrackerName.trim().length > 0) return;
    setPlateAssignTrackerName(activeTrackerId);
  }, [activeTrackerId, plateAssignTrackerName]);

  // Route-only points are used for map/line/statistics; heartbeat points are tracked separately.
  const routePoints = useMemo(() => {
    const nonHeartbeat = points.filter((point) => !isHeartbeatPoint(point));
    if (!activeTrackerId || sourceModel === "legacy_points") return nonHeartbeat;
    return nonHeartbeat.filter((point) => point.trackerId === activeTrackerId);
  }, [activeTrackerId, points, sourceModel]);

  // Normalize user date range ordering to support accidental reversed inputs.
  const fromTs = useMemo(() => toDateSafe(settings.timeFromIso).getTime(), [settings.timeFromIso]);
  const toTs = useMemo(() => toDateSafe(settings.timeToIso).getTime(), [settings.timeToIso]);
  const [windowStartTs, windowEndTs] = fromTs <= toTs ? [fromTs, toTs] : [toTs, fromTs];

  const filteredRoutePoints = useMemo(
    () => routePoints.filter((point) => point.timestamp >= windowStartTs && point.timestamp <= windowEndTs),
    [routePoints, windowStartTs, windowEndTs],
  );

  const trackerScopedEvents = useMemo(() => {
    if (!activeTrackerId || sourceModel === "legacy_points") return events;
    return events.filter((event) => event.trackerId === activeTrackerId);
  }, [activeTrackerId, events, sourceModel]);

  const filteredEvents = useMemo(
    () => trackerScopedEvents.filter((event) => event.trackerTsMs >= windowStartTs && event.trackerTsMs <= windowEndTs),
    [trackerScopedEvents, windowStartTs, windowEndTs],
  );

  // Keep a valid selected point when filters change; auto-select latest in-range point.
  useEffect(() => {
    if (filteredRoutePoints.length === 0) {
      setSelectedPointId(null);
      setPopupOpen(false);
      return;
    }

    if (selectedPointId && filteredRoutePoints.some((point) => point.id === selectedPointId)) return;
    setSelectedPointId(filteredRoutePoints[filteredRoutePoints.length - 1]?.id ?? null);
    setPopupOpen(true);
    setPopupVersion((value) => value + 1);
  }, [filteredRoutePoints, selectedPointId]);

  // Resolve selected point object from selected id.
  const selectedPoint = useMemo(() => {
    if (filteredRoutePoints.length === 0) return null;
    return (
      filteredRoutePoints.find((point) => point.id === selectedPointId) ?? filteredRoutePoints[filteredRoutePoints.length - 1]
    );
  }, [filteredRoutePoints, selectedPointId]);

  // Current index for timeline slider positioning.
  const selectedIndex = useMemo(() => {
    if (!selectedPoint) return -1;
    return filteredRoutePoints.findIndex((point) => point.id === selectedPoint.id);
  }, [filteredRoutePoints, selectedPoint]);

  const selectedLiveness = useMemo(() => {
    if (liveness.length === 0) return null;
    if (activeTrackerId) {
      return liveness.find((row) => row.trackerId === activeTrackerId) ?? liveness[liveness.length - 1] ?? null;
    }
    return liveness[liveness.length - 1] ?? null;
  }, [activeTrackerId, liveness]);

  const latestEvent = useMemo(() => {
    if (trackerScopedEvents.length === 0) return null;
    if (activeTrackerId) {
      const perTracker = trackerScopedEvents.filter((event) => event.trackerId === activeTrackerId);
      return perTracker[perTracker.length - 1] ?? trackerScopedEvents[trackerScopedEvents.length - 1] ?? null;
    }
    return trackerScopedEvents[trackerScopedEvents.length - 1] ?? null;
  }, [activeTrackerId, trackerScopedEvents]);

  // Legacy fallback heartbeat representation (0,0 pseudo points).
  const heartbeatPoints = useMemo(() => {
    const onlyHeartbeats = points.filter((point) => isHeartbeatPoint(point));
    if (!activeTrackerId || sourceModel === "legacy_points") return onlyHeartbeats;
    return onlyHeartbeats.filter((point) => point.trackerId === activeTrackerId);
  }, [activeTrackerId, points, sourceModel]);
  const latestHeartbeatPoint = heartbeatPoints[heartbeatPoints.length - 1] ?? null;

  // Raw-schema heartbeat/no-fix events.
  const noLocationEvents = useMemo(
    () => filteredEvents.filter((event) => event.eventType === "heartbeat" || event.eventType === "gps_no_fix"),
    [filteredEvents],
  );
  const latestNoLocationEvent = noLocationEvents[noLocationEvents.length - 1] ?? null;

  const lastSignalTs = useMemo(
    () =>
      selectedLiveness?.lastIngestTsMs ??
      latestEvent?.ingestTsMs ??
      latestEvent?.trackerTsMs ??
      points[points.length - 1]?.timestamp ??
      null,
    [latestEvent, points, selectedLiveness],
  );

  const disconnectThresholdMs = Math.max(settings.refreshSeconds * 3000, 120000);

  const latestKnownLocationMode = useMemo(() => {
    const scopedEvents = activeTrackerId
      ? events.filter((event) => event.trackerId === activeTrackerId)
      : events;

    for (let index = scopedEvents.length - 1; index >= 0; index -= 1) {
      const event = scopedEvents[index];
      if (typeof event.locationMode === "string" && event.locationMode.length > 0) return event.locationMode;
      if (event.eventType === "gps_cell_fallback") return "cell_fallback";
      if (event.eventType === "gps_fix") return "gnss_fix";
    }

    return null;
  }, [activeTrackerId, events]);

  const locationStatus = useMemo(() => {
    if (!lastSignalTs) {
      return { label: "Disconnected", tone: "signal-offline", detail: "No recent signal" };
    }

    const ageMs = Date.now() - lastSignalTs;
    if (ageMs > disconnectThresholdMs) {
      return {
        label: "Disconnected",
        tone: "signal-offline",
        detail: `Last signal ${formatDistanceStrict(lastSignalTs, Date.now())} ago`,
      };
    }

    const latestEventType = selectedLiveness?.lastEventType ?? latestEvent?.eventType;
    const latestLocationMode = selectedLiveness?.locationMode ?? latestEvent?.locationMode ?? latestKnownLocationMode;

    if (latestEventType === "gps_fix") {
      return { label: "GPS available", tone: "signal-live", detail: "Live coordinates available" };
    }

    if (latestEventType === "gps_cell_fallback" || latestLocationMode === "cell_fallback") {
      return { label: "Cell fallback", tone: "signal-fallback", detail: "Coarse LBS coordinates in use" };
    }

    if (latestEventType === "ble_scan" || latestEventType === "rfid_scan") {
      return { label: "Beacon activity", tone: "signal-heartbeat", detail: "Tracker active, waiting for GPS event" };
    }

    if (latestEventType === "heartbeat" || latestEventType === "gps_no_fix") {
      return { label: "Heartbeat only", tone: "signal-heartbeat", detail: "No GPS fix yet" };
    }

    if (points.length > 0) {
      return { label: "GPS available", tone: "signal-live", detail: "Route points available" };
    }

    return { label: "No location fix", tone: "signal-heartbeat", detail: "Telemetry active, awaiting location" };
  }, [disconnectThresholdMs, lastSignalTs, latestEvent, latestKnownLocationMode, points, selectedLiveness]);

  const eventActivityStatus = useMemo(() => {
    if (!lastSignalTs) {
      return { label: "No event activity", tone: "signal-offline", detail: "No events in current window" };
    }

    const ageMs = Date.now() - lastSignalTs;
    if (ageMs > disconnectThresholdMs) {
      return { label: "No event activity", tone: "signal-offline", detail: "Tracker appears offline" };
    }

    const latestEventType = selectedLiveness?.lastEventType ?? latestEvent?.eventType ?? "";

    if (latestEventType === "ble_scan" || latestEventType === "rfid_scan") {
      return { label: "BLE/RFID activity", tone: "signal-heartbeat", detail: "Beacon scan received" };
    }

    if (latestEventType === "heartbeat" || latestEventType === "gps_no_fix") {
      return { label: "Heartbeat activity", tone: "signal-heartbeat", detail: "Heartbeat received" };
    }

    if (latestEventType === "gps_fix" || latestEventType === "gps_cell_fallback") {
      return { label: "Location activity", tone: "signal-live", detail: "Location event received" };
    }

    return { label: "Telemetry activity", tone: "signal-heartbeat", detail: "Recent event received" };
  }, [disconnectThresholdMs, lastSignalTs, latestEvent, selectedLiveness]);

  const stats = useMemo(() => getTrackerStats(filteredRoutePoints), [filteredRoutePoints]);
  const eventInsights = useMemo(() => getEventInsights(filteredEvents), [filteredEvents]);
  const locationEventCount = useMemo(
    () => filteredEvents.filter((event) => !!event.location).length,
    [filteredEvents],
  );
  const uniqueCoordinateCount = useMemo(() => {
    const unique = new Set<string>();
    for (const event of filteredEvents) {
      if (!event.location) continue;
      unique.add(`${event.location.lat.toFixed(5)},${event.location.lon.toFixed(5)}`);
    }
    return unique.size;
  }, [filteredEvents]);
  const collapsedLocationStream =
    locationEventCount > 1 && uniqueCoordinateCount <= 1 && eventInsights.gpsFixCount === 0;
  const telemetrySummary = useMemo(() => {
    if (!lastSignalTs) {
      return "No telemetry received in the current window.";
    }

    if (collapsedLocationStream) {
      return "Cell fallback is active with one repeated coordinate, so the map intentionally collapses to one point.";
    }

    if (eventInsights.gpsFixCount === 0 && eventInsights.gpsCellFallbackCount > 0) {
      return "Only cell fallback coordinates are available right now (no GNSS fixes yet).";
    }

    if (eventInsights.gpsFixCount > 0) {
      return "GNSS fixes are present; route movement should appear when coordinates change.";
    }

    return "Heartbeat or beacon activity detected without location updates.";
  }, [collapsedLocationStream, eventInsights.gpsCellFallbackCount, eventInsights.gpsFixCount, lastSignalTs]);
  const lastSeenLabel = lastSignalTs ? `${formatDistanceStrict(lastSignalTs, Date.now())} ago` : "No signal yet";
  const recentBeaconScans = useMemo(
    () =>
      filteredEvents
        .filter((event) => event.eventType === "ble_scan" || event.eventType === "rfid_scan")
        .slice(-4)
        .reverse(),
    [filteredEvents],
  );

  // Recharts data model.
  const chartData = useMemo(
    () =>
      filteredRoutePoints.map((point, index) => ({
        index,
        speed: Number(displaySpeed(point.speedKmh, settings.displaySpeedUnit).toFixed(2)),
        label: new Date(point.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      })),
    [filteredRoutePoints, settings.displaySpeedUnit],
  );

  /**
   * Validates and persists editable data source settings from the side panel.
   */
  const applySettings = useCallback(() => {
    const next = {
      ...draftSettings,
      refreshSeconds: Number.isFinite(Number(draftSettings.refreshSeconds))
        ? Math.max(5, Number(draftSettings.refreshSeconds))
        : 20,
    };
    persistSettings(next);
  }, [draftSettings, persistSettings]);

  /**
   * Updates only the display unit (does not change stored canonical data).
   */
  const setDisplayUnit = useCallback(
    (unit: SpeedUnit) => {
      persistSettings({ ...settings, displaySpeedUnit: unit });
    },
    [persistSettings, settings],
  );

  /**
   * Shared updater for date/hour controls.
   */
  const updateTimeRange = useCallback(
    (next: Partial<Pick<DashboardSettings, "timeFromIso" | "timeToIso">>) => {
      persistSettings({ ...settings, ...next });
    },
    [persistSettings, settings],
  );

  /**
   * Applies a rolling-window preset (1h/6h/24h/7d).
   */
  const applyPreset = useCallback(
    (hours: number) => {
      persistSettings({ ...settings, ...presetWindow(hours) });
    },
    [persistSettings, settings],
  );

  /**
   * Recommended preset for the current production Convex deployment.
   */
  const useDefaultEventHistoryPreset = useCallback(() => {
    setDraftSettings((current) => ({
      ...current,
      convexUrl: DEFAULT_CONVEX_CLOUD_URL,
      functionPath: DEFAULT_RECOMMENDED_PATH,
      argsJson: DEFAULT_RECOMMENDED_ARGS,
    }));
  }, []);

  /**
   * Alternate preset showing recent events across trackers.
   */
  const useDefaultAllEventsPreset = useCallback(() => {
    setDraftSettings((current) => ({
      ...current,
      convexUrl: DEFAULT_CONVEX_CLOUD_URL,
      functionPath: DEFAULT_ALL_EVENTS_PATH,
      argsJson: DEFAULT_ALL_EVENTS_ARGS,
    }));
  }, []);

  /**
   * Local demo dataset loader for smoke-testing the UI without backend availability.
   */
  const loadDemo = useCallback(() => {
    const seedPoints = createDemoRoute();
    const demoEvents = createDemoRawEvents(seedPoints);
    const demoPoints = rawEventsToTrackerPoints(demoEvents);
    const demoLiveness = deriveLivenessFromEvents(demoEvents);

    setPoints(demoPoints);
    setEvents(demoEvents);
    setLiveness(demoLiveness);
    setSourceModel("raw_events");
    setSelectedPointId(demoPoints[demoPoints.length - 1]?.id ?? null);
    setPopupOpen(true);
    setPopupVersion((value) => value + 1);
    setError(null);
    setLastUpdatedAt(Date.now());
    setIsLoading(false);
    setIsSyncing(false);
  }, []);

  /**
   * Central point-selection handler shared by map and popup interactions.
   */
  const handleSelectPoint = useCallback((point: TrackerPoint | null) => {
    if (!point) {
      setPopupOpen(false);
      return;
    }

    setSelectedPointId(point.id);
    setPopupOpen(true);
    setPopupVersion((value) => value + 1);
  }, []);

  const statusTone = error ? "destructive" : "secondary";
  const fromDate = toDateSafe(settings.timeFromIso);
  const toDate = toDateSafe(settings.timeToIso);
  const now = new Date();
  const nowTimeLabel = format(now, "h:mm a");
  const nowDateLabel = format(now, "d MMMM");
  const signalState =
    locationStatus.label === "GPS available"
      ? "live"
      : locationStatus.label === "Cell fallback"
        ? "fallback"
      : locationStatus.label === "Disconnected"
        ? "offline"
        : "heartbeat";
  const statusBadgeClass = cn(
    "status-pill",
    error
      ? "status-pill-error"
      : signalState === "live"
        ? "status-pill-live"
        : signalState === "fallback"
          ? "status-pill-fallback"
        : signalState === "heartbeat"
          ? "status-pill-heartbeat"
          : "status-pill-offline",
  );
  const mergedTrackerOptions = useMemo(() => {
    const byTracker = new Map<string, TrackerDirectoryOption>();
    for (const option of trackerOptions) byTracker.set(option.trackerId, option);
    for (const trackerId of knownTrackerIds) {
      if (byTracker.has(trackerId)) continue;
      byTracker.set(trackerId, { trackerId, licensePlate: null, updatedAtMs: null });
    }
    return Array.from(byTracker.values()).sort((a, b) => a.trackerId.localeCompare(b.trackerId));
  }, [knownTrackerIds, trackerOptions]);

  const filteredTrackerOptions = useMemo(() => {
    const search = trackerFilterSearch.trim().toLowerCase();
    if (!search) return mergedTrackerOptions;
    return mergedTrackerOptions.filter((option) => {
      return (
        option.trackerId.toLowerCase().includes(search) ||
        (option.licensePlate ? option.licensePlate.toLowerCase().includes(search) : false)
      );
    });
  }, [mergedTrackerOptions, trackerFilterSearch]);

  const selectedTrackerOption = useMemo(() => {
    if (!activeTrackerId) return null;
    return mergedTrackerOptions.find((option) => option.trackerId === activeTrackerId) ?? null;
  }, [activeTrackerId, mergedTrackerOptions]);

  const trackerFilterLabel = activeTrackerId
    ? selectedTrackerOption?.licensePlate
      ? `${selectedTrackerOption.licensePlate} · ${activeTrackerId}`
      : activeTrackerId
    : "Select tracker";

  const applyTrackerFilter = useCallback(
    (trackerId: string | null) => {
      persistSettings({
        ...settings,
        trackerFilter: trackerId ?? ALL_TRACKERS_FILTER,
      });
      if (trackerId) setPlateAssignTrackerName(trackerId);
      setTrackerFilterSearch("");
      setTrackerFilterOpen(false);
    },
    [persistSettings, settings],
  );

  return (
    <div className="dashboard-shell min-h-screen px-3 py-4 text-foreground md:px-5 md:py-5">
      <div className="dashboard-canvas mx-auto flex w-full max-w-[1520px] flex-col gap-4 md:gap-5">
        <header className="surface-panel hero-panel entry-fade reveal-1 p-4 md:p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-4xl">
              <p className="font-pixel mb-2 text-[10px] uppercase tracking-[0.34em] text-muted-foreground/90">Tracker dashboard</p>
              <h1 className="font-display text-4xl tracking-tight md:text-[3rem]">Overview</h1>
              <p className="mt-2.5 text-sm text-muted-foreground md:text-base">
                Route monitor for Convex raw ingest data with incremental syncing, event analytics, and time-window
                filtering.
              </p>
            </div>
            <div className="min-w-[220px] space-y-1 text-left md:text-right">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Tracker node</p>
              <p className="time-label text-2xl md:text-3xl">{nowTimeLabel}</p>
              <p className="date-label text-xl md:text-2xl">{nowDateLabel}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Popover open={trackerFilterOpen} onOpenChange={setTrackerFilterOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="control-chip border-border bg-card">
                    <GitBranch className="mr-1.5 h-4 w-4" />
                    <span className="max-w-[240px] truncate text-left">Tracker: {trackerFilterLabel}</span>
                    <ChevronsUpDown className="ml-1.5 h-3.5 w-3.5 opacity-70" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[360px] border-border bg-card p-3">
                  <div className="space-y-2">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        value={trackerFilterSearch}
                        onChange={(event) => setTrackerFilterSearch(event.target.value)}
                        placeholder="Search tracker or license plate"
                        className="pl-8"
                      />
                    </div>
                    <div className="max-h-64 space-y-1 overflow-auto pr-1">
                      {filteredTrackerOptions.map((option) => (
                        <button
                          key={option.trackerId}
                          type="button"
                          className="flex w-full items-center justify-between rounded-md border border-border/70 px-2.5 py-2 text-left hover:bg-muted/50"
                          onClick={() => applyTrackerFilter(option.trackerId)}
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{option.trackerId}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {option.licensePlate ? `Plate ${option.licensePlate}` : "No license plate assigned"}
                            </div>
                          </div>
                          {activeTrackerId === option.trackerId && <Check className="ml-3 h-4 w-4 text-[color:var(--tone-accent)]" />}
                        </button>
                      ))}

                      {!isTrackerOptionsLoading && filteredTrackerOptions.length === 0 && (
                        <div className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
                          No tracker matches your search.
                        </div>
                      )}
                      {isTrackerOptionsLoading && (
                        <div className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
                          Loading tracker options...
                        </div>
                      )}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>

              <div className="control-chip flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
                <span className={settings.displaySpeedUnit === "mph" ? "font-semibold" : "text-muted-foreground"}>MPH</span>
                <Switch
                  checked={settings.displaySpeedUnit === "kmh"}
                  onCheckedChange={(checked) => setDisplayUnit(checked ? "kmh" : "mph")}
                />
                <span className={settings.displaySpeedUnit === "kmh" ? "font-semibold" : "text-muted-foreground"}>KM/H</span>
              </div>

              <Button variant="outline" className="control-chip border-border bg-card" onClick={() => void fetchRoute()}>
                <RefreshCw className={cn("mr-1.5 h-4 w-4", isSyncing && "animate-spin")} />
                Refresh
              </Button>

              <Button variant="outline" className="control-chip border-border bg-card" onClick={() => setRecenterToken((value) => value + 1)}>
                <LocateFixed className="mr-1.5 h-4 w-4" />
                Recenter
              </Button>

              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="outline" className="control-chip border-border bg-card">
                    <Settings2 className="mr-1.5 h-4 w-4" />
                    Data source
                  </Button>
                </SheetTrigger>
              <SheetContent
                side="right"
                className="settings-sheet border-border bg-card w-[min(96vw,760px)] sm:max-w-[760px] overflow-y-auto"
              >
                <SheetHeader className="px-6 pt-6 pb-2">
                  <SheetTitle>Convex source settings</SheetTitle>
                </SheetHeader>
                <div className="mt-2 space-y-6 px-6 pb-6">
                  <div className="space-y-2">
                    <Label htmlFor="convex-url">Convex URL</Label>
                    <Input
                      id="convex-url"
                      value={draftSettings.convexUrl}
                      onChange={(event) => setDraftSettings((current) => ({ ...current, convexUrl: event.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="function-path">Public query path</Label>
                    <Input
                      id="function-path"
                      value={draftSettings.functionPath}
                      onChange={(event) =>
                        setDraftSettings((current) => ({ ...current, functionPath: event.target.value }))
                      }
                    />
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button type="button" size="sm" variant="outline" className="h-7" onClick={useDefaultEventHistoryPreset}>
                        Beautiful bison (default)
                      </Button>
                      <Button type="button" size="sm" variant="outline" className="h-7" onClick={useDefaultAllEventsPreset}>
                        Beautiful bison (all events)
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Raw backend repo stores data in <code>raw_events</code> and <code>tracker_liveness</code>. You
                      need a public query that returns those rows. Recommended default for this deployment is{" "}
                      <code>queries:getTrackerEventHistory</code> with{" "}
                      <code>{"{\"trackerId\":\"pi-5-gateway-01\",\"limit\":500}"}</code>.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="args-json">Function args (JSON)</Label>
                    <textarea
                      id="args-json"
                      className="settings-textarea min-h-36 w-full rounded-md border border-border bg-input/40 p-3 text-sm outline-none transition focus:ring-2"
                      value={draftSettings.argsJson}
                      onChange={(event) => setDraftSettings((current) => ({ ...current, argsJson: event.target.value }))}
                    />
                  </div>

                  <div className="space-y-3 rounded-md border border-border/70 bg-input/10 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-sm">Assign license plate to tracker</Label>
                      {activeTrackerId && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7"
                          onClick={() => setPlateAssignTrackerName(activeTrackerId)}
                        >
                          Use selected tracker
                        </Button>
                      )}
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="plate-tracker-name" className="text-xs text-muted-foreground">Tracker name</Label>
                        <Input
                          id="plate-tracker-name"
                          value={plateAssignTrackerName}
                          onChange={(event) => setPlateAssignTrackerName(event.target.value)}
                          placeholder="pi-5-gateway-01"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="plate-value" className="text-xs text-muted-foreground">License plate</Label>
                        <Input
                          id="plate-value"
                          value={plateAssignValue}
                          onChange={(event) => setPlateAssignValue(event.target.value.toUpperCase())}
                          placeholder="ZH123456"
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button type="button" size="sm" disabled={isAssigningPlate} onClick={() => void assignLicensePlate()}>
                        {isAssigningPlate ? "Assigning..." : "Assign plate"}
                      </Button>
                      {plateAssignFeedback && (
                        <p className="text-xs text-muted-foreground">{plateAssignFeedback}</p>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-3">
                    <div className="settings-row flex items-center justify-between rounded-md border border-border bg-input/20 px-3 py-2">
                      <Label htmlFor="incoming-speed" className="text-sm">Incoming speed is MPH</Label>
                      <Switch
                        id="incoming-speed"
                        checked={draftSettings.incomingSpeedUnit === "mph"}
                        onCheckedChange={(checked) =>
                          setDraftSettings((current) => ({ ...current, incomingSpeedUnit: checked ? "mph" : "kmh" }))
                        }
                      />
                    </div>

                    <div className="settings-row flex items-center justify-between rounded-md border border-border bg-input/20 px-3 py-2">
                      <Label htmlFor="incremental-sync" className="text-sm">Incremental sync</Label>
                      <Switch
                        id="incremental-sync"
                        checked={draftSettings.incrementalSync}
                        onCheckedChange={(checked) =>
                          setDraftSettings((current) => ({ ...current, incrementalSync: checked }))
                        }
                      />
                    </div>

                    <div className="settings-row flex items-center justify-between rounded-md border border-border bg-input/20 px-3 py-2">
                      <Label htmlFor="auto-refresh" className="text-sm">Auto refresh</Label>
                      <Switch
                        id="auto-refresh"
                        checked={draftSettings.autoRefresh}
                        onCheckedChange={(checked) =>
                          setDraftSettings((current) => ({ ...current, autoRefresh: checked }))
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="refresh-seconds">Refresh interval (seconds)</Label>
                    <Input
                      id="refresh-seconds"
                      type="number"
                      min={5}
                      value={draftSettings.refreshSeconds}
                      onChange={(event) =>
                        setDraftSettings((current) => ({ ...current, refreshSeconds: Number(event.target.value) }))
                      }
                    />
                  </div>

                  <div className="flex gap-3 pt-1">
                    <Button className="flex-1" onClick={applySettings}>Apply settings</Button>
                    <Button variant="outline" className="flex-1" onClick={loadDemo}>Load demo route</Button>
                  </div>
                </div>
                </SheetContent>
              </Sheet>
            </div>

            <Badge variant={statusTone} className={statusBadgeClass}>
              {error ? "Connection issue" : locationStatus.label}
            </Badge>
          </div>
        </header>

        <Card className="surface-card filter-panel entry-fade reveal-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <CalendarClock className="h-4 w-4" />
              Map timespan
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="preset-chip border-border bg-card" onClick={() => applyPreset(1)}>
                Last 1h
              </Button>
              <Button size="sm" variant="outline" className="preset-chip border-border bg-card" onClick={() => applyPreset(6)}>
                Last 6h
              </Button>
              <Button size="sm" variant="outline" className="preset-chip border-border bg-card" onClick={() => applyPreset(24)}>
                Last 24h
              </Button>
              <Button size="sm" variant="outline" className="preset-chip border-border bg-card" onClick={() => applyPreset(24 * 7)}>
                Last 7d
              </Button>
            </div>

            <div className="grid gap-2.5 md:grid-cols-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">From date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="field-control w-full justify-start border-border bg-card text-left font-normal">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(fromDate, "PPP")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto border-border bg-card p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={fromDate}
                    onSelect={(date) => {
                      if (!date) return;
                      updateTimeRange({ timeFromIso: withDay(settings.timeFromIso, date) });
                    }}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">From hour</Label>
              <Select
                value={String(fromDate.getHours()).padStart(2, "0")}
                onValueChange={(value) => updateTimeRange({ timeFromIso: withHour(settings.timeFromIso, value) })}
              >
                <SelectTrigger className="field-control w-full border-border bg-card">
                  <SelectValue placeholder="Hour" />
                </SelectTrigger>
                <SelectContent className="border-border bg-card">
                  {HOURS.map((hour) => (
                    <SelectItem key={`from-${hour}`} value={hour}>{hour}:00</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">To date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="field-control w-full justify-start border-border bg-card text-left font-normal">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(toDate, "PPP")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto border-border bg-card p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={toDate}
                    onSelect={(date) => {
                      if (!date) return;
                      updateTimeRange({ timeToIso: withDay(settings.timeToIso, date) });
                    }}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">To hour</Label>
              <Select
                value={String(toDate.getHours()).padStart(2, "0")}
                onValueChange={(value) => updateTimeRange({ timeToIso: withHour(settings.timeToIso, value) })}
              >
                <SelectTrigger className="field-control w-full border-border bg-card">
                  <SelectValue placeholder="Hour" />
                </SelectTrigger>
                <SelectContent className="border-border bg-card">
                  {HOURS.map((hour) => (
                    <SelectItem key={`to-${hour}`} value={hour}>{hour}:00</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            </div>
          </CardContent>
        </Card>

        <section className="entry-fade reveal-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Card className="surface-card metric-card">
            <CardHeader className="pb-2"><CardTitle className="metric-label text-sm font-medium text-muted-foreground">Distance</CardTitle></CardHeader>
            <CardContent className="flex items-center gap-3"><Route className="h-4 w-4 text-[color:var(--tone-accent)]" /><div className="metric-value text-2xl font-semibold">{formatMetric(stats.distanceKm)} km</div></CardContent>
          </Card>
          <Card className="surface-card metric-card">
            <CardHeader className="pb-2"><CardTitle className="metric-label text-sm font-medium text-muted-foreground">Average speed</CardTitle></CardHeader>
            <CardContent className="flex items-center gap-3"><Activity className="h-4 w-4 text-[color:var(--tone-accent)]" /><div className="metric-value text-2xl font-semibold">{formatMetric(displaySpeed(stats.avgSpeedKmh, settings.displaySpeedUnit))} {speedUnitLabel(settings.displaySpeedUnit)}</div></CardContent>
          </Card>
          <Card className="surface-card metric-card">
            <CardHeader className="pb-2"><CardTitle className="metric-label text-sm font-medium text-muted-foreground">Peak speed</CardTitle></CardHeader>
            <CardContent className="flex items-center gap-3"><Gauge className="h-4 w-4 text-[color:var(--tone-accent)]" /><div className="metric-value text-2xl font-semibold">{formatMetric(displaySpeed(stats.maxSpeedKmh, settings.displaySpeedUnit))} {speedUnitLabel(settings.displaySpeedUnit)}</div></CardContent>
          </Card>
          <Card className="surface-card metric-card">
            <CardHeader className="pb-2"><CardTitle className="metric-label text-sm font-medium text-muted-foreground">Track duration</CardTitle></CardHeader>
            <CardContent className="flex items-center gap-3"><Timer className="h-4 w-4 text-[color:var(--tone-accent)]" /><div className="metric-value text-2xl font-semibold">{Math.round(stats.durationMinutes)} min</div></CardContent>
          </Card>
          <Card className="surface-card metric-card">
            <CardHeader className="pb-2"><CardTitle className="metric-label text-sm font-medium text-muted-foreground">Signal status</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Location</span>
                <div className="flex items-center gap-2">
                  <span className={cn("signal-dot", locationStatus.tone)} />
                  <span className="text-sm font-semibold">{locationStatus.label}</span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Events</span>
                <div className="flex items-center gap-2">
                  <span className={cn("signal-dot", eventActivityStatus.tone)} />
                  <span className="text-sm font-semibold">{eventActivityStatus.label}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <Card className="surface-card heartbeat-card entry-fade reveal-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Last no-fix / heartbeat signal</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-2 md:grid-cols-4">
              <div>
                <span className="text-muted-foreground">Time:</span>{" "}
                <span className="font-medium">
                  {latestNoLocationEvent
                    ? format(new Date(latestNoLocationEvent.trackerTsMs), "PPpp")
                    : latestHeartbeatPoint
                      ? format(new Date(latestHeartbeatPoint.timestamp), "PPpp")
                      : "No heartbeat yet"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Tracker:</span>{" "}
                <span className="font-medium">
                  {latestNoLocationEvent?.trackerId ?? activeTrackerId ?? "N/A"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Type:</span>{" "}
                <span className="font-medium">
                  {latestNoLocationEvent
                    ? latestNoLocationEvent.eventType.replace(/_/g, " ")
                    : latestHeartbeatPoint
                      ? "legacy heartbeat"
                      : "N/A"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Payload:</span>{" "}
                <span className="font-medium">
                  {latestNoLocationEvent?.raw?.sourcePayload
                    ? "sourcePayload available"
                    : latestHeartbeatPoint?.raw?.raw
                      ? "NO_FIX heartbeat"
                      : "N/A"}
                </span>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <div className="rounded-md border border-border/70 bg-transparent p-2.5">
                <p className="text-xs text-muted-foreground">Last seen</p>
                <p className="mt-0.5 text-base font-semibold">{lastSeenLabel}</p>
              </div>
              <div className="rounded-md border border-border/70 bg-transparent p-2.5">
                <p className="text-xs text-muted-foreground">Location events</p>
                <p className="mt-0.5 text-base font-semibold">{locationEventCount}</p>
              </div>
              <div className="rounded-md border border-border/70 bg-transparent p-2.5">
                <p className="text-xs text-muted-foreground">Unique coordinates</p>
                <p className="mt-0.5 text-base font-semibold">{uniqueCoordinateCount}</p>
              </div>
            </div>
            <div className="rounded-md border border-dashed border-border/70 bg-transparent p-2.5 text-xs text-muted-foreground">
              {telemetrySummary}
            </div>
          </CardContent>
        </Card>

        <Card className="surface-card entry-fade reveal-5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Event intelligence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid items-start gap-2.5 text-sm md:grid-cols-3 xl:grid-cols-6">
              <div className="rounded-md border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">Total events</p>
                <p className="mt-1 text-lg font-semibold">{eventInsights.totalEvents}</p>
              </div>
              <div className="rounded-md border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">GPS fixes</p>
                <p className="mt-1 text-lg font-semibold">{eventInsights.gpsFixCount}</p>
              </div>
              <div className="rounded-md border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">Cell fallback</p>
                <p className="mt-1 text-lg font-semibold">
                  {eventInsights.gpsCellFallbackCount} ({(eventInsights.cellFallbackRatio * 100).toFixed(1)}%)
                </p>
              </div>
              <div className="rounded-md border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">No-fix events</p>
                <p className="mt-1 text-lg font-semibold">
                  {eventInsights.gpsNoFixCount} ({(eventInsights.noFixRatio * 100).toFixed(1)}%)
                </p>
              </div>
              <div className="rounded-md border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">BLE/RFID scans</p>
                <p className="mt-1 text-lg font-semibold">{eventInsights.bleScanCount + eventInsights.rfidScanCount}</p>
              </div>
              <div className="rounded-md border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">P95 ingest lag</p>
                <p className="mt-1 text-lg font-semibold">{Math.round(eventInsights.p95IngestLagSeconds)} s</p>
              </div>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Recent beacon scans</div>
                <div className="text-xs text-muted-foreground">{recentBeaconScans.length} shown</div>
              </div>
              {recentBeaconScans.length === 0 ? (
                <div className="rounded-md border border-dashed border-border bg-card p-3 text-muted-foreground">
                  No BLE/RFID scans in current payload.
                </div>
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {recentBeaconScans.map((event) => (
                    <div
                      key={event.id}
                      className="min-w-[220px] shrink-0 rounded-md border border-border bg-card p-3 sm:min-w-[240px]"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">{event.eventType.replace(/_/g, " ")}</span>
                        <span className="text-xs text-muted-foreground">{format(new Date(event.trackerTsMs), "HH:mm:ss")}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Tracker: {event.trackerId}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {event.beaconId ? `Beacon: ${event.beaconId}` : "No beacon id"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {error && (
          <Card className="surface-card">
            <CardContent className="flex items-start gap-3 py-4 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 text-[color:var(--tone-accent)]" />
              <div>
                <p className="font-semibold">Could not load Convex route data.</p>
                <p className="text-muted-foreground">{error}</p>
              </div>
            </CardContent>
          </Card>
        )}

        <section className="entry-fade reveal-5 grid gap-3 xl:grid-cols-12">
          <Card className="surface-card map-panel xl:col-span-8">
            <CardContent className="p-3.5 md:p-4">
              {collapsedLocationStream && (
                <div className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                  Map note: multiple events share one fallback coordinate, so route points overlap into a single visible
                  position.
                </div>
              )}
              {isLoading ? (
                <Skeleton className="h-[440px] w-full rounded-md bg-card md:h-[500px]" />
              ) : (
                <RouteMap
                  points={filteredRoutePoints}
                  selectedPoint={selectedPoint}
                  popupOpen={popupOpen}
                  popupVersion={popupVersion}
                  onSelectPoint={handleSelectPoint}
                  speedUnit={settings.displaySpeedUnit}
                  recenterToken={recenterToken}
                />
              )}

              <div className="timeline-control mt-3 space-y-2">
                <div className="flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground">
                  <span>Route timeline</span>
                  <span>{selectedIndex >= 0 ? `${selectedIndex + 1}/${filteredRoutePoints.length} points` : "No points"}</span>
                </div>
                <input
                  type="range"
                  className="timeline-slider h-2 w-full cursor-pointer appearance-none rounded-full bg-muted"
                  min={0}
                  max={Math.max(0, filteredRoutePoints.length - 1)}
                  value={Math.max(0, selectedIndex)}
                  onChange={(event) => {
                    const index = Number(event.target.value);
                    const next = filteredRoutePoints[index];
                    if (!next) return;
                    setSelectedPointId(next.id);
                    setPopupOpen(true);
                    setPopupVersion((value) => value + 1);
                  }}
                  disabled={filteredRoutePoints.length === 0}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="surface-card inspector-panel xl:col-span-4">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base"><GitBranch className="h-4 w-4" />Point inspector</CardTitle>
            </CardHeader>
            <CardContent>
              {selectedPoint ? (
                <Tabs defaultValue="telemetry" className="w-full">
                  <TabsList className="w-full border border-border bg-card">
                    <TabsTrigger className="flex-1" value="telemetry">Telemetry</TabsTrigger>
                    <TabsTrigger className="flex-1" value="raw">Raw data</TabsTrigger>
                  </TabsList>

                  <TabsContent value="telemetry" className="mt-4 space-y-3 text-sm">
                    <div className="inspector-grid grid gap-2 rounded-md border border-border bg-card p-3">
                      <div className="flex justify-between gap-4"><span className="text-muted-foreground">Coordinates</span><span className="font-medium">{selectedPoint.lat.toFixed(5)}, {selectedPoint.lng.toFixed(5)}</span></div>
                      <div className="flex justify-between gap-4"><span className="text-muted-foreground">Speed</span><span className="font-medium">{displaySpeed(selectedPoint.speedKmh, settings.displaySpeedUnit).toFixed(1)} {speedUnitLabel(settings.displaySpeedUnit)}</span></div>
                      <div className="flex justify-between gap-4"><span className="text-muted-foreground">Timestamp</span><span className="font-medium">{new Date(selectedPoint.timestamp).toLocaleString()}</span></div>
                      {selectedPoint.eventType && <div className="flex justify-between gap-4"><span className="text-muted-foreground">Event type</span><span className="font-medium">{selectedPoint.eventType.replace(/_/g, " ")}</span></div>}
                      {selectedPoint.locationMethod && <div className="flex justify-between gap-4"><span className="text-muted-foreground">Location method</span><span className="font-medium">{selectedPoint.locationMethod}</span></div>}
                      {typeof selectedPoint.heading === "number" && <div className="flex justify-between gap-4"><span className="text-muted-foreground">Heading</span><span className="font-medium">{selectedPoint.heading.toFixed(0)} deg</span></div>}
                      {typeof selectedPoint.accuracy === "number" && <div className="flex justify-between gap-4"><span className="text-muted-foreground">Accuracy</span><span className="font-medium">{selectedPoint.accuracy.toFixed(1)} m</span></div>}
                      {typeof selectedPoint.battery === "number" && <div className="flex justify-between gap-4"><span className="text-muted-foreground">Battery</span><span className="font-medium">{selectedPoint.battery.toFixed(0)}%</span></div>}
                    </div>
                  </TabsContent>

                  <TabsContent value="raw" className="mt-4">
                    <pre className="max-h-[330px] overflow-auto rounded-md border border-border bg-card p-3 text-xs leading-relaxed text-foreground/80">{JSON.stringify(selectedPoint.raw, null, 2)}</pre>
                  </TabsContent>
                </Tabs>
              ) : (
                <div className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">No point in current timespan.</div>
              )}

              <Separator className="my-4 bg-border" />

              <div className="space-y-1 text-xs text-muted-foreground/90">
                <div>Last refresh: {lastUpdatedAt ? formatDistanceStrict(lastUpdatedAt, Date.now()) + " ago" : "never"}</div>
                <div>Source: {sanitizeUrl(settings.convexUrl)}</div>
                <div>Function: {settings.functionPath}</div>
                <div>Model: {sourceModel === "raw_events" ? "raw_events + tracker_liveness" : "legacy points"}</div>
                {contractVersion && <div>Contract: v{contractVersion.contractVersion} (major {contractVersion.minCompatibleMajor})</div>}
                <div>Events in memory: {events.length}</div>
                {selectedLiveness && <div>Liveness tracker: {selectedLiveness.trackerId}</div>}
                <div className="font-mono">Incoming speed: {speedUnitLabel(settings.incomingSpeedUnit)}</div>
                <div>Window: {format(new Date(windowStartTs), "PP HH:mm")} to {format(new Date(windowEndTs), "PP HH:mm")}</div>
              </div>
            </CardContent>
          </Card>
        </section>

        <Card className="surface-card speed-panel entry-fade reveal-6">
          <CardHeader><CardTitle className="text-base">Speed profile</CardTitle></CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-card px-5 py-8 text-center text-sm text-muted-foreground">No speed samples in this timespan.</div>
            ) : (
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 18, right: 16, left: 8, bottom: 4 }}>
                    <defs>
                      <linearGradient id="speedGradientDark" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--tone-accent)" stopOpacity={0.36} />
                        <stop offset="95%" stopColor="var(--tone-accent)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="2 4" stroke="var(--tone-line)" opacity={0.72} />
                    <XAxis dataKey="label" tickMargin={8} stroke="var(--tone-line)" minTickGap={20} />
                    <YAxis
                      stroke="var(--tone-line)"
                      width={72}
                      tickMargin={6}
                      domain={[0, (max: number) => Math.max(10, Math.ceil(max * 1.1))]}
                    />
                    <ChartTooltip
                      contentStyle={{
                        borderRadius: 8,
                        border: "1px solid var(--tone-line)",
                        backgroundColor: "var(--tone-panel)",
                        color: "var(--tone-text)",
                      }}
                    />
                    <Area type="monotone" dataKey="speed" stroke="var(--tone-accent)" strokeWidth={2} fill="url(#speedGradientDark)" activeDot={{ r: 4, stroke: "var(--tone-accent)", strokeWidth: 1.5 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
