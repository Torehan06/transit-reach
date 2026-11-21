import { CitySummary } from './types';

/**
 * Continent grouping for the city picker and the comparison filter.
 *
 * The `region` field in summary.json comes from the published data release, so
 * the grouping is derived here in the frontend instead. That way, changing a
 * group never requires re-running the pipeline.
 */
export const CONTINENTS = ['Europe', 'Asia', 'North America', 'South America', 'Oceania'] as const;
export type Continent = (typeof CONTINENTS)[number];

const COUNTRY_CONTINENT: Record<string, Continent> = {
  // Europe
  Austria: 'Europe',
  Belgium: 'Europe',
  Czechia: 'Europe',
  Denmark: 'Europe',
  France: 'Europe',
  Germany: 'Europe',
  Greece: 'Europe',
  Italy: 'Europe',
  Netherlands: 'Europe',
  Poland: 'Europe',
  Portugal: 'Europe',
  Russia: 'Europe',
  Spain: 'Europe',
  Sweden: 'Europe',
  Switzerland: 'Europe',
  'United Kingdom': 'Europe',
  // Asia (Türkiye is Asia except Istanbul; see CITY_OVERRIDES)
  Azerbaijan: 'Asia',
  China: 'Asia',
  Georgia: 'Asia',
  'Hong Kong': 'Asia',
  India: 'Asia',
  Japan: 'Asia',
  Kazakhstan: 'Asia',
  Singapore: 'Asia',
  'South Korea': 'Asia',
  Taiwan: 'Asia',
  Türkiye: 'Asia',
  'United Arab Emirates': 'Asia',
  // North America
  Canada: 'North America',
  Mexico: 'North America',
  'United States': 'North America',
  // South America
  Argentina: 'South America',
  Brazil: 'South America',
  Chile: 'South America',
  // Oceania
  Australia: 'Oceania',
};

// Istanbul's historic core, most of its population, and most of its rail network
// are on the European side.
const CITY_OVERRIDES: Record<string, Continent> = {
  istanbul: 'Europe',
};

export function continentOf(city: Pick<CitySummary, 'id' | 'country' | 'region'>): Continent | string {
  return CITY_OVERRIDES[city.id] ?? COUNTRY_CONTINENT[city.country] ?? city.region;
}

/** "Istanbul, Türkiye"; just "Singapore" when the city and country names match. */
export function cityLabel(city: Pick<CitySummary, 'name' | 'country'>): string {
  return city.name === city.country ? city.name : `${city.name}, ${city.country}`;
}

/** Sort by English country name, then city name. */
export function compareCities(a: CitySummary, b: CitySummary): number {
  return a.country.localeCompare(b.country, 'en') || a.name.localeCompare(b.name, 'en');
}

/** Cities grouped by continent in CONTINENTS order; unknown groups go last. */
export function groupByContinent(cities: CitySummary[]): [string, CitySummary[]][] {
  const groups = new Map<string, CitySummary[]>();
  for (const c of cities) {
    const key = continentOf(c);
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  const order = (k: string) => {
    const i = (CONTINENTS as readonly string[]).indexOf(k);
    return i === -1 ? CONTINENTS.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([k, list]) => [k, list.slice().sort(compareCities)]);
}

/** Fill a <select> with continent optgroups. */
export function fillCitySelect(sel: HTMLSelectElement, cities: CitySummary[]): void {
  sel.innerHTML = '';
  for (const [continent, list] of groupByContinent(cities)) {
    const group = document.createElement('optgroup');
    group.label = continent;
    for (const c of list) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = cityLabel(c);
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
}
