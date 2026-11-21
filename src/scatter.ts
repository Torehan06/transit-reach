/**
 * "Stations vs reach" scatter for the comparison modal.
 *
 * x: stations per million residents (log scale), y: share of residents within
 * the current walking distance (current modes). A logistic fit through all
 * cities shows what a given station count usually buys; cities above the line
 * reach more people than their station count predicts (stations among homes,
 * dense cores), cities below reach fewer (stations in medians, rail corridors,
 * or spread-out cities).
 */
import { computeCityCoverage } from './stats';
import { AppState, CitySummary, MODES, SummaryManifest } from './types';

const W = 360;
const H = 220;
const PAD = { l: 34, r: 10, t: 10, b: 30 };
const X_MIN = Math.log10(2);
const X_MAX = Math.log10(1000);
const NS = 'http://www.w3.org/2000/svg';

interface Pt {
  city: CitySummary;
  lx: number; // log10 stations per million
  pct: number;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

const sx = (lx: number) => PAD.l + ((Math.max(X_MIN, Math.min(X_MAX, lx)) - X_MIN) / (X_MAX - X_MIN)) * (W - PAD.l - PAD.r);
const sy = (pct: number) => H - PAD.b - (Math.max(0, Math.min(100, pct)) / 100) * (H - PAD.t - PAD.b);
const logit = (p: number) => Math.log(p / (1 - p));

export function renderScatter(
  container: HTMLElement,
  caption: HTMLElement,
  manifest: SummaryManifest,
  state: AppState,
  onPick: (cityId: string) => void
): void {
  const pts: Pt[] = [];
  for (const city of Object.values(manifest.cities)) {
    const stations = MODES.reduce((s, m) => s + (state.enabledModes.has(m.code) ? city.station_counts[m.code] || 0 : 0), 0);
    if (stations < 3 || city.ghsl_pop <= 0) continue;
    const pct = computeCityCoverage(city, state.enabledModes, state.distanceM, manifest.bucket_step_m).popPct;
    pts.push({ city, lx: Math.log10(stations / (city.ghsl_pop / 1e6)), pct });
  }

  // Least-squares fit of logit(coverage) on log(stations per million).
  const fit = pts.filter((p) => p.pct > 0.5 && p.pct < 99.5);
  let a = 0;
  let b = 0;
  let r2 = 0;
  if (fit.length > 5) {
    const xs = fit.map((p) => p.lx);
    const ys = fit.map((p) => logit(p.pct / 100));
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    xs.forEach((x, i) => {
      sxy += (x - mx) * (ys[i] - my);
      sxx += (x - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    });
    b = sxy / sxx;
    a = my - b * mx;
    r2 = (sxy * sxy) / (sxx * syy);
  }
  const predict = (lx: number) => 100 / (1 + Math.exp(-(a + b * lx)));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'scatter-svg', role: 'img' });
  for (const pct of [0, 25, 50, 75, 100]) {
    svg.appendChild(svgEl('line', { x1: PAD.l, x2: W - PAD.r, y1: sy(pct), y2: sy(pct), class: 'reach-grid' }));
    const t = svgEl('text', { x: PAD.l - 5, y: sy(pct) + 3, class: 'reach-axis', 'text-anchor': 'end' });
    t.textContent = `${pct}%`;
    svg.appendChild(t);
  }
  for (const v of [3, 10, 30, 100, 300, 1000]) {
    const lx = Math.log10(v);
    svg.appendChild(svgEl('line', { x1: sx(lx), x2: sx(lx), y1: PAD.t, y2: H - PAD.b, class: 'reach-grid' }));
    const t = svgEl('text', { x: sx(lx), y: H - PAD.b + 12, class: 'reach-axis', 'text-anchor': 'middle' });
    t.textContent = String(v);
    svg.appendChild(t);
  }
  const xl = svgEl('text', { x: (PAD.l + W - PAD.r) / 2, y: H - 3, class: 'reach-axis', 'text-anchor': 'middle' });
  xl.textContent = 'stations per million residents (log scale)';
  svg.appendChild(xl);

  if (fit.length > 5) {
    const d: string[] = [];
    for (let lx = X_MIN; lx <= X_MAX + 1e-9; lx += 0.05) d.push(`${d.length ? 'L' : 'M'}${sx(lx).toFixed(1)},${sy(predict(lx)).toFixed(1)}`);
    svg.appendChild(svgEl('path', { d: d.join(''), class: 'scatter-fit' }));
  }

  const tip = svgEl('text', { x: PAD.l + 6, y: PAD.t + 12, class: 'scatter-tip' });
  for (const p of pts) {
    const isCur = p.city.id === state.cityId;
    const above = p.pct - predict(p.lx);
    const c = svgEl('circle', {
      cx: sx(p.lx),
      cy: sy(p.pct),
      r: isCur ? 5 : 3,
      class: `scatter-pt${isCur ? ' current' : ''}${above >= 0 ? ' above' : ' below'}`,
    });
    const label = `${p.city.name}: ${p.pct.toFixed(0)}% (${above >= 0 ? '+' : ''}${above.toFixed(0)} vs trend)`;
    c.appendChild(svgEl('title', {})).textContent = label;
    c.addEventListener('pointerenter', () => (tip.textContent = label));
    c.addEventListener('click', () => onPick(p.city.id));
    svg.appendChild(c);
  }
  const cur = pts.find((p) => p.city.id === state.cityId);
  tip.textContent = cur ? `${cur.city.name}: ${cur.pct.toFixed(0)}% (${cur.pct - predict(cur.lx) >= 0 ? '+' : ''}${(cur.pct - predict(cur.lx)).toFixed(0)} vs trend)` : 'Tap a dot';
  svg.appendChild(tip);

  container.replaceChildren(svg);
  caption.textContent =
    fit.length > 5
      ? `Station count per resident explains about ${Math.round(r2 * 100)}% of the differences between cities. Dots above the line reach more people than their station count predicts (stations where people live, dense cores); dots below reach fewer. Tap a dot to open that city.`
      : '';
}
