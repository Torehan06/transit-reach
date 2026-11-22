import maplibregl, { ExpressionSpecification, GeoJSONSource, MapLayerMouseEvent, MapMouseEvent } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { CitySummary, MODES, MODE_BY_CODE, ModeCode, StationRecord } from './types';

const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';

const COLOR_STREET_UNCOVERED = 'rgba(148, 163, 184, 0.16)';
const COLOR_DOT_COVERED = '#fbbf24';
const COLOR_DOT_UNCOVERED = '#94a3b8';

/**
 * Street colour by walking time to the nearest selected station (5 km/h):
 * bright under 5 min, fading through 10/15/20 min, dark past ~30 min.
 * Exported so the legend can draw the same ramp.
 */
export const WALK_RAMP: [number, string][] = [
  [0, '#ccfbf1'],
  [417, '#2dd4bf'], // 5 min
  [833, '#38bdf8'], // 10 min
  [1250, '#818cf8'], // 15 min
  [1667, '#a78bfa'], // 20 min
  [2500, '#6d28d9'], // 30 min
  [3300, '#3b0764'],
];
const FAR_DIST = 999999;
const MIN_TILE_ZOOM = 8; // city PMTiles have no tiles below this

export interface InspectModeHit {
  mode: ModeCode;
  distanceM: number;
  station: StationRecord;
  approx?: boolean;
}

function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface DotSample {
  lon: number;
  lat: number;
  props: Record<string, number>;
}

export { haversineMeters };

export interface InspectResult {
  lngLat: [number, number];
  best: InspectModeHit | null;
  byMode: InspectModeHit[];
  withinReach: boolean;
  noModesEnabled: boolean;
}

export class TransitMap {
  public readonly map: maplibregl.Map;
  private protocolRegistered = false;
  private ready = false;
  private currentCity: CitySummary | null = null;
  private stationsById = new Map<number, StationRecord>();
  private stationsList: StationRecord[] = [];
  private lastEnabledModes: ModeCode[] = MODES.map((m) => m.code);
  private lastDistanceM = 1609;
  private lastShowDots = true;
  private lastShowStations = true;
  private pendingRaf: number | null = null;
  private lastInspectProps: { lngLat: [number, number]; props: Record<string, unknown> } | null = null;
  private onInspectCallback: ((res: InspectResult | null) => void) | null = null;
  private onZoomCallback: ((zoom: number) => void) | null = null;
  /** When set (e.g. while sketching a line), map clicks go here instead of the inspect card. */
  public clickOverride: ((lngLat: [number, number]) => void) | null = null;

  constructor(
    container: HTMLElement,
    callbacks: {
      onReady: () => void;
      onZoom: (zoom: number) => void;
      onInspect: (res: InspectResult | null) => void;
    }
  ) {
    this.onInspectCallback = callbacks.onInspect;
    this.onZoomCallback = callbacks.onZoom;

    if (!this.protocolRegistered) {
      const protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
      this.protocolRegistered = true;
    }

    this.map = new maplibregl.Map({
      container,
      style: OPENFREEMAP_STYLE,
      center: [32.85, 39.92],
      zoom: 11,
      minZoom: MIN_TILE_ZOOM,
      maxZoom: 17.5,
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
    });

    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    this.map.on('load', () => {
      this.ready = true;
      this.dimBasemap();
      this.initOverlaySources();
      callbacks.onReady();
    });

    this.map.on('zoom', () => {
      if (this.onZoomCallback) {
        this.onZoomCallback(this.map.getZoom());
      }
    });

    this.map.on('click', (e: MapMouseEvent) => {
      this.handleMapClick(e);
    });
  }

  private dimBasemap(): void {
    // Soften basemap road lines slightly so our transit streets & population dots stand out
    const style = this.map.getStyle();
    if (!style?.layers) return;
    for (const layer of style.layers) {
      if (layer.type === 'line' && /road|highway|bridge|tunnel|street|rail/i.test(layer.id)) {
        try {
          this.map.setPaintProperty(layer.id, 'line-opacity', 0.25);
        } catch {
          // Ignore expression-incompatible layers
        }
      }
    }
  }

