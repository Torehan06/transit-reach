/**
 * "Measure a circle": place a circle anywhere, set its radius, and see how
 * many people live inside it, which stations (by mode) fall inside it, and
 * what share of those people are within the current walking distance of a
 * station of the selected modes.
 *
 * Counts come from the population dots currently loaded on the map (city
 * limits only) and use the real street-network distances baked into them.
 * State lives in the URL as c=<lon>,<lat>,<radius m>.
 */
import type { GeoJSONSource } from 'maplibre-gl';
import { TransitMap, haversineMeters } from './map';
import { formatCompactPop, formatShortDistance } from './stats';
import { DistanceUnit, MODES, ModeCode } from './types';

export interface CircleContext {
  modes: ModeCode[];
  distanceM: number;
  unit: DistanceUnit;
}

const MIN_R = 200;
const MAX_R = 5000;

function circlePolygon(lon: number, lat: number, r: number, n = 72): [number, number][] {
  const out: [number, number][] = [];
  const dLat = r / 111_320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    out.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return out;
}

export class CircleTool {
  private readonly tm: TransitMap;
  private readonly card: HTMLElement;
  private readonly body: HTMLElement;
  private readonly btn: HTMLButtonElement;
  private readonly slider: HTMLInputElement;
  private readonly rLabel: HTMLElement;
  private active = false;
  private center: [number, number] | null = null;
  private radius = 1000;
  private ctx: CircleContext | null = null;
  private timer: number | null = null;
  private onActiveChange: (active: boolean) => void;
  private onChange: () => void;
  private clickHandler: ((ll: [number, number]) => void) | null = null;

  constructor(tm: TransitMap, onActiveChange: (active: boolean) => void, onChange: () => void) {
    this.tm = tm;
    this.onActiveChange = onActiveChange;
    this.onChange = onChange;
    this.card = document.getElementById('circle-card')!;
    this.body = document.getElementById('circle-body')!;
    this.btn = document.getElementById('circle-btn') as HTMLButtonElement;
    this.slider = document.getElementById('circle-radius') as HTMLInputElement;
    this.rLabel = document.getElementById('circle-radius-label')!;
    this.slider.min = String(MIN_R);
    this.slider.max = String(MAX_R);
    this.slider.step = '50';

    this.btn.addEventListener('click', () => (this.active ? this.stop() : this.start()));
    document.getElementById('circle-done')!.addEventListener('click', () => this.stop());
    this.slider.addEventListener('input', () => {
      this.radius = Number(this.slider.value);
      this.redraw();
    });
    tm.map.on('idle', () => {
      if (this.active && this.center) this.schedule();
    });
  }

  public isActive(): boolean {
    return this.active;
  }

  public shareParam(): string | null {
    if (!this.active || !this.center) return null;
    return `${this.center[0].toFixed(4)},${this.center[1].toFixed(4)},${Math.round(this.radius)}`;
  }

  public static parse(raw: string): { center: [number, number]; radius: number } | null {
    const p = raw.split(',').map(Number);
    if (p.length !== 3 || p.some((v) => !Number.isFinite(v))) return null;
    return { center: [p[0], p[1]], radius: Math.min(MAX_R, Math.max(MIN_R, p[2])) };
  }

  /** Start measuring; with no centre the circle goes to the middle of the screen. */
  public start(center?: [number, number], radius?: number): void {
    this.ensureLayers();
    this.active = true;
    if (radius) this.radius = radius;
    this.center = center ?? this.defaultCenter();
    if (!this.tm.map.getBounds().contains(this.center)) this.tm.map.easeTo({ center: this.center, duration: 400 });
    this.clickHandler = (ll) => {
      this.center = ll;
      this.redraw();
    };
    this.tm.clickOverride = this.clickHandler;
    this.tm.clearInspect();
    this.slider.value = String(this.radius);
    this.card.classList.remove('hidden');
    this.btn.classList.add('active');
    this.onActiveChange(true);
    this.redraw();
  }

  /** The middle of the city's stations (median), else the middle of the screen. */
  private defaultCenter(): [number, number] {
    const st = this.tm.getStations().filter((x) => x.inside);
    if (st.length) {
      const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
      const c: [number, number] = [med(st.map((x) => x.lon)), med(st.map((x) => x.lat))];
      const b = this.tm.map.getBounds();
      // Prefer the screen centre when the user has zoomed into some other part of the city.
      if (this.tm.map.getZoom() < 12 || !b.contains(c)) return c;
    }
    const m = this.tm.map.getCenter();
    return [m.lng, m.lat];
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;
    this.center = null;
    if (this.tm.clickOverride === this.clickHandler) this.tm.clickOverride = null;
    this.card.classList.add('hidden');
    this.btn.classList.remove('active');
    this.setData();
    this.onActiveChange(false);
    this.onChange();
  }

