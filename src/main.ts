import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import { CompareModal } from './compare';
import { cityLabel, fillCitySelect } from './regions';
import { ReachChart } from './reach';
import { DETOUR_FACTOR, Scenario, decodeSketch } from './scenario';
import { CircleTool } from './circle';
import { UcStats, loadUrbanData, ucFor, urbanManifest } from './urban';
import { findGaps, renderGaps } from './gaps';
import { BottomSheet } from './sheet';
import { InspectResult, TransitMap } from './map';
import {
  DEFAULT_DISTANCE_M,
  computeCityCoverage,
  formatArea,
  formatCompactPop,
  formatDistance,
  formatShortDistance,
  formatWalkMinutes,
  peoplePerDotForZoom,
} from './stats';
import {
  AppState,
  CitySummary,
  DistanceUnit,
  MODES,
  MODE_BY_CODE,
  ModeCode,
  StationRecord,
  StationTuple,
  SummaryManifest,
} from './types';

let manifest: SummaryManifest;
let transitMap: TransitMap;
let compareModal: CompareModal;
let reachChart: ReachChart;
let scenario: Scenario;
let circleTool: CircleTool;
const stationCache = new Map<string, StationRecord[]>();
let lastInspect: InspectResult | null = null;

const state: AppState = {
  cityId: '',
  distanceM: DEFAULT_DISTANCE_M,
  unit: 'mi',
  enabledModes: new Set<ModeCode>(MODES.map((m) => m.code)),
  showDots: true,
  showStations: true,
  area: 'city',
};

// DOM references
const citySelect = document.getElementById('city-select') as HTMLSelectElement;
const boundaryNoteEl = document.getElementById('city-boundary-note')!;
const dataWarningEl = document.getElementById('city-data-warning')!;
const kpiPopPct = document.getElementById('kpi-pop-pct')!;
const kpiPopBar = document.getElementById('kpi-pop-bar')!;
const kpiPopSub = document.getElementById('kpi-pop-sub')!;
const kpiAreaPct = document.getElementById('kpi-area-pct')!;
const kpiAreaBar = document.getElementById('kpi-area-bar')!;
const kpiAreaSub = document.getElementById('kpi-area-sub')!;

const mobileCityName = document.getElementById('mobile-city-name')!;
const mobileCitySelect = document.getElementById('mobile-city-select') as HTMLSelectElement;
const mobilePopPct = document.getElementById('mobile-pop-pct')!;
const mobileAreaPct = document.getElementById('mobile-area-pct')!;

const distanceSlider = document.getElementById('distance-slider') as HTMLInputElement;
const distanceValueEl = document.getElementById('distance-value')!;
const walkTimeEl = document.getElementById('walk-time')!;
const tickMid = document.getElementById('tick-mid')!;
const tickMax = document.getElementById('tick-max')!;
const unitMiBtn = document.getElementById('unit-mi')!;
const unitKmBtn = document.getElementById('unit-km')!;

const modeGrid = document.getElementById('mode-grid')!;
const toggleDots = document.getElementById('toggle-dots') as HTMLInputElement;
const toggleStations = document.getElementById('toggle-stations') as HTMLInputElement;

const legendPpd = document.getElementById('legend-ppd')!;
const legendDotsItem = document.getElementById('legend-dots-item')!;
const loadingPill = document.getElementById('loading-pill')!;

const inspectCard = document.getElementById('inspect-card')!;
const inspectDist = document.getElementById('inspect-dist')!;
const inspectBody = document.getElementById('inspect-body')!;

const controlPanel = document.getElementById('control-panel')!;
const gapsList = document.getElementById('gaps-list')!;
const sheet = new BottomSheet(
  controlPanel,
  document.getElementById('sheet-handle')!,
  document.querySelector('.slider-section') as HTMLElement
);

function currentCity(): CitySummary {
  return manifest.cities[state.cityId];
}

/** Stats for the current view (city limits or urban area); map data always comes from currentCity(). */
let statsManifest: SummaryManifest;
let urbanData: Record<string, UcStats> | null = null;
function statsCity(): CitySummary {
  return statsManifest?.cities[state.cityId] ?? currentCity();
}