  private initOverlaySources(): void {
    this.map.addSource('stations-src', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    this.map.addSource('inspect-src', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    // Build mode color match expression for stations
    const modeColorExpr: ExpressionSpecification = [
      'match',
      ['get', 'mode'],
      'm', MODE_BY_CODE.m.color,
      't', MODE_BY_CODE.t.color,
      'c', MODE_BY_CODE.c.color,
      'b', MODE_BY_CODE.b.color,
      'f', MODE_BY_CODE.f.color,
      'u', MODE_BY_CODE.u.color,
      '#ffffff',
    ];

    this.map.addLayer({
      id: 'stations-layer',
      type: 'circle',
      source: 'stations-src',
      paint: {
        'circle-color': modeColorExpr,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.4, 12, 4.2, 15, 6.2],
        'circle-stroke-color': '#0b0f17',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 13, 1.5],
        'circle-opacity': ['case', ['==', ['get', 'inside'], 1], 0.95, 0.35],
        'circle-stroke-opacity': ['case', ['==', ['get', 'inside'], 1], 0.95, 0.35],
      },
    });

    // Inspect connector line + highlight rings
    this.map.addLayer({
      id: 'inspect-line-layer',
      type: 'line',
      source: 'inspect-src',
      filter: ['==', ['get', 'kind'], 'connector'],
      paint: {
        'line-color': '#f8fafc',
        'line-width': 2,
        'line-dasharray': [3, 3],
        'line-opacity': 0.85,
      },
    });

    this.map.addLayer({
      id: 'inspect-station-ring',
      type: 'circle',
      source: 'inspect-src',
      filter: ['==', ['get', 'kind'], 'station'],
      paint: {
        'circle-radius': 11,
        'circle-color': 'rgba(255, 255, 255, 0.15)',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
      },
    });

    this.map.addLayer({
      id: 'inspect-tap-point',
      type: 'circle',
      source: 'inspect-src',
      filter: ['==', ['get', 'kind'], 'tap'],
      paint: {
        'circle-radius': 6,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#0b0f17',
        'circle-stroke-width': 2,
      },
    });

    // Pointer cursor on hover over stations
    this.map.on('mouseenter', 'stations-layer', () => {
      this.map.getCanvas().style.cursor = 'pointer';
    });
    this.map.on('mouseleave', 'stations-layer', () => {
      this.map.getCanvas().style.cursor = '';
    });
  }

  private buildMinDistExpression(modes: ModeCode[]): ExpressionSpecification | null {
    if (modes.length === 0) return null;
    if (modes.length === 1) {
      return ['coalesce', ['get', MODE_BY_CODE[modes[0]].distProp], FAR_DIST];
    }
    const args: ExpressionSpecification[] = modes.map((m) => [
      'coalesce',
      ['get', MODE_BY_CODE[m].distProp],
      FAR_DIST,
    ]);
    return ['min', ...args] as ExpressionSpecification;
  }

  private buildStreetColorExpr(modes: ModeCode[], _distanceM: number): ExpressionSpecification | string {
    // Gradient by walking time, independent of the slider: an 850 m gap and a
    // 4 km desert should not look the same.
    const minExpr = this.buildMinDistExpression(modes);
    if (!minExpr) return COLOR_STREET_UNCOVERED;
    const stops = WALK_RAMP.flatMap(([d, c]) => [d, c]);
    return ['case', ['>', minExpr, 3300], COLOR_STREET_UNCOVERED, ['interpolate', ['linear'], minExpr, ...stops]] as ExpressionSpecification;
  }

  private buildStreetOpacityExpr(modes: ModeCode[], distanceM: number): ExpressionSpecification | number {
    // Within the slider distance: full strength. Beyond it: dimmed, so that the
    // grey population dots (people with no station) carry the signal and
    // empty land (highways, cemeteries, campuses) reads as merely dark.
    const minExpr = this.buildMinDistExpression(modes);
    if (!minExpr) return 0.4;
    return ['case', ['<=', minExpr, distanceM], 0.95, ['>', minExpr, 3300], 0.35, 0.55];
  }

  private buildDotColorExpr(modes: ModeCode[], distanceM: number): ExpressionSpecification | string {
    const minExpr = this.buildMinDistExpression(modes);
    if (!minExpr || distanceM <= 0) return COLOR_DOT_UNCOVERED;
    return ['case', ['<=', minExpr, distanceM], COLOR_DOT_COVERED, COLOR_DOT_UNCOVERED];
  }

