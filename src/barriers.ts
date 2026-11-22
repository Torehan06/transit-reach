/**
 * Walking barriers: people who are close to a station as the crow flies but
 * far from one on foot (highway medians, rail cuts, rivers, gated superblocks).
 *
 * For each population dot in view: h = straight-line distance to the nearest
 * station of the selected modes, w = real street walking distance to the
 * nearest station (baked into the tiles). Because w is the minimum over all
 * stations, the walk to that nearest-by-air station is at least w, so a dot
 * with h ≤ 800 m and w ≥ 2h (and w − h ≥ 400 m) really has a detour of at
 * least that size. Flagged dots are drawn on the map and grouped into ~1 km
 * clusters, each labelled with the nearby station.
 */
import type { GeoJSONSource } from 'maplibre-gl';
import { TransitMap, haversineMeters } from './map';
import { formatCompactPop, formatShortDistance } from './stats';
import { DistanceUnit, MODE_BY_CODE, ModeCode, StationRecord } from './types';

const NEAR_M = 800;
const MIN_RATIO = 2;
const MIN_EXTRA_M = 400;
const CELL_M = 1000;
const MIN_SEPARATION_M = 2000;

export interface BarrierCluster {
  lon: number;
  lat: number;
  people: number;
  station: StationRecord;
  straightM: number; // median straight-line distance in the cluster
  walkM: number; // median walking distance in the cluster
}

export interface BarrierResult {
  people: number;
  nearPeople: number; // everyone within NEAR_M straight-line (the base)
  clusters: BarrierCluster[];
  points: [number, number][];
  peoplePerDot: number;
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

export function findBarriers(tm: TransitMap, modes: ModeCode[], max = 3): BarrierResult {
  const { dots, peoplePerDot } = tm.queryDots();
  const stations = tm.getStations().filter((s) => modes.includes(s.mode));
  const empty: BarrierResult = { people: 0, nearPeople: 0, clusters: [], points: [], peoplePerDot };
  if (!dots.length || !stations.length) return empty;

  // Grid index of stations (~1 km cells) for fast nearest-by-air lookups.
  const lat0 = dots[0].lat;
  const mLat = 111_000;
  const mLon = 111_000 * Math.cos((lat0 * Math.PI) / 180);
  const grid = new Map<string, StationRecord[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (const s of stations) {
    const k = key(Math.floor((s.lon * mLon) / CELL_M), Math.floor((s.lat * mLat) / CELL_M));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(s);
  }

  let near = 0;
  const flagged: { lon: number; lat: number; h: number; w: number; st: StationRecord }[] = [];
  for (const d of dots) {
    const cx = Math.floor((d.lon * mLon) / CELL_M);
    const cy = Math.floor((d.lat * mLat) / CELL_M);
    let best: StationRecord | null = null;
    let h = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const s of grid.get(key(cx + dx, cy + dy)) ?? []) {
          const m = haversineMeters(d.lon, d.lat, s.lon, s.lat);
          if (m < h) {
            h = m;
            best = s;
          }
        }
    if (!best || h > NEAR_M) continue;
    near++;
    const w = TransitMap.dotDistance(d.props, modes);
    if (w >= MIN_RATIO * Math.max(h, 100) && w - h >= MIN_EXTRA_M) flagged.push({ lon: d.lon, lat: d.lat, h, w, st: best });
  }

  const cells = new Map<string, typeof flagged>();
  for (const f of flagged) {
    const k = key(Math.floor((f.lon * mLon) / CELL_M), Math.floor((f.lat * mLat) / CELL_M));
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(f);
  }
  const ranked = [...cells.values()].sort((a, b) => b.length - a.length);
  const clusters: BarrierCluster[] = [];
  for (const c of ranked) {
    if (clusters.length >= max) break;
    const lon = c.reduce((s, f) => s + f.lon, 0) / c.length;
    const lat = c.reduce((s, f) => s + f.lat, 0) / c.length;
    if (clusters.some((g) => haversineMeters(g.lon, g.lat, lon, lat) < MIN_SEPARATION_M)) continue;
    // Most common nearby station in the cluster.
    const counts = new Map<number, number>();
    for (const f of c) counts.set(f.st.id, (counts.get(f.st.id) ?? 0) + 1);
    const topId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const station = c.find((f) => f.st.id === topId)!.st;
    clusters.push({
      lon,
      lat,
      people: c.length * peoplePerDot,
      station,
      straightM: median(c.map((f) => f.h)),
      walkM: median(c.map((f) => (Number.isFinite(f.w) ? f.w : 3300))),
    });
  }
  return {
    people: flagged.length * peoplePerDot,
    nearPeople: near * peoplePerDot,
    clusters,
    points: flagged.map((f) => [f.lon, f.lat]),
    peoplePerDot,
  };
}

export function drawBarriers(tm: TransitMap, points: [number, number][]): void {
  const map = tm.map;
  const data: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: points.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })),
  };
  const src = map.getSource('barrier-src') as GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    return;
  }
  if (!points.length) return;
  map.addSource('barrier-src', { type: 'geojson', data });
  map.addLayer(
    {
      id: 'barrier-layer',
      type: 'circle',
      source: 'barrier-src',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2, 13, 3.5, 16, 5],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#f43f5e',
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.9,
      },
    },
    map.getLayer('stations-layer') ? 'stations-layer' : undefined
  );
}

export function renderBarriers(
  container: HTMLElement,
  res: BarrierResult,
  unit: DistanceUnit,
  onShow: (c: BarrierCluster) => void
): void {
  if (!res.nearPeople) {
    container.innerHTML = `<p class="gaps-empty">No population within ${formatShortDistance(NEAR_M, unit)} of a station in view.</p>`;
    return;
  }
  const share = (res.people / res.nearPeople) * 100;
  const head = `<p class="barrier-head"><b>≈${formatCompactPop(res.people)} people</b> (${share.toFixed(0)}% of those within ${formatShortDistance(
    NEAR_M,
    unit
  )} of a station as the crow flies) have to walk at least twice as far, marked with red rings.</p>`;
  const rows = res.clusters
    .map(
      (c, i) => `<div class="gap-row">
        <span class="gap-rank">${i + 1}</span>
        <div class="gap-text"><b>≈${formatCompactPop(c.people)} people</b> near <span class="mode-dot" style="background:${
          MODE_BY_CODE[c.station.mode].color
        }"></span>${escapeHtml(c.station.name)}<br><span>${formatShortDistance(c.straightM, unit)} away, ${c.walkM >= 3300 ? `over ${formatShortDistance(3200, unit)}` : formatShortDistance(c.walkM, unit)} on foot</span></div>
        <div class="gap-actions"><button type="button" class="text-btn" data-bshow="${i}">Show</button></div>
      </div>`
    )
    .join('');
  container.innerHTML =
    head + rows + `<p class="gaps-note">From population dots in view (1 dot = ${res.peoplePerDot} people), using real street walking distances.</p>`;
  container.querySelectorAll<HTMLButtonElement>('[data-bshow]').forEach((b) =>
    b.addEventListener('click', () => onShow(res.clusters[Number(b.dataset.bshow)]))
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}
