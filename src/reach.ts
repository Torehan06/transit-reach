/**
 * Reach curve: share of a city's population within walking distance d of a station,
 * for d from 0 to 3.2 km, drawn from the coverage curves already in summary.json.
 *
 * Two views:
 *  - "Cities": the current city (current modes) plus up to three overlay cities.
 *  - "By mode": one curve per mode for the current city, with people reached per station.
 *
 * Also computes the "close-in share": coverage at ½ mile ÷ coverage at 1 mile.
 * A city whose stations sit among its homes gets most of its 1-mile reach inside
 * ½ mile; one whose stations sit in highway medians or rail corridors does not.
 */
import { computeCityCoverage, modesToMask } from './stats';
import { CitySummary, DistanceUnit, MODES, ModeCode, SummaryManifest } from './types';

const W = 320;
const H = 168;
const PAD = { l: 34, r: 10, t: 10, b: 24 };
const MAX_M = 3200;
const HALF_MI = 805;
const ONE_MI = 1609;
const OVERLAY_COLORS = ['#fbbf24', '#f472b6', '#a78bfa'];
const SVG_NS = 'http://www.w3.org/2000/svg';

export type ReachView = 'cities' | 'modes';

export interface ReachState {
  cityId: string;
  enabledModes: Set<ModeCode>;
  distanceM: number;
  unit: DistanceUnit;
}

/** Population share (0-100) within distanceM for a mode mask, or null if the city has no such curve. */
export function coverageAt(
  city: CitySummary,
  modes: Set<ModeCode>,
  distanceM: number,
  step: number
): number | null {
  const mask = modesToMask(modes) & city.available_modes_mask;
  if (!mask || !city.pop_curves[String(mask)]) return null;
  return computeCityCoverage(city, modes, distanceM, step).popPct;
}

/** Close-in share (0-100): coverage at ½ mile ÷ coverage at 1 mile. Null when 1-mile coverage is too small to mean much. */
export function closeInShare(
  city: CitySummary,
  modes: Set<ModeCode>,
  step: number
): number | null {
  const near = coverageAt(city, modes, HALF_MI, step);
  const far = coverageAt(city, modes, ONE_MI, step);
  if (near === null || far === null || far < 10) return null;
  return Math.min(100, (near / far) * 100);
}

const x = (m: number) => PAD.l + (Math.min(m, MAX_M) / MAX_M) * (W - PAD.l - PAD.r);
const y = (pct: number) => H - PAD.b - (Math.max(0, Math.min(100, pct)) / 100) * (H - PAD.t - PAD.b);

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function curvePath(city: CitySummary, modes: Set<ModeCode>, step: number): string | null {
  if (coverageAt(city, modes, 0, step) === null) return null;
  const pts: string[] = [];
  for (let d = 0; d <= MAX_M; d += 100) {
    const v = coverageAt(city, modes, d, step) ?? 0;
    pts.push(`${pts.length ? 'L' : 'M'}${x(d).toFixed(1)},${y(v).toFixed(1)}`);
  }
  return pts.join('');
}

export class ReachChart {
  private readonly root: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly legend: HTMLElement;
  private readonly insight: HTMLElement;
  private readonly overlaySelect: HTMLSelectElement;
  private readonly overlayRow: HTMLElement;
  private manifest: SummaryManifest | null = null;
  private state: ReachState | null = null;
  private view: ReachView = 'cities';
  public overlays: string[] = [];
  private onDistancePick: (m: number) => void;
  private onOverlaysChanged: () => void;

