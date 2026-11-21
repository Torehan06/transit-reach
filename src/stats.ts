import { CitySummary, CoverageStats, DistanceUnit, MODES, ModeCode } from './types';

export const METERS_PER_MILE = 1609.344;
export const MAX_DISTANCE_M = 3219; // 2.00 miles
export const DEFAULT_DISTANCE_M = 1609; // 1.00 mile
const WALK_SPEED_M_PER_MIN = 83.33; // 5 km/h = 3.1 mph

export function modesToMask(enabledModes: Set<ModeCode>): number {
  let mask = 0;
  for (const m of MODES) {
    if (enabledModes.has(m.code)) mask |= m.bit;
  }
  return mask;
}

function interpolateCurve(curve: number[], distanceM: number, stepM: number): number {
  if (distanceM <= 0) return curve[0] ?? 0;
  const maxIdx = curve.length - 1;
  const exactIdx = distanceM / stepM;
  if (exactIdx >= maxIdx) return curve[maxIdx] ?? 0;
  const lo = Math.floor(exactIdx);
  const hi = Math.ceil(exactIdx);
  if (lo === hi) return curve[lo] ?? 0;
  const frac = exactIdx - lo;
  return curve[lo] + (curve[hi] - curve[lo]) * frac;
}

export function computeCityCoverage(
  city: CitySummary,
  enabledModes: Set<ModeCode>,
  distanceM: number,
  bucketStepM: number
): CoverageStats {
  const activeStations = MODES.reduce(
    (sum, m) => sum + (enabledModes.has(m.code) ? city.station_counts[m.code] || 0 : 0),
    0
  );

  const effectiveMask = modesToMask(enabledModes) & city.available_modes_mask;
  if (effectiveMask === 0 || city.ghsl_pop <= 0 || city.land_cells <= 0) {
    return {
      coveredPop: 0,
      totalPop: city.ghsl_pop,
      popPct: 0,
      coveredAreaKm2: 0,
      totalAreaKm2: city.area_km2,
      areaPct: 0,
      activeStations,
    };
  }

  const key = String(effectiveMask);
  const popCurve = city.pop_curves[key];
  const areaCurve = city.area_curves[key];
  if (!popCurve || !areaCurve) {
    return {
      coveredPop: 0,
      totalPop: city.ghsl_pop,
      popPct: 0,
      coveredAreaKm2: 0,
      totalAreaKm2: city.area_km2,
      areaPct: 0,
      activeStations,
    };
  }

  const coveredPop = Math.min(city.ghsl_pop, interpolateCurve(popCurve, distanceM, bucketStepM));
  const coveredCells = Math.min(city.land_cells, interpolateCurve(areaCurve, distanceM, bucketStepM));
  const coveredAreaKm2 = coveredCells * 0.01;

  return {
    coveredPop,
    totalPop: city.ghsl_pop,
    popPct: (coveredPop / city.ghsl_pop) * 100,
    coveredAreaKm2,
    totalAreaKm2: city.area_km2,
    areaPct: (coveredCells / city.land_cells) * 100,
    activeStations,
  };
}

export function formatDistance(meters: number, unit: DistanceUnit): string {
  if (unit === 'mi') {
    const mi = meters / METERS_PER_MILE;
    return `${mi.toFixed(2)} mi`;
  }
  const km = meters / 1000;
  return `${km.toFixed(2)} km`;
}

export function formatShortDistance(meters: number, unit: DistanceUnit): string {
  if (unit === 'mi') {
    const mi = meters / METERS_PER_MILE;
    return mi < 0.1 ? `${Math.round(meters * 3.28084)} ft` : `${mi.toFixed(2)} mi`;
  }
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
}

export function formatWalkMinutes(meters: number): string {
  const mins = Math.round(meters / WALK_SPEED_M_PER_MIN);
  if (mins <= 1) return '~1 min walk';
  return `~${mins} min walk`;
}

export function formatCompactPop(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatArea(km2: number, unit: DistanceUnit): string {
  if (unit === 'mi') {
    const mi2 = km2 * 0.386102;
    return `${mi2 >= 100 ? Math.round(mi2) : mi2.toFixed(1)} mi²`;
  }
  return `${km2 >= 100 ? Math.round(km2) : km2.toFixed(1)} km²`;
}

/** Match exact zoom tiers baked into the dots PMTiles layer (z8..z13). */
export function peoplePerDotForZoom(zoom: number): number {
  const z = Math.floor(zoom);
  if (z < 11) return 500;
  if (z === 11) return 100;
  if (z === 12) return 50;
  return 25;
}
