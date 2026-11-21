/**
 * Sketch-a-line scenario mode.
 *
 * Tap the map to draw a route; stations are placed along it every N metres.
 * The tool then estimates how many more people would be within the current
 * walking distance of a station.
 *
 * The browser has no street graph, so walking distance to a sketched station is
 * straight-line distance × a detour factor measured from this city's own street
 * network: population dots near the line carry real network distances to the
 * existing stations, and comparing them with straight-line distances to those
 * stations gives the local detour (rivers, rail cuts and superblocks push it up,
 * dense grids pull it down). Falls back to 1.3 where there are too few nearby
 * samples. Only dots in the tiles currently loaded on the map are counted.
 *
 * A sketch is kept in the URL (sk=<spacing>_<base36 delta-encoded vertices>) so
 * it can be shared.
 */
import type { GeoJSONSource } from 'maplibre-gl';
import { TransitMap, haversineMeters } from './map';
import { formatCompactPop, formatShortDistance } from './stats';
import { DistanceUnit, MODES, ModeCode } from './types';

export const DETOUR_FACTOR = 1.3;
const COORD_SCALE = 1e4; // ~10 m precision in shared links

/** Encode a sketch for the URL hash. */
export function encodeSketch(vertices: [number, number][], spacing: number): string {
  let px = 0;
  let py = 0;
  const nums: number[] = [];
  for (const [lon, lat] of vertices) {
    const x = Math.round(lon * COORD_SCALE);
    const y = Math.round(lat * COORD_SCALE);
    nums.push(x - px, y - py);
    px = x;
    py = y;
  }
  return `${spacing}_${nums.map((n) => n.toString(36)).join('.')}`;
}

export function decodeSketch(raw: string): { vertices: [number, number][]; spacing: number } | null {
  const m = /^(400|800|1600)_([-0-9a-z.]+)$/.exec(raw);
  if (!m) return null;
  const nums = m[2].split('.').map((t) => parseInt(t, 36));
  if (nums.length < 2 || nums.length % 2 || nums.some((n) => !Number.isFinite(n))) return null;
  const vertices: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < nums.length && vertices.length < 60; i += 2) {
    x += nums[i];
    y += nums[i + 1];
    vertices.push([x / COORD_SCALE, y / COORD_SCALE]);
  }
  return { vertices, spacing: Number(m[1]) };
}

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
  private onSketchChange: () => void;

  constructor(tm: TransitMap, onActiveChange: (active: boolean) => void, onSketchChange: () => void = () => {}) {
    this.tm = tm;
    this.onActiveChange = onActiveChange;
    this.onSketchChange = onSketchChange;
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
    document.getElementById('scenario-share')?.addEventListener('click', () => void this.share());
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

  /** URL hash value for the current sketch, or null when there is nothing to share. */
  public shareParam(): string | null {
    return this.active && this.vertices.length >= 2 ? encodeSketch(this.vertices, this.spacing) : null;
  }

  /** Restore a shared sketch and frame it. */
  public load(vertices: [number, number][], spacing: number): void {
    this.spacing = spacing;
    this.start();
    this.vertices = vertices.slice();
    const lons = vertices.map((v) => v[0]);
    const lats = vertices.map((v) => v[1]);
    this.tm.map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: { top: 260, bottom: 140, left: 40, right: 40 }, maxZoom: 13.5, duration: 0, bearing: this.tm.map.getBearing() }
    );
    this.redraw();
  }

  private async share(): Promise<void> {
    this.onSketchChange();
    const url = window.location.href;
    const btn = document.getElementById('scenario-share');
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: 'Transit Reach: my line', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      if (btn) {
        btn.textContent = 'Link copied';
        window.setTimeout(() => (btn.textContent = 'Share'), 1600);
      }
    } catch {
      /* user cancelled share sheet or clipboard blocked */
    }
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
    this.onSketchChange();
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
    document.getElementById('scenario-share')?.classList.toggle('hidden', this.vertices.length < 2);
    this.onSketchChange();
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
    const detour = this.localDetour(dots, stations);
    const reachStraight = ctx.distanceM / detour.factor;
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
      <p class="scenario-note">Estimate: walking = straight line × ${detour.factor.toFixed(2)} ${
        detour.samples ? `(detour measured from ${detour.samples} real street walks ${detour.scope})` : '(typical detour; too few nearby stations to measure it here)'
      }; counts population dots loaded on screen (1 dot = ${peoplePerDot} people).${coarse}</p>`;
  }

  /**
   * Street-network detour factor around the sketch: for population dots within
   * ~3 km of the sketched stations, compare each dot's real walking distance to
   * its nearest existing station (baked into the tiles) with the straight-line
   * distance to the nearest station of that mode. Median, clamped to [1.05, 2].
   * Slightly conservative: the straight-line nearest station can differ from
   * the network-nearest one, which only ever raises the ratio.
   */
  private localDetour(
    dots: { lon: number; lat: number; props: Record<string, unknown> }[],
    sketch: [number, number][]
  ): { factor: number; samples: number; scope: string } {
    const all = this.tm.getStations();
    if (!all.length || !dots.length) return { factor: DETOUR_FACTOR, samples: 0, scope: '' };
    const near = (lon: number, lat: number) => sketch.some((s) => haversineMeters(lon, lat, s[0], s[1]) < 3000);
    const local = this.detourFrom(dots.filter((d) => near(d.lon, d.lat)), all);
    if (local.samples >= 25) return { ...local, scope: 'nearby' };
    const wide = this.detourFrom(dots, all);
    if (wide.samples >= 25) return { ...wide, scope: 'in view' };
    return { factor: DETOUR_FACTOR, samples: 0, scope: '' };
  }

  private detourFrom(
    cand: { lon: number; lat: number; props: Record<string, unknown> }[],
    all: ReturnType<TransitMap['getStations']>
  ): { factor: number; samples: number } {
    // Evenly thin to at most ~600 dots to keep this cheap.
    const step = Math.max(1, Math.floor(cand.length / 600));
    const ratios: number[] = [];
    for (let i = 0; i < cand.length; i += step) {
      const d = cand[i];
      let best = Infinity;
      let bestStraight = Infinity;
      for (const m of MODES) {
        const net = Number(d.props[m.distProp]);
        if (!Number.isFinite(net) || net <= 0 || net > 2500) continue;
        let straight = Infinity;
        for (const st of all) {
          if (st.mode !== m.code) continue;
          const h = haversineMeters(d.lon, d.lat, st.lon, st.lat);
          if (h < straight) straight = h;
        }
        if (net < best) {
          best = net;
          bestStraight = straight;
        }
      }
      if (best < Infinity && bestStraight >= 150 && bestStraight < 2500) ratios.push(best / bestStraight);
    }
    if (ratios.length < 25) return { factor: DETOUR_FACTOR, samples: ratios.length };
    ratios.sort((a, b) => a - b);
    const med = ratios[Math.floor(ratios.length / 2)];
    return { factor: Math.min(2, Math.max(1.05, med)), samples: ratios.length };
  }
}