  private buildDotOpacityExpr(modes: ModeCode[], distanceM: number): ExpressionSpecification | number {
    const minExpr = this.buildMinDistExpression(modes);
    if (!minExpr || distanceM <= 0) return 0.6;
    return ['case', ['<=', minExpr, distanceM], 0.92, 0.6];
  }

  public async loadCity(
    city: CitySummary,
    stations: StationRecord[],
    enabledModes: Set<ModeCode>,
    distanceM: number,
    showDots: boolean,
    showStations: boolean
  ): Promise<void> {
    if (!this.ready) return;

    this.currentCity = city;
    this.stationsList = stations;
    this.stationsById.clear();
    for (const st of stations) {
      this.stationsById.set(st.id, st);
    }
    this.clearInspect();

    this.lastEnabledModes = [...enabledModes];
    this.lastDistanceM = distanceM;
    this.lastShowDots = showDots;
    this.lastShowStations = showStations;

    // Remove previous city vector layers & source cleanly
    for (const lid of ['dots-layer', 'streets-layer', 'city-boundary-line', 'city-boundary-fill']) {
      if (this.map.getLayer(lid)) {
        this.map.removeLayer(lid);
      }
    }
    if (this.map.getSource('city-tiles')) {
      this.map.removeSource('city-tiles');
    }

    // Jump camera to destination city bounds BEFORE adding city-tiles so MapLibre
    // only fetches the exact destination zoom tiles (zero wasted intermediate tiles).
    this.fitCurrentCity(0);

    const base = new URL(import.meta.env.BASE_URL, window.location.origin);
    const pmtilesUrl = new URL(`data/tiles/${city.id}.pmtiles`, base).href;

    this.map.addSource('city-tiles', {
      type: 'vector',
      url: `pmtiles://${pmtilesUrl}`,
      minzoom: 8,
      maxzoom: 13,
    });

    const beforeLayer = 'stations-layer';

    this.map.addLayer(
      {
        id: 'city-boundary-fill',
        type: 'fill',
        source: 'city-tiles',
        'source-layer': 'boundary',
        paint: {
          'fill-color': '#0f172a',
          'fill-opacity': 0.22,
        },
      },
      beforeLayer
    );

    this.map.addLayer(
      {
        id: 'streets-layer',
        type: 'line',
        source: 'city-tiles',
        'source-layer': 'streets',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': this.buildStreetColorExpr(this.lastEnabledModes, distanceM),
          'line-opacity': this.buildStreetOpacityExpr(this.lastEnabledModes, distanceM),
          'line-width': ['interpolate', ['linear'], ['zoom'], 8.5, 0.75, 11, 1.15, 13, 1.85, 15.5, 3.0],
        },
      },
      beforeLayer
    );

    this.map.addLayer(
      {
        id: 'city-boundary-line',
        type: 'line',
        source: 'city-tiles',
        'source-layer': 'boundary',
        paint: {
          'line-color': 'rgba(226, 232, 240, 0.55)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 13, 2.0],
          'line-dasharray': [4, 3],
        },
      },
      beforeLayer
    );

