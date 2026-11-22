/**
 * Walking route from a tapped point to its nearest station, reconstructed in
 * the browser from the street tiles.
 *
 * Every street segment in the tiles carries its walking distance to the
 * nearest station (the pipeline's Dijkstra result). That distance field only
 * decreases along shortest paths, so starting from the segment next to the
 * tap and repeatedly stepping to the touching segment with the lowest
 * distance walks down the shortest-path tree to the station. Needs the street
 * tiles at high zoom (minor streets are dropped at low zoom); returns null
 * when the descent gets stuck, and the caller falls back to a straight line.
 */
import type maplibregl from 'maplibre-gl';
import { haversineMeters } from './map';
import { MODE_BY_CODE, ModeCode } from './types';

interface Seg {
  coords: [number, number][];
  d: number;
}

// Segments count as touching within 40 m: tile clipping, coordinate
// quantisation and footpaths missing from the tiles leave small gaps.
const CELL = 4e-4;
const cellKey = (x: number, y: number) => `${x},${y}`;
const MATCH_M = 40;

export function traceWalk(
  map: maplibregl.Map,
  from: [number, number],
  to: [number, number],
  modes: ModeCode[],
  maxWalkM: number
): [number, number][] | null {
  if (map.getZoom() < 12 || !map.getSource('city-tiles')) return null;
  const pad = (maxWalkM + 400) / 111_000;
  const padLon = pad / Math.cos((from[1] * Math.PI) / 180);
  const minLon = Math.min(from[0], to[0]) - padLon;
  const maxLon = Math.max(from[0], to[0]) + padLon;
  const minLat = Math.min(from[1], to[1]) - pad;
  const maxLat = Math.max(from[1], to[1]) + pad;

  const segs: Seg[] = [];
  const byVertex = new Map<string, number[]>();
  for (const f of map.querySourceFeatures('city-tiles', { sourceLayer: 'streets' })) {
    const g = f.geometry;
    const lines: number[][][] = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    let d = Infinity;
    for (const m of modes) {
      const v = Number(f.properties?.[MODE_BY_CODE[m].distProp]);
      if (Number.isFinite(v) && v < d) d = v;
    }
    if (!Number.isFinite(d)) continue;
    for (const line of lines) {
      if (!line.some((c) => c[0] >= minLon && c[0] <= maxLon && c[1] >= minLat && c[1] <= maxLat)) continue;
      const idx = segs.length;
      segs.push({ coords: line as [number, number][], d });
      for (const c of line) {
        const k = cellKey(Math.floor(c[0] / CELL), Math.floor(c[1] / CELL));
        (byVertex.get(k) ?? byVertex.set(k, []).get(k)!).push(idx);
      }
    }
  }
  if (!segs.length) return null;

  // Start at the segment closest to the tap.
  let cur = -1;
  let best = Infinity;
  segs.forEach((s, i) => {
    for (const c of s.coords) {
      const h = haversineMeters(from[0], from[1], c[0], c[1]);
      if (h < best) {
        best = h;
        cur = i;
      }
    }
  });
  if (cur < 0 || best > 250) return null;

  const path: [number, number][] = [from];
  const seen = new Set<number>([cur]);
  for (let step = 0; step < 600; step++) {
    const s = segs[cur];
    // Append this segment in the direction of travel (towards the lower end).
    const first = s.coords[0];
    const last = s.coords[s.coords.length - 1];
    const tail = path[path.length - 1];
    const forward = haversineMeters(tail[0], tail[1], first[0], first[1]) <= haversineMeters(tail[0], tail[1], last[0], last[1]);
    path.push(...(forward ? s.coords : [...s.coords].reverse()));
    if (s.d <= 40) {
      path.push(to);
      return path;
    }
    // Step to the touching segment with the lowest distance (ties allowed,
    // since distances are quantised to 25 m; `seen` prevents loops).
    let next = -1;
    let nd = s.d;
    for (const c of s.coords) {
      const cx = Math.floor(c[0] / CELL);
      const cy = Math.floor(c[1] / CELL);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const j of byVertex.get(cellKey(cx + dx, cy + dy)) ?? []) {
            if (seen.has(j) || segs[j].d > nd || (next >= 0 && segs[j].d === nd)) continue;
            if (!segs[j].coords.some((v) => haversineMeters(v[0], v[1], c[0], c[1]) <= MATCH_M)) continue;
            nd = segs[j].d;
            next = j;
          }
    }
    if (next < 0) {
      // Gap (a footpath or crossing missing from the tiles): hop to the
      // lowest-distance segment within 150 m, drawn as a short straight link.
      const tl = path[path.length - 1];
      segs.forEach((g, j) => {
        if (seen.has(j) || g.d >= nd || g.d >= s.d) return;
        if (g.coords.some((v) => haversineMeters(v[0], v[1], tl[0], tl[1]) <= 150)) {
          nd = g.d;
          next = j;
        }
      });
    }
    if (next < 0) {
      // Stuck (tile edge or a dropped street). Accept if we are already close.
      if (haversineMeters(path[path.length - 1][0], path[path.length - 1][1], to[0], to[1]) < 120) {
        path.push(to);
        return path;
      }
      return null;
    }
    seen.add(next);
    cur = next;
  }
  return null;
}
