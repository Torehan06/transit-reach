/**
 * "Urban area" view: the same statistics computed over each city's GHS-UCDB
 * R2024A urban centre (EC JRC, CC BY 4.0) instead of its administrative limits.
 * Admin boundaries vary wildly (Paris = 20 arrondissements, Istanbul = 36
 * districts); urban centres use one definition everywhere (contiguous 1 km²
 * cells of ≥1,500 people/km², ≥50,000 people in total).
 *
 * The data lives in data/summary_uc.json and is fetched only when the view is
 * switched on. Several cities can share one urban centre (Tokyo, Yokohama and
 * Kawasaki): it is stored once and the others point to it with `same_as`.
 */
import { CitySummary, ModeCode, SummaryManifest } from './types';

export interface UcStats {
  uc_id: number;
  name: string;
  same_as?: string;
  ghsl_pop?: number;
  area_km2?: number;
  land_cells?: number;
  station_counts?: Record<ModeCode, number>;
  available_modes_mask?: number;
  pop_curves?: Record<string, number[]>;
  area_curves?: Record<string, number[]>;
  street_share?: number;
  geom?: GeoJSON.Geometry;
}

let cache: Promise<Record<string, UcStats>> | null = null;

export function loadUrbanData(url: string): Promise<Record<string, UcStats>> {
  if (!cache) {
    cache = fetch(url, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`summary_uc.json: ${r.status}`);
        return r.json();
      })
      .then((j) => j.cities as Record<string, UcStats>)
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}

/** Resolve a city's urban centre stats, following `same_as`. */
export function ucFor(uc: Record<string, UcStats>, cityId: string): UcStats | null {
  const e = uc[cityId];
  if (!e) return null;
  const src = e.same_as ? uc[e.same_as] : e;
  return src && src.pop_curves ? src : null;
}

/** A manifest whose stats fields come from urban centres. Map fields (bounds, tiles) are untouched. */
export function urbanManifest(base: SummaryManifest, uc: Record<string, UcStats>): SummaryManifest {
  const cities: Record<string, CitySummary> = {};
  for (const [id, city] of Object.entries(base.cities)) {
    const e = uc[id];
    const src = ucFor(uc, id);
    if (!e || !src) {
      cities[id] = { ...city, uc_missing: true };
      continue;
    }
    const shared = e.same_as && base.cities[e.same_as] ? base.cities[e.same_as].name : null;
    const partial = (src.street_share ?? 1) < 0.95 ? ' Street data covers only part of it, so coverage is understated.' : '';
    cities[id] = {
      ...city,
      ghsl_pop: src.ghsl_pop!,
      area_km2: src.area_km2!,
      land_cells: src.land_cells!,
      station_counts: src.station_counts!,
      available_modes_mask: src.available_modes_mask!,
      pop_curves: src.pop_curves!,
      area_curves: src.area_curves!,
      boundary_desc: `Urban area: ${src.name} (GHS-UCDB urban centre, ${Math.round(src.area_km2!)} km²)${
        shared ? `, shared with ${shared}` : ''
      }.${partial}`,
      uc_shared_with: e.same_as,
    };
  }
  return { ...base, cities };
}

/** Whether a city should appear in rankings in the current view (no duplicates, no missing data). */
export function rankable(c: CitySummary): boolean {
  return !c.uc_shared_with && !c.uc_missing;
}