  public update(ctx: CircleContext): void {
    this.ctx = ctx;
    if (this.active) this.schedule();
  }

  private ensureLayers(): void {
    const map = this.tm.map;
    if (map.getSource('circle-src')) return;
    map.addSource('circle-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'circle-fill',
      type: 'fill',
      source: 'circle-src',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.08 },
    });
    map.addLayer({
      id: 'circle-line',
      type: 'line',
      source: 'circle-src',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'circle-center',
      type: 'circle',
      source: 'circle-src',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4, 'circle-color': '#38bdf8', 'circle-stroke-color': '#0b0f17', 'circle-stroke-width': 1.5 },
    });
  }

  private setData(): void {
    const src = this.tm.map.getSource('circle-src') as GeoJSONSource | undefined;
    if (!src) return;
    const features: GeoJSON.Feature[] = [];
    if (this.center) {
      const [lon, lat] = this.center;
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circlePolygon(lon, lat, this.radius)] } });
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: this.center } });
    }
    src.setData({ type: 'FeatureCollection', features });
  }

  private redraw(): void {
    this.setData();
    if (this.ctx) this.rLabel.textContent = formatShortDistance(this.radius, this.ctx.unit);
    this.onChange();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.recalc();
    }, 100);
  }

  private recalc(): void {
    const ctx = this.ctx;
    if (!ctx || !this.center) return;
    const [lon, lat] = this.center;
    const r = this.radius;
    this.rLabel.textContent = formatShortDistance(r, ctx.unit);

    const { dots, peoplePerDot } = this.tm.queryDots();
    let inside = 0;
    let covered = 0;
    const dLat = r / 111_000;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    for (const d of dots) {
      if (Math.abs(d.lat - lat) > dLat || Math.abs(d.lon - lon) > dLon) continue;
      if (haversineMeters(d.lon, d.lat, lon, lat) > r) continue;
      inside++;
      if (TransitMap.dotDistance(d.props, ctx.modes) <= ctx.distanceM) covered++;
    }

    const counts = new Map<ModeCode, number>();
    let nearest = Infinity;
    for (const st of this.tm.getStations()) {
      const h = haversineMeters(st.lon, st.lat, lon, lat);
      if (h <= r) counts.set(st.mode, (counts.get(st.mode) ?? 0) + 1);
      else if (ctx.modes.includes(st.mode)) nearest = Math.min(nearest, h - r);
    }
    const modeChips = MODES.filter((m) => counts.get(m.code))
      .map(
        (m) =>
          `<span class="circle-mode${ctx.modes.includes(m.code) ? '' : ' off'}"><i style="background:${m.color}"></i>${m.shortLabel} ${counts.get(m.code)}</span>`
      )
      .join('');

    // Is the whole circle on screen? Otherwise some of its dots are not loaded.
    const b = this.tm.map.getBounds();
    const fullyVisible = b.contains([lon - dLon, lat - dLat]) && b.contains([lon + dLon, lat + dLat]);
    const pop = inside * peoplePerDot;
    const pct = inside > 0 ? (covered / inside) * 100 : 0;

    this.body.innerHTML = `
      <div class="circle-kpis">
        <div><b>${inside ? formatCompactPop(pop) : '0'}</b><span>people inside</span></div>
        <div><b>${inside ? `${pct.toFixed(0)}%` : '—'}</b><span>within ${formatShortDistance(ctx.distanceM, ctx.unit)} walk</span></div>
      </div>
      <div class="circle-modes">${
        modeChips ||
        `<span class="circle-none">No stations inside${Number.isFinite(nearest) ? `; nearest is ${formatShortDistance(nearest, ctx.unit)} beyond the edge` : ''}</span>`
      }</div>
      <p class="scenario-note">Tap the map to move the circle. Counts population dots inside the city limits${
        peoplePerDot ? ` (1 dot = ${peoplePerDot} people)` : ''
      } and real street walking distances.${fullyVisible ? '' : ' <b>Part of the circle is off screen; zoom out for a full count.</b>'}</p>`;
  }
}