  constructor(opts: { onDistancePick: (m: number) => void; onOverlaysChanged: () => void }) {
    this.onDistancePick = opts.onDistancePick;
    this.onOverlaysChanged = opts.onOverlaysChanged;
    this.root = document.getElementById('reach-section')!;
    this.legend = document.getElementById('reach-legend')!;
    this.insight = document.getElementById('reach-insight')!;
    this.overlaySelect = document.getElementById('reach-add-city') as HTMLSelectElement;
    this.overlayRow = document.getElementById('reach-overlay-row')!;

    this.svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'reach-svg', role: 'img' });
    document.getElementById('reach-chart')!.appendChild(this.svg);

    this.root.querySelectorAll<HTMLButtonElement>('[data-reach-view]').forEach((b) =>
      b.addEventListener('click', () => {
        this.view = b.dataset.reachView as ReachView;
        this.render();
      })
    );

    this.overlaySelect.addEventListener('change', () => {
      const id = this.overlaySelect.value;
      this.overlaySelect.value = '';
      if (!id || this.overlays.includes(id) || id === this.state?.cityId) return;
      this.overlays = [...this.overlays, id].slice(-3);
      this.onOverlaysChanged();
      this.render();
    });

    // Tap / drag on the chart sets the walking distance.
    const pick = (ev: PointerEvent) => {
      const r = this.svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const m = ((px - PAD.l) / (W - PAD.l - PAD.r)) * MAX_M;
      this.onDistancePick(Math.round(Math.max(0, Math.min(3219, m))));
    };
    this.svg.addEventListener('pointerdown', (ev) => {
      this.svg.setPointerCapture(ev.pointerId);
      pick(ev);
    });
    this.svg.addEventListener('pointermove', (ev) => {
      if (this.svg.hasPointerCapture(ev.pointerId)) pick(ev);
    });
  }

  public init(manifest: SummaryManifest, fillSelect: (sel: HTMLSelectElement) => void): void {
    this.manifest = manifest;
    fillSelect(this.overlaySelect);
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '+ Compare a city…';
    this.overlaySelect.prepend(ph);
    this.overlaySelect.value = '';
  }

  public update(state: ReachState): void {
    this.state = state;
    this.render();
  }

  private render(): void {
    const m = this.manifest;
    const s = this.state;
    if (!m || !s) return;
    const city = m.cities[s.cityId];
    if (!city) return;
    const step = m.bucket_step_m;
    const svg = this.svg;
    svg.replaceChildren();

    this.root.querySelectorAll<HTMLButtonElement>('[data-reach-view]').forEach((b) =>
      b.classList.toggle('active', b.dataset.reachView === this.view)
    );
    this.overlayRow.classList.toggle('hidden', this.view !== 'cities');

    // Grid and axes
    for (const pct of [0, 25, 50, 75, 100]) {
      svg.appendChild(el('line', { x1: PAD.l, x2: W - PAD.r, y1: y(pct), y2: y(pct), class: 'reach-grid' }));
      const t = el('text', { x: PAD.l - 5, y: y(pct) + 3, class: 'reach-axis', 'text-anchor': 'end' });
      t.textContent = `${pct}%`;
      svg.appendChild(t);
    }
    const ticks = s.unit === 'mi' ? [0, 805, 1609, 2414, 3219] : [0, 800, 1600, 2400, 3200];
    const tickLabels = s.unit === 'mi' ? ['0', '½', '1', '1½', '2 mi'] : ['0', '0.8', '1.6', '2.4', '3.2 km'];
    ticks.forEach((d, i) => {
      const t = el('text', { x: x(d), y: H - 7, class: 'reach-axis', 'text-anchor': i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle' });
      t.textContent = tickLabels[i];
      svg.appendChild(t);
    });

    const legendRows: string[] = [];

    if (this.view === 'cities') {
      this.overlays = this.overlays.filter((id) => id !== s.cityId && m.cities[id]);
      this.overlays.forEach((id, i) => {
        const oc = m.cities[id];
        const p = curvePath(oc, s.enabledModes, step);
        if (p) svg.appendChild(el('path', { d: p, class: 'reach-line', stroke: OVERLAY_COLORS[i], 'stroke-width': 1.8, opacity: 0.9 }));
        const v = coverageAt(oc, s.enabledModes, s.distanceM, step);
        legendRows.push(
          `<button type="button" class="reach-chip" data-remove="${id}" title="Remove"><span class="reach-swatch" style="background:${OVERLAY_COLORS[i]}"></span>${oc.name}<b>${v === null ? '—' : v.toFixed(0) + '%'}</b><span class="reach-x">×</span></button>`
        );
      });
      const p = curvePath(city, s.enabledModes, step);
      if (p) svg.appendChild(el('path', { d: p, class: 'reach-line', stroke: '#2dd4bf', 'stroke-width': 2.6 }));
      const v = coverageAt(city, s.enabledModes, s.distanceM, step);
      legendRows.unshift(
        `<span class="reach-chip current"><span class="reach-swatch" style="background:#2dd4bf"></span>${city.name}<b>${v === null ? '—' : v.toFixed(0) + '%'}</b></span>`
      );
      if (v !== null) svg.appendChild(el('circle', { cx: x(s.distanceM), cy: y(v), r: 4, class: 'reach-dot' }));
    } else {
      // By mode: each mode alone, plus all enabled modes together.
      for (const mm of MODES) {
        const n = city.station_counts[mm.code] || 0;
        if (!n) continue;
        const only = new Set<ModeCode>([mm.code]);
        const p = curvePath(city, only, step);
        if (!p) continue;
        svg.appendChild(el('path', { d: p, class: 'reach-line', stroke: mm.color, 'stroke-width': 1.7, opacity: 0.95 }));
        const halfPct = coverageAt(city, only, HALF_MI, step) ?? 0;
        const perStation = (halfPct / 100) * city.ghsl_pop / n;
        legendRows.push(
          `<span class="reach-chip mode" title="People within ½ mile (0.8 km) of a ${mm.shortLabel} station, per station"><span class="reach-swatch" style="background:${mm.color}"></span>${mm.shortLabel}<b>${halfPct.toFixed(0)}%</b><i>${fmtK(perStation)}/stn</i></span>`
        );
      }
      const p = curvePath(city, s.enabledModes, step);
      if (p) svg.appendChild(el('path', { d: p, class: 'reach-line', stroke: '#e2e8f0', 'stroke-width': 2.2, 'stroke-dasharray': '4 3' }));
      legendRows.unshift(`<span class="reach-chip current"><span class="reach-swatch dashed"></span>All selected</span>`);
    }

    // Slider marker
    svg.appendChild(el('line', { x1: x(s.distanceM), x2: x(s.distanceM), y1: PAD.t, y2: H - PAD.b, class: 'reach-marker' }));

    this.legend.innerHTML = legendRows.join('');
    this.legend.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        this.overlays = this.overlays.filter((id) => id !== b.dataset.remove);
        this.onOverlaysChanged();
        this.render();
      })
    );

    // Insight line
    const share = closeInShare(city, s.enabledModes, step);
    const half = coverageAt(city, s.enabledModes, HALF_MI, step);
    const one = coverageAt(city, s.enabledModes, ONE_MI, step);
    const halfLbl = s.unit === 'mi' ? '½ mi' : '0.8 km';
    const oneLbl = s.unit === 'mi' ? '1 mi' : '1.6 km';
    if (share === null || half === null || one === null) {
      this.insight.innerHTML = `Too little coverage at ${oneLbl} for a close-in share.`;
    } else {
      const verdict = share >= 70 ? 'stations sit among homes' : share >= 55 ? 'mixed' : 'many people live a long walk from a station';
      this.insight.innerHTML = `<b>Close-in share ${share.toFixed(0)}%</b> — ${half.toFixed(0)}% within ${halfLbl} vs ${one.toFixed(0)}% within ${oneLbl} (${verdict}).`;
    }
  }
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

