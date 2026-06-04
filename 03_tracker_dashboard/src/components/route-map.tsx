"use client";

import { useEffect, useMemo, useRef } from "react";
import Map, {
  Layer,
  NavigationControl,
  Popup,
  ScaleControl,
  Source,
  type LayerProps,
  type MapLayerMouseEvent,
  type MapRef,
} from "react-map-gl/maplibre";
import type { Feature, FeatureCollection, Point } from "geojson";
import { Clock3, Gauge, MapPin, X } from "lucide-react";
import { format } from "date-fns";

import type { TrackerPoint } from "@/lib/tracker";

type SpeedUnit = "kmh" | "mph";

type RouteMapProps = {
  points: TrackerPoint[];
  selectedPoint: TrackerPoint | null;
  popupOpen: boolean;
  popupVersion: number;
  onSelectPoint: (point: TrackerPoint | null) => void;
  speedUnit: SpeedUnit;
  recenterToken: number;
};

const MPH_TO_KMH = 1.60934;
// Stable dark base style; additional tonal tuning happens in global CSS.
const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const POINT_SOURCE_ID = "route-points-source";
const MAP_THEME = {
  panel: "#171b18",
  text: "#dde5db",
  accent: "#b9d8be",
} as const;

// Route polyline styling.
const lineLayer = {
  id: "route-line",
  type: "line",
  paint: {
    "line-color": MAP_THEME.accent,
    "line-width": 3,
    "line-opacity": 0.9,
  },
} as const;

// Cluster circle styling.
const clusterLayer: LayerProps = {
  id: "route-clusters",
  type: "circle",
  filter: ["has", "point_count"],
  paint: {
    "circle-color": MAP_THEME.panel,
    "circle-stroke-color": MAP_THEME.accent,
    "circle-stroke-width": 1.5,
    "circle-radius": ["step", ["get", "point_count"], 14, 25, 18, 75, 22],
  },
};

// Cluster counter labels.
const clusterCountLayer: LayerProps = {
  id: "route-cluster-count",
  type: "symbol",
  filter: ["has", "point_count"],
  layout: {
    "text-field": ["get", "point_count_abbreviated"],
    "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
    "text-size": 11,
  },
  paint: {
    "text-color": MAP_THEME.text,
  },
};

// Visual point marker.
const unclusteredPointLayer: LayerProps = {
  id: "route-point-unclustered",
  type: "circle",
  filter: ["!", ["has", "point_count"]],
  paint: {
    "circle-radius": ["case", ["==", ["get", "eventType"], "gps_cell_fallback"], 5.4, 4.8],
    "circle-color": [
      "case",
      ["==", ["get", "eventType"], "gps_cell_fallback"],
      MAP_THEME.text,
      MAP_THEME.accent,
    ],
    "circle-stroke-color": [
      "case",
      ["==", ["get", "eventType"], "gps_cell_fallback"],
      MAP_THEME.panel,
      MAP_THEME.text,
    ],
    "circle-stroke-width": 1.4,
  },
};

// Transparent but larger hit area used to improve click reliability.
const unclusteredHitLayer: LayerProps = {
  id: "route-point-hitbox",
  type: "circle",
  filter: ["!", ["has", "point_count"]],
  paint: {
    "circle-radius": 12,
    "circle-color": MAP_THEME.text,
    "circle-opacity": 0,
  },
};

// Active point emphasis rendered independently of clustering.
const selectedPointGlowLayer: LayerProps = {
  id: "route-point-selected-glow",
  type: "circle",
  paint: {
    "circle-radius": 17,
    "circle-color": MAP_THEME.accent,
    "circle-opacity": 0.35,
    "circle-blur": 0.8,
  },
};

const selectedPointCoreLayer: LayerProps = {
  id: "route-point-selected-core",
  type: "circle",
  paint: {
    "circle-radius": 6.4,
    "circle-color": MAP_THEME.accent,
    "circle-stroke-color": MAP_THEME.text,
    "circle-stroke-width": 2,
  },
};

/**
 * Formats lat/lng for compact popup display.
 */
