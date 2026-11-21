import {
  computeCityCoverage,
  formatArea,
  formatCompactPop,
  formatDistance,
} from './stats';
import { CONTINENTS, continentOf, fillCitySelect } from './regions';
import { closeInShare } from './reach';
import { renderScatter } from './scatter';
import { AppState, CitySummary, CoverageStats, MODES, SummaryManifest } from './types';

type SortKey = 'popPct' | 'areaPct' | 'coveredPop' | 'closeIn' | 'stations' | 'name';

interface RowData {
  city: CitySummary;
  stats: CoverageStats;
  closeIn: number | null;
}

export class CompareModal {
  private readonly backdrop: HTMLElement;
  private readonly subtitleEl: HTMLElement;
  private readonly selectA: HTMLSelectElement;
  private readonly selectB: HTMLSelectElement;
  private readonly sbsCards: HTMLElement;
  private readonly regionFilters: HTMLElement;
  private readonly sortSelect: HTMLSelectElement;
  private readonly tbody: HTMLElement;

  private manifest: SummaryManifest | null = null;
  private state: AppState | null = null;
  private activeRegion = 'All';
  private sortKey: SortKey = 'popPct';
  private cityA = '';
  private cityB = '';
  private onSelectCity: (cityId: string) => void;

  constructor(onSelectCity: (cityId: string) => void) {
    this.onSelectCity = onSelectCity;
    this.backdrop = document.getElementById('compare-modal')!;
    this.subtitleEl = document.getElementById('compare-subtitle')!;
    this.selectA = document.getElementById('sbs-select-a') as HTMLSelectElement;
    this.selectB = document.getElementById('sbs-select-b') as HTMLSelectElement;
    this.sbsCards = document.getElementById('sbs-cards')!;
    this.regionFilters = document.getElementById('region-filters')!;
    this.sortSelect = document.getElementById('compare-sort') as HTMLSelectElement;
    this.tbody = document.getElementById('compare-tbody')!;

    document.getElementById('compare-close')?.addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.backdrop.classList.contains('hidden')) {
        this.close();
      }
    });

    this.selectA.addEventListener('change', () => {
      this.cityA = this.selectA.value;
      this.renderSideBySide();
    });
    this.selectB.addEventListener('change', () => {
      this.cityB = this.selectB.value;
      this.renderSideBySide();
    });
    this.sortSelect.addEventListener('change', () => {
      this.sortKey = this.sortSelect.value as SortKey;
      this.renderTable();
    });
  }

  public init(manifest: SummaryManifest): void {
    this.manifest = manifest;
    const cities = Object.values(manifest.cities);
    if (cities.length === 0) return;

    this.populateSelect(this.selectA, cities);
    this.populateSelect(this.selectB, cities);

    this.cityA = cities[0].id;
    this.cityB = cities[Math.min(1, cities.length - 1)].id;

    // Region filter pills
    const present = new Set(cities.map((c) => continentOf(c)));
    const regions = ['All', ...CONTINENTS.filter((c) => present.has(c))];
    this.regionFilters.innerHTML = '';
    for (const r of regions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `region-pill${r === this.activeRegion ? ' active' : ''}`;
      btn.textContent = r;
      btn.addEventListener('click', () => {
        this.activeRegion = r;
        this.regionFilters.querySelectorAll('.region-pill').forEach((el) => {
          el.classList.toggle('active', el.textContent === r);
        });
        this.renderTable();
      });
      this.regionFilters.appendChild(btn);
    }
  }

  private populateSelect(sel: HTMLSelectElement, cities: CitySummary[]): void {
    fillCitySelect(sel, cities);
  }

  public open(state: AppState): void {
    this.state = state;
    if (this.manifest) {
      this.cityA = state.cityId;
      const ids = Object.keys(this.manifest.cities);
      if (!this.cityB || this.cityB === this.cityA) {
        this.cityB = ids.find((id) => id !== this.cityA) ?? this.cityA;
      }
      this.selectA.value = this.cityA;
      this.selectB.value = this.cityB;
    }
    this.backdrop.classList.remove('hidden');
    this.render();
  }

  public close(): void {
    this.backdrop.classList.add('hidden');
  }

  public syncState(state: AppState): void {
    this.state = state;
    if (!this.backdrop.classList.contains('hidden')) {
      this.render();
    }
  }

  private render(): void {
    if (!this.manifest || !this.state) return;
    const modeNames = MODES.filter((m) => this.state!.enabledModes.has(m.code)).map((m) => m.shortLabel);
    const modesText = modeNames.length === MODES.length
      ? 'All transit modes'
      : modeNames.length === 0
        ? 'No modes selected'
        : modeNames.join(' · ');

    this.subtitleEl.textContent = `Within ${formatDistance(this.state.distanceM, this.state.unit)} walk · ${modesText}`;
    this.renderSideBySide();
    renderScatter(
      document.getElementById('scatter-chart')!,
      document.getElementById('scatter-caption')!,
      this.manifest,
      this.state,
      (cid) => {
        this.onSelectCity(cid);
        this.close();
      }
    );
    this.renderTable();
  }

  private renderSideBySide(): void {
    if (!this.manifest || !this.state) return;
    const cA = this.manifest.cities[this.cityA];
    const cB = this.manifest.cities[this.cityB];
    const pair = [cA, cB].filter((c): c is CitySummary => Boolean(c));

    this.sbsCards.innerHTML = '';
    for (const city of pair) {
      const stats = computeCityCoverage(
        city,
        this.state.enabledModes,
        this.state.distanceM,
        this.manifest.bucket_step_m
      );
      const card = document.createElement('div');
      card.className = 'sbs-card';

      const modeBadges = MODES.filter((m) => (city.station_counts[m.code] || 0) > 0)
        .map((m) => {
          const active = this.state!.enabledModes.has(m.code);
          return `<span class="sbs-badge${active ? '' : ' muted'}"><span class="mode-dot" style="background:${m.color}"></span>${m.shortLabel} ${city.station_counts[m.code]}</span>`;
        })
        .join('');

      card.innerHTML = `
        <div class="sbs-card-top">
          <div>
            <h4>${city.name}</h4>
            <span class="sbs-country">${city.country}</span>
          </div>
          <button class="text-btn jump-btn" type="button">View map →</button>
        </div>
        <div class="sbs-metrics">
          <div class="sbs-metric">
            <div class="sbs-metric-row"><span>Population</span><strong>${stats.popPct.toFixed(1)}%</strong></div>
            <div class="kpi-bar"><div class="kpi-bar-fill pop-fill" style="width:${Math.min(100, stats.popPct)}%"></div></div>
            <div class="sbs-sub">${formatCompactPop(stats.coveredPop)} of ${formatCompactPop(stats.totalPop)}</div>
          </div>
          <div class="sbs-metric">
            <div class="sbs-metric-row"><span>Area</span><strong>${stats.areaPct.toFixed(1)}%</strong></div>
            <div class="kpi-bar"><div class="kpi-bar-fill area-fill" style="width:${Math.min(100, stats.areaPct)}%"></div></div>
            <div class="sbs-sub">${formatArea(stats.coveredAreaKm2, this.state.unit)} of ${formatArea(stats.totalAreaKm2, this.state.unit)}</div>
          </div>
        </div>
        <div class="sbs-badges">${modeBadges || '<span class="sbs-sub">No transit stations</span>'}</div>
        <div class="sbs-boundary">${city.boundary_desc}</div>
      `;

      card.querySelector('.jump-btn')?.addEventListener('click', () => {
        this.onSelectCity(city.id);
        this.close();
      });

      this.sbsCards.appendChild(card);
    }
  }

  private renderTable(): void {
    if (!this.manifest || !this.state) return;

    const rows: RowData[] = Object.values(this.manifest.cities)
      .filter((c) => this.activeRegion === 'All' || continentOf(c) === this.activeRegion)
      .map((city) => ({
        city,
        stats: computeCityCoverage(
          city,
          this.state!.enabledModes,
          this.state!.distanceM,
          this.manifest!.bucket_step_m
        ),
        closeIn: closeInShare(city, this.state!.enabledModes, this.manifest!.bucket_step_m),
      }));

    rows.sort((a, b) => {
      switch (this.sortKey) {
        case 'popPct':
          return b.stats.popPct - a.stats.popPct;
        case 'areaPct':
          return b.stats.areaPct - a.stats.areaPct;
        case 'coveredPop':
          return b.stats.coveredPop - a.stats.coveredPop;
        case 'closeIn':
          return (b.closeIn ?? -1) - (a.closeIn ?? -1);
        case 'stations':
          return b.stats.activeStations - a.stats.activeStations;
        case 'name':
          return a.city.name.localeCompare(b.city.name);
      }
    });

    this.tbody.innerHTML = '';
    rows.forEach((row, idx) => {
      const tr = document.createElement('tr');
      if (row.city.id === this.state!.cityId) tr.className = 'active-row';

      tr.innerHTML = `
        <td class="rank-col">${idx + 1}</td>
        <td class="city-col">
          <div class="city-name">${row.city.name}</div>
          <div class="city-meta">${row.city.country} · ${formatCompactPop(row.stats.totalPop)}</div>
        </td>
        <td class="bar-col">
          <div class="cell-pct">${row.stats.popPct.toFixed(1)}%</div>
          <div class="mini-bar"><div class="mini-bar-fill pop-fill" style="width:${Math.min(100, row.stats.popPct)}%"></div></div>
        </td>
        <td class="bar-col">
          <div class="cell-pct">${row.stats.areaPct.toFixed(1)}%</div>
          <div class="mini-bar"><div class="mini-bar-fill area-fill" style="width:${Math.min(100, row.stats.areaPct)}%"></div></div>
        </td>
        <td class="num-col">${row.closeIn === null ? '—' : row.closeIn.toFixed(0) + '%'}</td>
        <td class="num-col">${row.stats.activeStations}</td>
      `;

      tr.addEventListener('click', () => {
        this.onSelectCity(row.city.id);
        this.close();
      });
      this.tbody.appendChild(tr);
    });
  }
}
