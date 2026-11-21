/**
 * Sketch-a-line scenario mode.
 *
 * Tap the map to draw a route; stations are placed along it every N metres.
 * The tool then estimates how many more people would be within the current
 * walking distance of a station.
 *
 * Estimate, clearly labelled as one: the browser has no street graph, so walking
 * distance to a sketched station is straight-line distance × 1.3 (a typical
 * detour factor). Existing coverage uses the real network distances baked into
 * the population dots. Only dots in the tiles currently loaded on the map are
 * counted, so the line should be in view.
 */
import type { GeoJSONSource } from 'maplibre-gl';
import { TransitMap, haversineMeters } from './map';
import { formatCompactPop, formatShortDistance } from './stats';
import { DistanceUnit, ModeCode } from './types';

export const DETOUR_FACTOR = 1.3;

export interface ScenarioContext {
  modes: ModeCode[];
  distanceM: number;
  unit: DistanceUnit;
  cityPop: number;
  cityName: string;
}

export class Scenario {
  private readonly tm: TransitMap;
  private readonly card: HTMLElement;
  private readonly body: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private active = false;
  private vertices: [number, number][] = [];
  private spacing = 800;
  private ctx: ScenarioContext | null = null;
  private recalcTimer: number | null = null;
  private onActiveChange: (active: boolean) => void;

  constructor(tm: TransitMap, onActiveChange: (active: boolean) => void) {
    this.tm = tm;
    this.onActiveChange = onActiveChange;
    this.card = document.getElementById('scenario-card')!;
    this.body = document.getElementById('scenario-body')!;
    this.toggleBtn = document.getElementById('scenario-btn') as HTMLButtonElement;

    this.toggleBtn.addEventListener('click', () => (this.active ? this.stop() : this.start()));
    document.getElementById('scenario-undo')!.addEventListener('click', () => {
      this.vertices.pop();
      this.redraw();
    });
    document.getElementById('scenario-clear')!.addEventListener('click', () => {
      this.vertices = [];
      this.redraw();
    });
    document.getElementById('scenario-done')!.addEventListener('click', () => this.stop());
    this.card.querySelectorAll<HTMLButtonElement>('[data-spacing]').forEach((b) =>
      b.addEventListener('click', () => {
        this.spacing = Number(b.dataset.spacing);
        this.redraw();
      })
    );
    // New tiles (after pan/zoom) change which dots are counted.
    tm.map.on('idle', () => {
      if (this.active && this.vertices.length) this.scheduleRecalc();
    });
  }

  public isActive(): boolean {
    return this.active;
  }

  /** Start sketching, optionally with a first point (e.g. from a "biggest gap"). */
  public start(first?: [number, number]): void {
    this.ensureLayers();
    this.active = true;
    this.vertices = first ? [first] : [];
    this.tm.clickOverride = (ll) => {
      this.vertices.push(ll);
      this.redraw();
    };
    this.tm.clearInspect();
    this.card.classList.remove('hidden');
    this.toggleBtn.classList.add('active');
    this.tm.map.getCanvas().style.cursor = 'crosshair';
    this.onActiveChange(true);
    this.redraw();
  }

  public stop(): void {
    this.active = false;
    this.vertices = [];
    this.tm.clickOverride = null;
    this.card.classList.add('hidden');
    this.toggleBtn.classList.remove('active');
    this.tm.map.getCanvas().style.cursor = '';
    this.setData([], []);
    this.onActiveChange(false);
  }

  public update(ctx: ScenarioContext): void {
    this.ctx = ctx;
    if (this.active) this.scheduleRecalc();
  }

