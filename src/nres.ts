/**
 * Non-residential buildings near stations (GHS-BUILT-S NRES R2023A, 2025):
 * built-up surface in 100 m cells of predominantly non-residential use
 * (offices, campuses, hospitals, shops, industry). A proxy for where people
 * go during the day; it measures building footprint, not people or jobs.
 * Loaded lazily from data/summary_nres.json.
 */
import { interpolateCurve, modesToMask } from './stats';
import { ModeCode } from './types';

export interface NresStats {
  total_m2: number;
  available_modes_mask: number;
  curves: Record<string, number[]>;
}

export interface NresEntry {
  city?: NresStats;
  uc?: NresStats | { same_as: string };
}

let cache: Promise<Record<string, NresEntry>> | null = null;

export function loadNres(url: string): Promise<Record<string, NresEntry>> {
  if (!cache) {
    cache = fetch(url, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`summary_nres.json: ${r.status}`);
        return r.json();
      })
      .then((j) => j.cities as Record<string, NresEntry>)
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}

/** The stats for a city in the given view, following a shared urban centre. */
export function nresFor(data: Record<string, NresEntry> | null, cityId: string, urban: boolean): NresStats | null {
  if (!data) return null;
  const e = data[cityId];
  if (!e) return null;
  if (!urban) return e.city ?? null;
  const u = e.uc;
  if (!u) return null;
  if ('same_as' in u) {
    const p = data[u.same_as]?.uc;
    return p && !('same_as' in p) ? p : null;
  }
  return u;
}

/** % of non-residential built-up area within `distanceM` walk of a selected station. */
export function nresPct(s: NresStats | null, modes: Set<ModeCode>, distanceM: number, step: number): number | null {
  if (!s || s.total_m2 <= 0) return null;
  const mask = modesToMask(modes) & s.available_modes_mask;
  const curve = mask ? s.curves[String(mask)] : undefined;
  if (!curve) return 0;
  return Math.min(100, (interpolateCurve(curve, distanceM, step) / s.total_m2) * 100);
}