function updateBoundaryNote(): void {
  const c = statsCity();
  boundaryNoteEl.textContent =
    state.area === 'urban'
      ? c.uc_missing
        ? `No urban-centre data for this city; showing ${currentCity().boundary_desc}.`
        : `${c.boundary_desc} Dots are only drawn inside the city limits; the dashed line marks the urban area.`
      : currentCity().boundary_desc;
  document.querySelectorAll<HTMLButtonElement>('[data-area]').forEach((b) => {
    const on = b.dataset.area === state.area;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  transitMap?.setUrbanOutline(state.area === 'urban' && urbanData ? ucFor(urbanData, state.cityId)?.geom ?? null : null);
}

async function setArea(area: 'city' | 'urban'): Promise<void> {
  if (area === 'urban') {
    try {
      urbanData = await loadUrbanData(dataAssetUrl('data/summary_uc.json'));
    } catch {
      boundaryNoteEl.textContent = 'Urban-area data could not be loaded.';
      return;
    }
    statsManifest = urbanManifest(manifest, urbanData);
  } else {
    statsManifest = manifest;
  }
  state.area = area;
  document.body.classList.toggle('area-urban', area === 'urban');
  compareModal.setManifest(statsManifest);
  reachChart.setManifest(statsManifest);
  renderModeToggles();
  updateBoundaryNote();
  onSettingsChanged();
}

function parseHashState(): void {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return;
  const params = new URLSearchParams(raw);
  const cid = params.get('city');
  if (cid && manifest.cities[cid]) {
    state.cityId = cid;
  }
  const rawD = params.get('d');
  if (rawD !== null && rawD !== '') {
    const d = Number(rawD);
    if (Number.isFinite(d) && d >= 0 && d <= 3219) {
      state.distanceM = Math.round(d);
    }
  }
  const u = params.get('u');
  if (u === 'mi' || u === 'km') {
    state.unit = u;
  }
  pendingArea = params.get('a') === 'u' ? 'urban' : 'city';
  const cmp = params.get('cmp');
  pendingOverlays = cmp ? cmp.split('.').filter((id) => manifest.cities[id]).slice(0, 3) : [];
  const sk = params.get('sk');
  pendingSketch = sk ? decodeSketch(sk) : null;
  const cp = params.get('c');
  pendingCircle = cp ? CircleTool.parse(cp) : null;
}

let pendingCircle: { center: [number, number]; radius: number } | null = null;
let pendingArea: 'city' | 'urban' = 'city';
let pendingSketch: { vertices: [number, number][]; spacing: number } | null = null;

let pendingOverlays: string[] = [];

function syncHashState(): void {
  const params = new URLSearchParams();
  params.set('city', state.cityId);
  params.set('d', String(state.distanceM));
  params.set('u', state.unit);
  if (reachChart?.overlays.length) params.set('cmp', reachChart.overlays.join('.'));
  if (state.area === 'urban') params.set('a', 'u');
  const sk = scenario?.shareParam();
  if (sk) params.set('sk', sk);
  const cp = circleTool?.shareParam();
  if (cp) params.set('c', cp);
  history.replaceState(null, '', `#${params.toString()}`);
}

function populateCitySelector(): void {
  const cities = Object.values(manifest.cities);
  fillCitySelect(citySelect, cities);
  fillCitySelect(mobileCitySelect, cities);
}

function renderModeToggles(): void {
  const city = statsCity();
  modeGrid.innerHTML = '';

  for (const m of MODES) {
    const count = city.station_counts[m.code] || 0;
    const active = state.enabledModes.has(m.code);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mode-pill${active ? ' active' : ''}${count === 0 ? ' empty' : ''}`;
    btn.dataset.mode = m.code;
    btn.setAttribute('aria-pressed', String(active));
    btn.innerHTML = `
      <span class="mode-dot" style="background:${m.color}"></span>
      <span class="mode-label">${m.shortLabel}</span>
      <span class="mode-count">${count}</span>
    `;
    btn.addEventListener('click', () => {
      if (state.enabledModes.has(m.code)) {
        state.enabledModes.delete(m.code);
      } else {
        state.enabledModes.add(m.code);
      }
      onSettingsChanged();
    });
    modeGrid.appendChild(btn);
  }
}

function updateModePillStates(): void {
  const city = statsCity();
  modeGrid.querySelectorAll<HTMLButtonElement>('.mode-pill').forEach((btn) => {
    const code = btn.dataset.mode as ModeCode;
    const count = city.station_counts[code] || 0;
    const active = state.enabledModes.has(code);
    btn.classList.toggle('active', active);
    btn.classList.toggle('empty', count === 0);
    btn.setAttribute('aria-pressed', String(active));
    const countEl = btn.querySelector('.mode-count');
    if (countEl) countEl.textContent = String(count);
  });
}

function updateDistanceUI(): void {
  distanceSlider.value = String(state.distanceM);
  distanceValueEl.textContent = formatDistance(state.distanceM, state.unit);
  walkTimeEl.textContent = formatWalkMinutes(state.distanceM);

  unitMiBtn.classList.toggle('active', state.unit === 'mi');
  unitKmBtn.classList.toggle('active', state.unit === 'km');

  tickMid.textContent = state.unit === 'mi' ? '1.0 mi' : '1.6 km';
  tickMax.textContent = state.unit === 'mi' ? '2.0 mi' : '3.2 km';
}

function updateCoverageKPIs(): void {
  const city = statsCity();
  const stats = computeCityCoverage(
    city,
    state.enabledModes,
    state.distanceM,
    manifest.bucket_step_m
  );

  const popText = `${stats.popPct.toFixed(1)}%`;
  const areaText = `${stats.areaPct.toFixed(1)}%`;

  kpiPopPct.textContent = popText;
  kpiPopBar.style.width = `${Math.min(100, stats.popPct)}%`;
  kpiPopSub.textContent = `${formatCompactPop(stats.coveredPop)} of ${formatCompactPop(stats.totalPop)}`;

  kpiAreaPct.textContent = areaText;
  kpiAreaBar.style.width = `${Math.min(100, stats.areaPct)}%`;
  kpiAreaSub.textContent = `${formatArea(stats.coveredAreaKm2, state.unit)} of ${formatArea(stats.totalAreaKm2, state.unit)}`;

  mobilePopPct.textContent = popText;
  mobileAreaPct.textContent = areaText;
}

function updateLegendZoom(zoom: number): void {
  const ppd = peoplePerDotForZoom(zoom);
  legendPpd.textContent = `1 dot = ${ppd.toLocaleString()} people`;
}

function renderInspectCard(res: InspectResult | null): void {
  lastInspect = res;
  if (!res) {
    inspectCard.classList.add('hidden');
    return;
  }

  inspectCard.classList.remove('hidden');

  if (res.noModesEnabled) {
    inspectDist.textContent = 'No transit modes enabled';
    inspectBody.innerHTML = '<div class="inspect-empty">Turn on at least one transit mode to measure walking distance.</div>';
    return;
  }

  if (!res.best) {
    inspectDist.textContent = 'Over 10 km from transit';
    inspectBody.innerHTML = '<div class="inspect-empty">No reachable station for the selected modes within 10 km on foot.</div>';
    return;
  }

  const best = res.best;
  const meta = MODE_BY_CODE[best.mode];
  // Beyond the precomputed network range only the straight-line distance is known;
  // estimate the walk as straight line × detour factor and say so.
  const estWalkM = best.approx ? best.distanceM * DETOUR_FACTOR : best.distanceM;
  const distStr = best.approx
    ? `≈ ${formatShortDistance(estWalkM, state.unit)}`
    : best.distanceM === 0
      ? 'At station'
      : formatShortDistance(best.distanceM, state.unit);
  const walkStr = best.approx
    ? ` · ${formatWalkMinutes(estWalkM)} (est. from ${formatShortDistance(best.distanceM, state.unit)} straight-line × ${DETOUR_FACTOR})`
    : best.distanceM === 0
      ? ''
      : ` · ${formatWalkMinutes(best.distanceM)}`;
  const within = !best.approx && res.withinReach;
  const reachClass = within ? 'in-reach' : 'out-reach';
  const reachLabel = within ? 'Within reach' : 'Beyond slider';

  inspectDist.innerHTML = `
    <span>${distStr}<span class="inspect-walk">${walkStr}</span></span>
    <span class="reach-badge ${reachClass}">${reachLabel}</span>
  `;

  const primaryHtml = `
    <div class="inspect-primary">
      <span class="mode-dot" style="background:${meta.color}"></span>
      <span class="inspect-station">${escapeHtml(best.station.name)}</span>
      <span class="inspect-mode-tag">${meta.shortLabel}</span>
    </div>
  `;

  const others = res.byMode.slice(1, 4);
  const othersHtml = others.length
    ? `<div class="inspect-others">${others
        .map((hit) => {
          const hm = MODE_BY_CODE[hit.mode];
          return `<div class="inspect-other-row">
            <span class="mode-dot" style="background:${hm.color}"></span>
            <span class="other-name">${escapeHtml(hit.station.name)}</span>
            <span class="other-dist">${formatShortDistance(hit.distanceM, state.unit)}</span>
          </div>`;
        })
        .join('')}</div>`
    : '';

  inspectBody.innerHTML = primaryHtml + othersHtml;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[ch] ?? ch;
  });
}

function updateAnalysis(): void {
  const city = statsCity();
  reachChart?.update({ cityId: state.cityId, enabledModes: state.enabledModes, distanceM: state.distanceM, unit: state.unit });
  circleTool?.update({ modes: [...state.enabledModes], distanceM: state.distanceM, unit: state.unit });
  scenario?.update({
    modes: [...state.enabledModes],
    distanceM: state.distanceM,
    unit: state.unit,
    cityPop: city.ghsl_pop,
    cityName: city.name,
  });
}

function onSettingsChanged(): void {
  updateDistanceUI();
  updateModePillStates();
  updateCoverageKPIs();
  updateAnalysis();
  legendDotsItem.classList.toggle('hidden', !state.showDots);
  transitMap.updateFilter(state.enabledModes, state.distanceM, state.showDots, state.showStations);
  compareModal.syncState(state);
  if (lastInspect) {
    renderInspectCard({
      ...lastInspect,
      withinReach: lastInspect.best !== null && lastInspect.best.distanceM <= state.distanceM,
    });
  }
  syncHashState();
}

function dataAssetUrl(relPath: string): string {
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  return new URL(relPath, base).href;
}

async function loadStations(cityId: string): Promise<StationRecord[]> {
  const cached = stationCache.get(cityId);
  if (cached) return cached;

  const url = dataAssetUrl(`data/stations/${cityId}.json`);
  const resp = await fetch(url, { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`Failed to fetch stations for ${cityId}`);
  const tuples = (await resp.json()) as StationTuple[];
  const records: StationRecord[] = tuples.map(([id, mode, name, lon, lat, inside]) => ({
    id,
    mode,
    name,
    lon,
    lat,
    inside: inside === 1,
  }));
  stationCache.set(cityId, records);
  return records;
}

async function selectCity(cityId: string): Promise<void> {
  if (!manifest.cities[cityId]) return;
  state.cityId = cityId;
  const city = currentCity();

  citySelect.value = cityId;
  mobileCitySelect.value = cityId;
  mobileCityName.textContent = city.name;
  mobileCitySelect.setAttribute('aria-label', `City: ${cityLabel(city)}`);
  updateBoundaryNote();
  if (city.data_warning) {
    dataWarningEl.textContent = city.data_warning;
    dataWarningEl.classList.remove('hidden');
  } else {
    dataWarningEl.textContent = '';
    dataWarningEl.classList.add('hidden');
  }
  renderModeToggles();
  updateCoverageKPIs();
  if (scenario?.isActive()) scenario.stop();
  if (circleTool?.isActive()) circleTool.stop();
  gapsList.innerHTML = '<p class="gaps-empty">The largest clusters of people beyond the walking distance, in the area on screen.</p>';
  updateAnalysis();
  sheet.snapTo(sheet.current, false); // content height may have changed
  syncHashState();

  loadingPill.classList.remove('hidden');
  try {
    const stations = await loadStations(cityId);
    await transitMap.loadCity(
      city,
      stations,
      state.enabledModes,
      state.distanceM,
      state.showDots,
      state.showStations
    );
  } catch (err) {
    console.error('Error loading city:', err);
  } finally {
    loadingPill.classList.add('hidden');
  }
}

function bindEvents(): void {
  citySelect.addEventListener('change', () => {
    selectCity(citySelect.value);
  });
  mobileCitySelect.addEventListener('change', () => {
    selectCity(mobileCitySelect.value);
    sheet.snapTo('peek');
  });

  distanceSlider.addEventListener('input', () => {
    state.distanceM = Number(distanceSlider.value);
    onSettingsChanged();
  });

  const setUnit = (unit: DistanceUnit) => {
    if (state.unit === unit) return;
    state.unit = unit;
    onSettingsChanged();
    if (lastInspect) renderInspectCard(lastInspect);
  };
  unitMiBtn.addEventListener('click', () => setUnit('mi'));
  unitKmBtn.addEventListener('click', () => setUnit('km'));

  document.getElementById('modes-all-btn')?.addEventListener('click', () => {
    state.enabledModes = new Set<ModeCode>(MODES.map((m) => m.code));
    onSettingsChanged();
  });

  document.getElementById('modes-rail-btn')?.addEventListener('click', () => {
    state.enabledModes = new Set<ModeCode>(['m', 't', 'c']);
    onSettingsChanged();
  });

  toggleDots.addEventListener('change', () => {
    state.showDots = toggleDots.checked;
    onSettingsChanged();
  });

  toggleStations.addEventListener('change', () => {
    state.showStations = toggleStations.checked;
    onSettingsChanged();
  });

  document.getElementById('inspect-close')?.addEventListener('click', () => {
    transitMap.clearInspect();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-area]').forEach((b) =>
    b.addEventListener('click', () => void setArea(b.dataset.area === 'urban' ? 'urban' : 'city'))
  );

  const openCompare = () => compareModal.open(state);
  document.getElementById('compare-btn')?.addEventListener('click', openCompare);
  document.getElementById('mobile-compare-btn')?.addEventListener('click', openCompare);


  window.addEventListener('hashchange', () => {
    const prevCity = state.cityId;
    parseHashState();
    if (state.cityId !== prevCity) {
      selectCity(state.cityId);
    } else {
      onSettingsChanged();
    }
  });

  let wasDesktop = window.innerWidth >= 768;
  window.addEventListener('resize', () => {
    const nowDesktop = window.innerWidth >= 768;
    if (nowDesktop !== wasDesktop) {
      wasDesktop = nowDesktop;
      transitMap?.map.resize();
      transitMap?.fitCurrentCity(250);
    }
  });
}

async function bootstrap(): Promise<void> {
  const summaryUrl = dataAssetUrl('data/summary.json');
  const resp = await fetch(summaryUrl, { cache: 'no-cache' }); // revalidate so newly shipped cities show up immediately
  if (!resp.ok) {
    throw new Error(`Could not load summary.json (${resp.status})`);
  }
  manifest = (await resp.json()) as SummaryManifest;

  const cityIds = Object.keys(manifest.cities);
  if (cityIds.length === 0) {
    throw new Error('No cities found in summary.json');
  }

  state.cityId = manifest.cities['istanbul']
    ? 'istanbul'
    : cityIds[0];
  parseHashState();

  populateCitySelector();
  updateDistanceUI();

  compareModal = new CompareModal((cid) => {
    selectCity(cid);
  });
  compareModal.init(manifest);
  statsManifest = manifest;
  document.querySelector('.area-toggle')?.classList.toggle('hidden', !manifest.has_uc);

  reachChart = new ReachChart({
    onDistancePick: (m) => {
      state.distanceM = m;
      onSettingsChanged();
    },
    onOverlaysChanged: () => syncHashState(),
  });
  reachChart.init(manifest, (sel) => fillCitySelect(sel, Object.values(manifest.cities)));
  reachChart.overlays = pendingOverlays;

  bindEvents();

  transitMap = new TransitMap(document.getElementById('map')!, {
    onReady: () => {
      updateLegendZoom(transitMap.map.getZoom());
      selectCity(state.cityId);
      if (pendingArea === 'urban' && manifest.has_uc) void setArea('urban');
      const cp = pendingCircle;
      if (cp) {
        pendingCircle = null;
        transitMap.map.once('idle', () => circleTool.start(cp.center, cp.radius));
      }
      const sk = pendingSketch;
      if (sk) {
        pendingSketch = null;
        transitMap.map.once('idle', () => scenario.load(sk.vertices, sk.spacing));
      }
    },
    onZoom: (z) => updateLegendZoom(z),
    onInspect: (res) => renderInspectCard(res),
  });

  circleTool = new CircleTool(
    transitMap,
    (active) => {
      document.body.classList.toggle('circle-active', active);
      if (active) {
        if (scenario.isActive()) scenario.stop();
        sheet.snapTo('peek');
      }
      updateAnalysis();
    },
    () => syncHashState()
  );

  scenario = new Scenario(transitMap, (active) => {
    document.body.classList.toggle('scenario-active', active);
    if (active && circleTool.isActive()) circleTool.stop();
    if (active) sheet.snapTo('peek');
    updateAnalysis();
  }, () => syncHashState());

  document.getElementById('gaps-btn')!.addEventListener('click', () => {
    const { gaps, peoplePerDot } = findGaps(transitMap, [...state.enabledModes], state.distanceM);
    renderGaps(
      gapsList,
      gaps,
      peoplePerDot,
      state.unit,
      (g) => transitMap.map.flyTo({ center: [g.lon, g.lat], zoom: Math.max(transitMap.map.getZoom(), 13) }),
      (g) => {
        transitMap.map.flyTo({ center: [g.lon, g.lat], zoom: Math.max(transitMap.map.getZoom(), 12.5) });
        scenario.start([g.lon, g.lat]);
      }
    );
    sheet.snapTo(sheet.current, false);
  });
}

bootstrap().catch((err) => {
  console.error(err);
  loadingPill.textContent = 'Failed to load data — check console';
  loadingPill.classList.remove('hidden');
});
