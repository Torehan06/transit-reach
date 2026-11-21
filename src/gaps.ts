/**
 * Biggest gaps: the densest clusters of people outside the current walking
 * distance, ranked by population, from the population dots loaded on screen.
 *
 * Dots are binned into ~1 km cells; the top cells are picked greedily with a
 * minimum separation so the list doesn't show three neighbours of one cluster.
 * Each gap is labelled with its nearest station (straight-line distance).
 */
import { TransitMap, haversineMeters } from './map';
import { formatCompactPop, formatShortDistance } from './stats';
import { DistanceUnit, MODE_BY_CODE, ModeCode, StationRecord } from './types';

const CELL_M = 1000;
const MIN_SEPARATION_M = 2500;

export interface Gap {
  lon: number;
  lat: number;
  people: number;
  nearest: StationRecord | null;
  nearestM: number;
}

export function findGaps(tm: TransitMap, modes: ModeCode[], distanceM: number, max = 3): { gaps: Gap[]; peoplePerDot: number } {
  const { dots, peoplePerDot } = tm.queryDots();
  if (!dots.length) return { gaps: [], peoplePerDot };
  const lat0 = dots[0].lat;
  const mPerDegLat = 111_000;
  const mPerDegLon = 111_000 * Math.cos((lat0 * Math.PI) / 180);

  const cells = new Map<string, { n: number; sx: number; sy: number }>();
  for (const d of dots) {
    if (TransitMap.dotDistance(d.props, modes) <= distanceM) continue;
    const cx = Math.floor((d.lon * mPerDegLon) / CELL_M);
    const cy = Math.floor((d.lat * mPerDegLat) / CELL_M);
    const k = `${cx},${cy}`;
    const c = cells.get(k) ?? { n: 0, sx: 0, sy: 0 };
    c.n++;
    c.sx += d.lon;
    c.sy += d.lat;
    cells.set(k, c);
  }

  const ranked = [...cells.values()].sort((a, b) => b.n - a.n);
  const picked: Gap[] = [];
  const stations = tm.getStations().filter((s) => modes.includes(s.mode));
  for (const c of ranked) {
    if (picked.length >= max) break;
    const lon = c.sx / c.n;
    const lat = c.sy / c.n;
    if (picked.some((g) => haversineMeters(g.lon, g.lat, lon, lat) < MIN_SEPARATION_M)) continue;
    let nearest: StationRecord | null = null;
    let nearestM = Infinity;
    for (const s of stations) {
      const dm = haversineMeters(lon, lat, s.lon, s.lat);
      if (dm < nearestM) {
        nearestM = dm;
        nearest = s;
      }
    }
    picked.push({ lon, lat, people: c.n * peoplePerDot, nearest, nearestM });
  }
  return { gaps: picked, peoplePerDot };
}

export function renderGaps(
  container: HTMLElement,
  gaps: Gap[],
  peoplePerDot: number,
  unit: DistanceUnit,
  onShow: (g: Gap) => void,
  onSketch: (g: Gap) => void
): void {
  if (!gaps.length) {
    container.innerHTML = `<p class="gaps-empty">No uncovered population in view. Zoom out or lower the walking distance.</p>`;
    return;
  }
  container.innerHTML =
    gaps
      .map((g, i) => {
        const near = g.nearest
          ? `${formatShortDistance(g.nearestM, unit)} straight-line from <span class="mode-dot" style="background:${MODE_BY_CODE[g.nearest.mode].color}"></span>${escapeHtml(g.nearest.name)}`
          : 'no station of the selected modes';
        return `<div class="gap-row">
          <span class="gap-rank">${i + 1}</span>
          <div class="gap-text"><b>≈${formatCompactPop(g.people)} people</b> in this 1 km square<br><span>${near}</span></div>
          <div class="gap-actions">
            <button type="button" class="text-btn" data-show="${i}">Show</button>
            <button type="button" class="text-btn" data-sketch="${i}">Sketch a line</button>
          </div>
        </div>`;
      })
      .join('') +
    `<p class="gaps-note">From population dots in view (1 dot = ${peoplePerDot} people). Zoom out to search the whole city.</p>`;
  container.querySelectorAll<HTMLButtonElement>('[data-show]').forEach((b) =>
    b.addEventListener('click', () => onShow(gaps[Number(b.dataset.show)]))
  );
  container.querySelectorAll<HTMLButtonElement>('[data-sketch]').forEach((b) =>
    b.addEventListener('click', () => onSketch(gaps[Number(b.dataset.sketch)]))
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}
