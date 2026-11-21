export type ModeCode = 'm' | 't' | 'c' | 'b' | 'f' | 'u';

export interface ModeMeta {
  code: ModeCode;
  bit: number;
  label: string;
  shortLabel: string;
  color: string;
  distProp: string;
  stationProp: string;
}

export const MODES: readonly ModeMeta[] = [
  { code: 'm', bit: 1,  label: 'Metro / Subway',       shortLabel: 'Metro',     color: '#ef4444', distProp: 'dm', stationProp: 'sm' },
  { code: 't', bit: 2,  label: 'Tram / Light Rail',    shortLabel: 'Tram/LRT',  color: '#3b82f6', distProp: 'dt', stationProp: 'st' },
  { code: 'c', bit: 4,  label: 'Commuter Rail',        shortLabel: 'Commuter',  color: '#a855f7', distProp: 'dc', stationProp: 'sc' },
  { code: 'b', bit: 8,  label: 'BRT',                  shortLabel: 'BRT',       color: '#f97316', distProp: 'db', stationProp: 'sb' },
  { code: 'f', bit: 16, label: 'Ferry',                shortLabel: 'Ferry',     color: '#06b6d4', distProp: 'df', stationProp: 'sf' },
  { code: 'u', bit: 32, label: 'Funicular / Cable',    shortLabel: 'Funicular', color: '#ec4899', distProp: 'du', stationProp: 'su' },
] as const;

export const MODE_BY_CODE: Record<ModeCode, ModeMeta> = Object.fromEntries(
  MODES.map((m) => [m.code, m])
) as Record<ModeCode, ModeMeta>;

export interface CitySummary {
  id: string;
  name: string;
  country: string;
  region: string;
  boundary_desc: string;
  official_pop: number;
  ghsl_pop: number;
  area_km2: number;
  land_cells: number;
  bounds: [number, number, number, number]; // [west, south, east, north]
  center: [number, number];
  station_counts: Record<ModeCode, number>;
  available_modes_mask: number;
  pop_curves: Record<string, number[]>;
  area_curves: Record<string, number[]>;
  pmtiles_mb: number;
}

export interface SummaryManifest {
  bucket_step_m: number;
  max_bucket_m: number;
  modes: ModeCode[];
  cities: Record<string, CitySummary>;
}

/** Compact tuple stored in public/data/stations/<city>.json: [id, mode, name, lon, lat, inside] */
export type StationTuple = [number, ModeCode, string, number, number, number];

export interface StationRecord {
  id: number;
  mode: ModeCode;
  name: string;
  lon: number;
  lat: number;
  inside: boolean;
}

export type DistanceUnit = 'mi' | 'km';

export interface AppState {
  cityId: string;
  distanceM: number; // 0 .. 3219
  unit: DistanceUnit;
  enabledModes: Set<ModeCode>;
  showDots: boolean;
  showStations: boolean;
}

export interface CoverageStats {
  coveredPop: number;
  totalPop: number;
  popPct: number;
  coveredAreaKm2: number;
  totalAreaKm2: number;
  areaPct: number;
  activeStations: number;
}