function formatCoordinates(lat: number, lng: number) {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/**
 * Formats speed using the current dashboard output unit.
 */
function formatSpeed(kmh: number, unit: SpeedUnit) {
  if (unit === "mph") return `${(kmh / MPH_TO_KMH).toFixed(1)} mph`;
  return `${kmh.toFixed(1)} km/h`;
}

/**
 * Map canvas for route visualization.
 * Responsibilities:
 * - draw route line + points + clusters
 * - fit camera when route/timespan changes
 * - select telemetry points on direct hit and pixel-nearest fallback
 * - render point details popup
 */
export function RouteMap({
  points,
  selectedPoint,
  popupOpen,
  popupVersion,
  onSelectPoint,
  speedUnit,
  recenterToken,
}: RouteMapProps) {
  const mapRef = useRef<MapRef | null>(null);
  const hasAutoFitted = useRef(false);
  const lastRecenterToken = useRef<number>(recenterToken);
  const lastCenteredPointId = useRef<string | null>(null);

  // GeoJSON source for the route polyline.
  const lineData = useMemo(() => {
    if (points.length === 0) {
      return {
        type: "FeatureCollection",
        features: [],
      } as FeatureCollection;
    }

    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: points.map((point) => [point.lng, point.lat]),
          },
          properties: {},
        },
      ],
    } as FeatureCollection;
  }, [points]);

  // GeoJSON source for route points (clustered by MapLibre).
  const pointsData = useMemo(() => {
    return {
      type: "FeatureCollection",
      features: points.map((point) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [point.lng, point.lat],
        },
        properties: {
          pointId: point.id,
          eventType: point.eventType ?? "gps_fix",
          locationMethod: point.locationMethod ?? "gnss",
          accuracy: point.accuracy ?? null,
        },
      })),
    } as FeatureCollection;
  }, [points]);

  // Dedicated selected-point source lets us render a persistent highlight ring.
  const selectedPointData = useMemo(() => {
    if (!selectedPoint) {
      return {
        type: "FeatureCollection",
        features: [],
      } as FeatureCollection;
    }

    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [selectedPoint.lng, selectedPoint.lat],
          },
          properties: {},
        },
      ],
    } as FeatureCollection;
  }, [selectedPoint]);

  // Auto fit is intentionally guarded to avoid map resets on every background sync.
  useEffect(() => {
    if (points.length === 0) {
      hasAutoFitted.current = false;
      return;
    }

    const shouldFit = !hasAutoFitted.current || lastRecenterToken.current !== recenterToken;
    if (!shouldFit || !mapRef.current) return;

    const first = points[0];
    let minLng = first.lng;
    let maxLng = first.lng;
    let minLat = first.lat;
    let maxLat = first.lat;

    for (const point of points) {
      minLng = Math.min(minLng, point.lng);
      maxLng = Math.max(maxLng, point.lng);
      minLat = Math.min(minLat, point.lat);
      maxLat = Math.max(maxLat, point.lat);
    }

    mapRef.current.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      {
        padding: 80,
        duration: hasAutoFitted.current ? 700 : 1200,
      },
    );

    hasAutoFitted.current = true;
    lastRecenterToken.current = recenterToken;
  }, [points, recenterToken]);

  // Timeline/map selection should smoothly bring the selected point into view.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !selectedPoint) return;

    if (lastCenteredPointId.current === selectedPoint.id) return;

    map.easeTo({
      center: [selectedPoint.lng, selectedPoint.lat],
      duration: 620,
      essential: true,
    });
    lastCenteredPointId.current = selectedPoint.id;
  }, [selectedPoint]);

  const center = points[0] ?? { lat: 37.7749, lng: -122.4194 };

  /**
   * Handles point selection:
   * 1) zoom into cluster clicks
   * 2) resolve direct point hits by pointId
   * 3) fallback to nearest point in pixel space for resilience
   */
  const handleMapClick = (event: MapLayerMouseEvent) => {
    const map = mapRef.current?.getMap();
    if (!map || points.length === 0) return;

    const feature = event.features?.[0] as
      | Feature<
          Point,
          {
            pointId?: string | number;
            cluster?: boolean | number | string;
            point_count?: number | string;
            cluster_id?: number | string;
          }
        >
      | undefined;

    if (feature && feature.geometry.type === "Point") {
      const [lng, lat] = feature.geometry.coordinates;
      const properties = feature.properties;

      const rawCluster = properties?.cluster;
      const clusterStr = String(rawCluster);
      const rawPointCount = properties?.point_count;
      const parsedPointCount =
        typeof rawPointCount === "string" ? Number(rawPointCount) : typeof rawPointCount === "number" ? rawPointCount : null;
      const hasClusterCount = typeof parsedPointCount === "number" && Number.isFinite(parsedPointCount) && parsedPointCount > 1;
      const isCluster = rawCluster === true || rawCluster === 1 || clusterStr === "true" || clusterStr === "1" || hasClusterCount;

      if (isCluster) {
        map.easeTo({ center: [lng, lat], zoom: Math.min((map.getZoom() ?? 0) + 2, 20), duration: 350 });
        return;
      }

      const pointId = properties?.pointId;
      if (pointId !== undefined && pointId !== null) {
        const selectedById = points.find((point) => point.id === String(pointId));
        if (selectedById) {
          onSelectPoint(selectedById);
          return;
        }
      }
    }

    // Pixel-distance fallback so points remain selectable even if feature hit-testing misses.
    const clickPoint = event.point;
    const maxDistancePx = 16;
    const maxDistanceSquared = maxDistancePx * maxDistancePx;
    let nearest: TrackerPoint | null = null;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;

    for (const point of points) {
      const projected = map.project([point.lng, point.lat]);
      const dx = projected.x - clickPoint.x;
      const dy = projected.y - clickPoint.y;
      const distanceSquared = dx * dx + dy * dy;

      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        nearest = point;
      }
    }

    if (nearest && bestDistanceSquared <= maxDistanceSquared) {
      onSelectPoint(nearest);
    }
  };

  return (
    <div className="route-map-frame relative h-[440px] w-full overflow-hidden rounded-md border border-border bg-card md:h-[500px]">
      <Map
        ref={mapRef}
        initialViewState={{
          latitude: center.lat,
          longitude: center.lng,
          zoom: points.length > 0 ? 11 : 4,
        }}
        mapStyle={MAP_STYLE}
        reuseMaps
        // We only receive feature-level click payloads from these layers.
        attributionControl={false}
        interactiveLayerIds={["route-clusters", "route-point-hitbox", "route-point-unclustered"]}
        onClick={handleMapClick}
      >
        <NavigationControl position="top-right" showCompass={false} />
        <ScaleControl position="bottom-left" />

        <Source id="route-line-source" type="geojson" data={lineData}>
          <Layer {...lineLayer} />
        </Source>

        <Source id={POINT_SOURCE_ID} type="geojson" data={pointsData} cluster clusterRadius={22} clusterMaxZoom={12}>
          <Layer {...clusterLayer} />
          <Layer {...clusterCountLayer} />
          <Layer {...unclusteredHitLayer} />
          <Layer {...unclusteredPointLayer} />
        </Source>

        <Source id="route-selected-point-source" type="geojson" data={selectedPointData}>
          <Layer {...selectedPointGlowLayer} />
          <Layer {...selectedPointCoreLayer} />
        </Source>

        {selectedPoint && popupOpen && (
          // popupVersion forces remount so reopening after close is reliable.
          <Popup
            key={`${selectedPoint.id}-${popupVersion}`}
            longitude={selectedPoint.lng}
            latitude={selectedPoint.lat}
            closeButton={false}
            closeOnClick={false}
            offset={14}
          >
            <div className="telemetry-popup w-64 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">Telemetry point</div>
                <button
                  type="button"
                  className="telemetry-popup-close inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border transition"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelectPoint(null);
                  }}
                  aria-label="Close popup"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {selectedPoint.eventType && (
                <div className="rounded-sm border border-border/70 bg-muted/30 px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {selectedPoint.eventType.replace(/_/g, " ")}
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" />
                <span>{formatCoordinates(selectedPoint.lat, selectedPoint.lng)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5" />
                <span>{formatSpeed(selectedPoint.speedKmh, speedUnit)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock3 className="h-3.5 w-3.5" />
                <span>{format(selectedPoint.timestamp, "PPpp")}</span>
              </div>
              {typeof selectedPoint.accuracy === "number" && (
                <div>Accuracy: {selectedPoint.accuracy.toFixed(1)} m</div>
              )}
              {selectedPoint.locationMethod && (
                <div>Method: {selectedPoint.locationMethod}</div>
              )}
              {typeof selectedPoint.altitude === "number" && (
                <div>Altitude: {selectedPoint.altitude.toFixed(1)} m</div>
              )}
              {typeof selectedPoint.battery === "number" && (
                <div>Battery: {selectedPoint.battery.toFixed(0)}%</div>
              )}
            </div>
          </Popup>
        )}
      </Map>

      {points.length === 0 && (
        <div className="telemetry-empty-state pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-md border border-border bg-card px-5 py-2 text-sm text-foreground/80">
            No route points loaded yet
          </div>
        </div>
      )}
    </div>
  );
}