    this.map.addLayer(
      {
        id: 'dots-layer',
        type: 'circle',
        source: 'city-tiles',
        'source-layer': 'dots',
        layout: {
          visibility: showDots ? 'visible' : 'none',
        },
        paint: {
          'circle-color': this.buildDotColorExpr(this.lastEnabledModes, distanceM),
          'circle-opacity': this.buildDotOpacityExpr(this.lastEnabledModes, distanceM),
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.25, 10.5, 1.6, 12.5, 1.9, 14, 2.1, 16, 2.8],
        },
      },
      beforeLayer
    );

    // Update stations GeoJSON
    const stSource = this.map.getSource('stations-src') as GeoJSONSource | undefined;
    if (stSource) {
      stSource.setData({
        type: 'FeatureCollection',
        features: stations.map((s) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          properties: { id: s.id, mode: s.mode, name: s.name, inside: s.inside ? 1 : 0 },
        })),
      });
    }

    this.applyStationFilter();
    this.applyLayerVisibility();
  }

  public fitCurrentCity(duration = 550): void {
    if (!this.ready || !this.currentCity) return;
    const [west, south, east, north] = this.currentCity.bounds;
    const container = this.map.getContainer();
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const isDesktop = w >= 768;
    const padding = isDesktop
      ? { top: 48, bottom: 72, left: Math.min(396, Math.floor(w * 0.4)), right: 56 }
      : {
          top: 68,
          // Leave room for the bottom sheet (peek height, via --sheet-h) plus the legend.
          bottom: Math.min(
            Math.floor(h * 0.45),
            (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-h')) || 150) + 64
          ),
          left: 20,
          right: 20,
        };

    // City tiles start at zoom 8 (nothing renders below it), so never frame a
    // big city (Istanbul, Karachi) on a narrow phone below that: crop instead.
    const cam = this.map.cameraForBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding, maxZoom: 12.5 }
    );
    if (!cam || cam.zoom === undefined) return;
    this.map.easeTo({ center: cam.center, zoom: Math.max(MIN_TILE_ZOOM, cam.zoom), bearing: this.map.getBearing(), duration });
  }

  public updateFilter(
    enabledModes: Set<ModeCode>,
    distanceM: number,
    showDots: boolean,
    showStations: boolean
  ): void {
    const newModes = [...enabledModes];
    const modesChanged =
      newModes.length !== this.lastEnabledModes.length ||
      newModes.some((m, i) => m !== this.lastEnabledModes[i]);
    const visibilityChanged = showDots !== this.lastShowDots || showStations !== this.lastShowStations;

    this.lastEnabledModes = newModes;
    this.lastDistanceM = distanceM;
    this.lastShowDots = showDots;
    this.lastShowStations = showStations;

    if (!this.ready || !this.currentCity) return;

    if (visibilityChanged) {
      this.applyLayerVisibility();
    }
    if (modesChanged) {
      this.applyStationFilter();
    }

    // Coalesce rapid slider ticks to 1 paint update per animation frame for 60 FPS mobile dragging
    if (this.pendingRaf === null) {
      this.pendingRaf = requestAnimationFrame(() => {
        this.pendingRaf = null;
        this.applyPaintExpressions();
        if (this.lastInspectProps) {
          this.emitInspectFromProps(this.lastInspectProps.lngLat, this.lastInspectProps.props);
        }
      });
    }
  }

  private applyLayerVisibility(): void {
    if (this.map.getLayer('dots-layer')) {
      this.map.setLayoutProperty('dots-layer', 'visibility', this.lastShowDots ? 'visible' : 'none');
    }
    if (this.map.getLayer('stations-layer')) {
      this.map.setLayoutProperty('stations-layer', 'visibility', this.lastShowStations ? 'visible' : 'none');
    }
  }

  private applyStationFilter(): void {
    if (!this.map.getLayer('stations-layer')) return;
    if (this.lastEnabledModes.length === 0) {
      this.map.setFilter('stations-layer', ['==', ['get', 'mode'], '__none__']);
    } else {
      this.map.setFilter('stations-layer', [
        'in',
        ['get', 'mode'],
        ['literal', this.lastEnabledModes],
      ]);
    }
  }

  private applyPaintExpressions(): void {
    const modes = this.lastEnabledModes;
    const dist = this.lastDistanceM;
    if (this.map.getLayer('streets-layer')) {
      this.map.setPaintProperty('streets-layer', 'line-color', this.buildStreetColorExpr(modes, dist));
      this.map.setPaintProperty('streets-layer', 'line-opacity', this.buildStreetOpacityExpr(modes, dist));
    }
    if (this.map.getLayer('dots-layer')) {
      this.map.setPaintProperty('dots-layer', 'circle-color', this.buildDotColorExpr(modes, dist));
      this.map.setPaintProperty('dots-layer', 'circle-opacity', this.buildDotOpacityExpr(modes, dist));
    }
  }

  private handleMapClick(e: MapLayerMouseEvent): void {
    if (!this.ready || !this.currentCity) return;
    if (this.clickOverride) {
      this.clickOverride([e.lngLat.lng, e.lngLat.lat]);
      return;
    }

    // 1. Check if user clicked directly on a visible station marker
    if (this.lastShowStations && this.map.getLayer('stations-layer')) {
      const stHits = this.map.queryRenderedFeatures(
        [
          [e.point.x - 8, e.point.y - 8],
          [e.point.x + 8, e.point.y + 8],
        ],
        { layers: ['stations-layer'] }
      );
      if (stHits.length > 0) {
        const sid = Number(stHits[0].properties?.id);
        const st = this.stationsById.get(sid);
        if (st) {
          const fakeProps: Record<string, unknown> = {
            [MODE_BY_CODE[st.mode].distProp]: 0,
            [MODE_BY_CODE[st.mode].stationProp]: st.id,
          };
          this.lastInspectProps = { lngLat: [st.lon, st.lat], props: fakeProps };
          this.emitInspectFromProps([st.lon, st.lat], fakeProps);
          return;
        }
      }
    }

    // 2. Query nearest street segment (or population dot at low zoom) around tap point
    let matchedFeature: maplibregl.MapGeoJSONFeature | null = null;
    if (this.map.getLayer('streets-layer')) {
      for (const radius of [10, 22]) {
        const feats = this.map.queryRenderedFeatures(
          [
            [e.point.x - radius, e.point.y - radius],
            [e.point.x + radius, e.point.y + radius],
          ],
          { layers: ['streets-layer'] }
        );
        if (feats.length > 0) {
          matchedFeature = feats[0];
          break;
        }
      }
    }

    // Fallback at low zoom (where residential streets are omitted): check dots layer
    if (!matchedFeature && this.lastShowDots && this.map.getLayer('dots-layer')) {
      const dotFeats = this.map.queryRenderedFeatures(
        [
          [e.point.x - 14, e.point.y - 14],
          [e.point.x + 14, e.point.y + 14],
        ],
        { layers: ['dots-layer'] }
      );
      if (dotFeats.length > 0) {
        matchedFeature = dotFeats[0];
      }
    }

    // Wider street query if still nothing
    if (!matchedFeature && this.map.getLayer('streets-layer')) {
      const wideFeats = this.map.queryRenderedFeatures(
        [
          [e.point.x - 44, e.point.y - 44],
          [e.point.x + 44, e.point.y + 44],
        ],
        { layers: ['streets-layer'] }
      );
      if (wideFeats.length > 0) {
        matchedFeature = wideFeats[0];
      }
    }

    // Check if click was inside city boundary polygon even when no street/dot hit
    if (!matchedFeature && this.map.getLayer('city-boundary-fill')) {
      const bFeats = this.map.queryRenderedFeatures(e.point, { layers: ['city-boundary-fill'] });
      if (bFeats.length > 0) {
        const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        this.lastInspectProps = { lngLat, props: {} };
        this.emitInspectFromProps(lngLat, {});
        return;
      }
    }

    if (!matchedFeature || !matchedFeature.properties) {
      this.clearInspect();
      return;
    }

    const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    const props = { ...matchedFeature.properties };
    this.lastInspectProps = { lngLat, props };
    this.emitInspectFromProps(lngLat, props);
  }

  private findNearestStationByMode(lngLat: [number, number], mode: ModeCode): { station: StationRecord; straightM: number } | null {
    let best: StationRecord | null = null;
    let bestD = Infinity;
    for (const st of this.stationsList) {
      if (st.mode !== mode) continue;
      const d = haversineMeters(lngLat[0], lngLat[1], st.lon, st.lat);
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    return best ? { station: best, straightM: bestD } : null;
  }

  private emitInspectFromProps(lngLat: [number, number], props: Record<string, unknown>): void {
    const enabled = this.lastEnabledModes;
    if (enabled.length === 0) {
      this.setInspectGraphics(lngLat, null);
      this.onInspectCallback?.({
        lngLat,
        best: null,
        byMode: [],
        withinReach: false,
        noModesEnabled: true,
      });
      return;
    }

    const byMode: InspectModeHit[] = [];
    for (const mode of enabled) {
      const meta = MODE_BY_CODE[mode];
      const rawDist = props[meta.distProp];
      const rawSid = props[meta.stationProp];
      if (rawDist !== undefined && rawDist !== null) {
        const distM = Number(rawDist);
        let st = rawSid !== undefined && rawSid !== null ? this.stationsById.get(Number(rawSid)) : undefined;
        if (!st) {
          st = this.findNearestStationByMode(lngLat, mode)?.station;
        }
        if (Number.isFinite(distM) && st) {
          byMode.push({ mode, distanceM: distM, station: st, approx: false });
        }
      }
    }

    // If beyond precomputed 2-mile walking range (>3.3 km), fall back to nearest station by straight-line
    if (byMode.length === 0) {
      for (const mode of enabled) {
        const hit = this.findNearestStationByMode(lngLat, mode);
        if (hit) {
          byMode.push({
            mode,
            distanceM: Math.max(3300, Math.round(hit.straightM)),
            station: hit.station,
            approx: true,
          });
        }
      }
    }

    byMode.sort((a, b) => a.distanceM - b.distanceM);
    const best = byMode.length > 0 ? byMode[0] : null;
    const withinReach = best !== null && !best.approx && best.distanceM <= this.lastDistanceM;

    this.setInspectGraphics(lngLat, best?.station ?? null);
    this.onInspectCallback?.({
      lngLat,
      best,
      byMode,
      withinReach,
      noModesEnabled: false,
    });
  }

  private setInspectGraphics(tapLngLat: [number, number], station: StationRecord | null): void {
    const src = this.map.getSource('inspect-src') as GeoJSONSource | undefined;
    if (!src) return;

    const features: GeoJSON.Feature[] = [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: tapLngLat },
        properties: { kind: 'tap' },
      },
    ];

    if (station) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
        properties: { kind: 'station' },
      });
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [tapLngLat, [station.lon, station.lat]],
        },
        properties: { kind: 'connector' },
      });
    }

    src.setData({ type: 'FeatureCollection', features });
  }

  /** Dashed outline of the urban centre in the "Urban area" view (null hides it). */
  public setUrbanOutline(geom: GeoJSON.Geometry | null): void {
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: geom ? [{ type: 'Feature', properties: {}, geometry: geom }] : [],
    };
    const src = this.map.getSource('urban-outline') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
      return;
    }
    if (!geom) return;
    this.map.addSource('urban-outline', { type: 'geojson', data });
    this.map.addLayer(
      {
        id: 'urban-outline-line',
        type: 'line',
        source: 'urban-outline',
        paint: { 'line-color': '#fbbf24', 'line-width': 1.6, 'line-opacity': 0.85, 'line-dasharray': [3, 2] },
      },
      this.map.getLayer('stations-layer') ? 'stations-layer' : undefined
    );
  }

  public clearInspect(): void {
    this.lastInspectProps = null;
    const src = this.map.getSource('inspect-src') as GeoJSONSource | undefined;
    if (src) {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
    this.onInspectCallback?.(null);
  }

  /**
   * Population dots in the currently loaded tiles (deduplicated across tile buffers),
   * with the people each dot stands for at the current tile zoom.
   */
  public queryDots(): { dots: DotSample[]; peoplePerDot: number } {
    const out: DotSample[] = [];
    if (!this.ready || !this.map.getSource('city-tiles')) return { dots: out, peoplePerDot: 0 };
    const seen = new Set<string>();
    const feats = this.map.querySourceFeatures('city-tiles', { sourceLayer: 'dots' });
    for (const f of feats) {
      if (f.geometry.type !== 'Point') continue;
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ lon, lat, props: (f.properties ?? {}) as Record<string, number> });
    }
    const tz = Math.max(8, Math.min(13, Math.floor(this.map.getZoom())));
    const peoplePerDot = tz < 11 ? 500 : tz === 11 ? 250 : tz === 12 ? 125 : 25;
    return { dots: out, peoplePerDot };
  }

  /** Walking distance (m) from a dot to the nearest station of the given modes, from the precomputed tile data (Infinity if beyond ~3.3 km). */
  public static dotDistance(props: Record<string, number>, modes: ModeCode[]): number {
    let best = Infinity;
    for (const m of modes) {
      const v = props[MODE_BY_CODE[m].distProp];
      if (typeof v === 'number' && v < best) best = v;
    }
    return best;
  }

  public getStations(): StationRecord[] {
    return this.stationsList;
  }

  public getStationsCount(): number {
    return this.stationsList.length;
  }
}