  private ensureLayers(): void {
    const map = this.tm.map;
    if (map.getSource('scenario-src')) return;
    map.addSource('scenario-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'scenario-line',
      type: 'line',
      source: 'scenario-src',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#f472b6', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 13, 4], 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'scenario-stations',
      type: 'circle',
      source: 'scenario-src',
      filter: ['==', ['get', 'kind'], 'station'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 12, 4.5, 15, 7],
        'circle-color': '#0b0f17',
        'circle-stroke-color': '#f472b6',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 12, 2.5, 15, 3],
      },
    });
    map.addLayer({
      id: 'scenario-vertices',
      type: 'circle',
      source: 'scenario-src',
      filter: ['==', ['get', 'kind'], 'vertex'],
      paint: { 'circle-radius': 3, 'circle-color': '#f9a8d4' },
    });
  }

  private setData(stations: [number, number][], line: [number, number][]): void {
    const src = this.tm.map.getSource('scenario-src') as GeoJSONSource | undefined;
    if (!src) return;
    const features: GeoJSON.Feature[] = [];
    if (line.length >= 2) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
    }
    for (const v of line) features.push({ type: 'Feature', properties: { kind: 'vertex' }, geometry: { type: 'Point', coordinates: v } });
    for (const s of stations) features.push({ type: 'Feature', properties: { kind: 'station' }, geometry: { type: 'Point', coordinates: s } });
    src.setData({ type: 'FeatureCollection', features });
  }

  /** Stations every `spacing` metres along the polyline, including both ends. */
  private stationsAlong(): [number, number][] {
    const v = this.vertices;
    if (v.length === 0) return [];
    if (v.length === 1) return [v[0]];
    const out: [number, number][] = [v[0]];
    let carry = 0;
    for (let i = 1; i < v.length; i++) {
      const [lon1, lat1] = v[i - 1];
      const [lon2, lat2] = v[i];
      const segLen = haversineMeters(lon1, lat1, lon2, lat2);
      let d = this.spacing - carry;
      while (d <= segLen) {
        const t = d / segLen;
        out.push([lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t]);
        d += this.spacing;
      }
      carry = segLen - (d - this.spacing);
    }
    const last = v[v.length - 1];
    const prev = out[out.length - 1];
    if (haversineMeters(prev[0], prev[1], last[0], last[1]) > this.spacing * 0.35) out.push(last);
    return out;
  }

  private redraw(): void {
    const stations = this.stationsAlong();
    this.setData(stations, this.vertices);
    this.card.querySelectorAll<HTMLButtonElement>('[data-spacing]').forEach((b) =>
      b.classList.toggle('active', Number(b.dataset.spacing) === this.spacing)
    );
    this.scheduleRecalc();
  }

  private scheduleRecalc(): void {
    if (this.recalcTimer !== null) window.clearTimeout(this.recalcTimer);
    this.recalcTimer = window.setTimeout(() => {
      this.recalcTimer = null;
      this.recalc();
    }, 120);
  }

  private recalc(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const stations = this.stationsAlong();
    const spacingLbl = (m: number) => formatShortDistance(m, ctx.unit);
    this.card.querySelectorAll<HTMLButtonElement>('[data-spacing]').forEach((b) => {
      b.textContent = spacingLbl(Number(b.dataset.spacing));
    });
    if (stations.length === 0) {
      this.body.innerHTML = `<p class="scenario-hint">Tap the map to draw a route. Stations are placed along it every ${spacingLbl(this.spacing)}.</p>`;
      return;
    }

    const { dots, peoplePerDot } = this.tm.queryDots();
    const reachStraight = ctx.distanceM / DETOUR_FACTOR;
    // Prefilter with a lat/lon box around the stations.
    const latPad = reachStraight / 111_000;
    const lats = stations.map((s) => s[1]);
    const lons = stations.map((s) => s[0]);
    const lonPad = latPad / Math.cos(((Math.min(...lats) + Math.max(...lats)) / 2) * (Math.PI / 180));
    const minLat = Math.min(...lats) - latPad;
    const maxLat = Math.max(...lats) + latPad;
    const minLon = Math.min(...lons) - lonPad;
    const maxLon = Math.max(...lons) + lonPad;

    let newlyCovered = 0;
    let alreadyCovered = 0;
    for (const d of dots) {
      if (d.lat < minLat || d.lat > maxLat || d.lon < minLon || d.lon > maxLon) continue;
      let near = false;
      for (const s of stations) {
        if (haversineMeters(d.lon, d.lat, s[0], s[1]) <= reachStraight) {
          near = true;
          break;
        }
      }
      if (!near) continue;
      if (TransitMap.dotDistance(d.props, ctx.modes) <= ctx.distanceM) alreadyCovered++;
      else newlyCovered++;
    }
    const gain = newlyCovered * peoplePerDot;
    const served = (newlyCovered + alreadyCovered) * peoplePerDot;
    const gainPct = ctx.cityPop > 0 ? (gain / ctx.cityPop) * 100 : 0;
    const perStation = gain / stations.length;
    const overlap = served > 0 ? (alreadyCovered * peoplePerDot) / served : 0;
    const coarse = peoplePerDot >= 250 ? ' Zoom in for a finer count.' : '';

    this.body.innerHTML = `
      <div class="scenario-gain"><b>+${formatCompactPop(gain)}</b> people newly within ${formatShortDistance(ctx.distanceM, ctx.unit)}
        <span class="scenario-pct">(+${gainPct.toFixed(1)} pts for ${ctx.cityName})</span></div>
      <div class="scenario-stats">
        <span>${stations.length} station${stations.length === 1 ? '' : 's'}</span>
        <span>${formatCompactPop(perStation)} new people / station</span>
        <span>${Math.round(overlap * 100)}% of its catchment already served</span>
      </div>
      <p class="scenario-note">Estimate: walking = straight line × ${DETOUR_FACTOR}; counts population dots loaded on screen (1 dot = ${peoplePerDot} people).${coarse}</p>`;
  }
}

