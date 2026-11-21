#!/usr/bin/env python3
"""Main offline data pipeline for Transit Reach.

Usage:
    .venv/bin/python pipeline/build_city.py ankara istanbul new-york
    .venv/bin/python pipeline/build_city.py --all
    .venv/bin/python pipeline/build_city.py --all --skip-existing
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

# Allow importing sibling modules when invoked from repo root
sys.path.insert(0, str(Path(__file__).resolve().parent))

from osm_extract import extract_city_osm
from population import BUCKET_STEP_M, MAX_BUCKET_M, process_population
from routing import MODES, compute_walking_distances
from tiles import build_pmtiles, write_boundary_geojsonseq, write_streets_geojsonseq

ROOT_DIR = Path(__file__).resolve().parent.parent
CITIES_CONFIG = ROOT_DIR / "cities.json"
CACHE_DIR = ROOT_DIR / "cache"
TMP_DIR = ROOT_DIR / "tmp"
PUBLIC_DATA = ROOT_DIR / "public" / "data"
TILES_DIR = PUBLIC_DATA / "tiles"
STATIONS_DIR = PUBLIC_DATA / "stations"
SUMMARY_PATH = PUBLIC_DATA / "summary.json"

MAX_SITE_BYTES = 1024 * 1024 * 1024  # 1 GB GitHub Pages limit


def load_cities_config() -> List[Dict[str, Any]]:
    with open(CITIES_CONFIG, "r", encoding="utf-8") as f:
        return json.load(f)


def load_summary() -> Dict[str, Any]:
    if SUMMARY_PATH.exists():
        with open(SUMMARY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "bucket_step_m": BUCKET_STEP_M,
        "max_bucket_m": MAX_BUCKET_M,
        "modes": list(MODES),
        "cities": {},
    }


def save_summary(summary: Dict[str, Any], ordered_ids: List[str]) -> None:
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    # Keep cities ordered consistently with cities.json
    ordered_cities: Dict[str, Any] = {}
    for cid in ordered_ids:
        if cid in summary["cities"]:
            ordered_cities[cid] = summary["cities"][cid]
    for cid, val in summary["cities"].items():
        if cid not in ordered_cities:
            ordered_cities[cid] = val
    summary["cities"] = ordered_cities

    tmp_path = SUMMARY_PATH.with_suffix(".json.tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, separators=(",", ":"), ensure_ascii=False)
    tmp_path.rename(SUMMARY_PATH)


def total_data_size_bytes() -> int:
    if not PUBLIC_DATA.exists():
        return 0
    return sum(p.stat().st_size for p in PUBLIC_DATA.rglob("*") if p.is_file())


def build_one_city(city: Dict[str, Any]) -> Dict[str, Any]:
    cid = city["id"]
    t0 = time.time()
    print(f"\n{'=' * 64}")
    print(f"Building {city['name']} ({cid}) — {city['country']}")
    print(f"{'=' * 64}")

    city_tmp = TMP_DIR / cid
    if city_tmp.exists():
        shutil.rmtree(city_tmp)
    city_tmp.mkdir(parents=True, exist_ok=True)

    try:
        # 1. Extract boundary, transit stations, and walkable street graph from OSM PBF
        t1 = time.time()
        osm_data = extract_city_osm(city, CACHE_DIR)
        print(
            f"  [OSM] {len(osm_data.node_xy):,} street nodes, {len(osm_data.edge_u):,} edges, "
            f"{len(osm_data.stations):,} merged stations ({time.time() - t1:.1f}s)"
        )

        # Print per-mode station breakdown (inside boundary vs buffer)
        counts_inside: Dict[str, int] = {}
        counts_total: Dict[str, int] = {}
        for m in MODES:
            m_all = [s for s in osm_data.stations if s.mode == m]
            m_in = [s for s in m_all if s.inside_boundary]
            counts_inside[m] = len(m_in)
            counts_total[m] = len(m_all)
            if m_all:
                sample = ", ".join(s.name for s in m_in[:6])
                print(f"    mode={m}: {len(m_in)} inside ({len(m_all)} w/ buffer) — e.g. {sample}")

        # 2. Multi-source walking distance routing per mode
        t2 = time.time()
        routing = compute_walking_distances(
            node_xy=osm_data.node_xy,
            edge_u=osm_data.edge_u,
            edge_v=osm_data.edge_v,
            edge_len=osm_data.edge_len,
            stations=osm_data.stations,
        )
        print(f"  [Routing] Dijkstra finished across active modes ({time.time() - t2:.1f}s)")

        # 3. GHSL GHS-POP 2025 population, coverage curves, and tiered dots
        t3 = time.time()
        dots_path = city_tmp / "dots.geojsonseq"
        pop_res = process_population(
            boundary_wgs84=osm_data.boundary_wgs84,
            utm_crs=osm_data.utm_crs,
            routing=routing,
            cache_dir=CACHE_DIR / "ghsl",
            dots_geojsonseq_path=dots_path,
        )
        official_pop = city["official_pop"]
        pop_diff_pct = ((pop_res.total_pop - official_pop) / official_pop) * 100.0
        pop_flag = "OK" if abs(pop_diff_pct) <= 15.0 else "WARN (>15%)"
        print(
            f"  [GHSL] Pop: {pop_res.total_pop:,.0f} vs official {official_pop:,.0f} "
            f"({pop_diff_pct:+.1f}% {pop_flag}), Area: {pop_res.area_km2:.1f} km², "
            f"Dots: {pop_res.dot_count:,} ({time.time() - t3:.1f}s)"
        )

        # 4. Write boundary & segmented streets GeoJSONSeq -> PMTiles
        t4 = time.time()
        boundary_path = city_tmp / "boundary.geojsonseq"
        streets_path = city_tmp / "streets.geojsonseq"
        write_boundary_geojsonseq(osm_data.boundary_wgs84, boundary_path)
        n_street_feats = write_streets_geojsonseq(
            ways=osm_data.ways,
            node_xy=osm_data.node_xy,
            node_lonlat=osm_data.node_lonlat,
            boundary_utm=osm_data.boundary_utm,
            routing=routing,
            out_path=streets_path,
        )
        print(f"  [Streets] Wrote {n_street_feats:,} street segments ({time.time() - t4:.1f}s)")

        pmtiles_path = TILES_DIR / f"{cid}.pmtiles"
        size_bytes = build_pmtiles(boundary_path, streets_path, dots_path, pmtiles_path)
        print(f"  [PMTiles] {pmtiles_path.name}: {size_bytes / (1024 * 1024):.2f} MB")

        # 5. Write compact stations JSON for click-to-inspect and map markers
        # Format per station: [id, mode, name, lon, lat, inside(1|0)]
        STATIONS_DIR.mkdir(parents=True, exist_ok=True)
        stations_payload = [
            [s.station_id, s.mode, s.name, s.lon, s.lat, 1 if s.inside_boundary else 0]
            for s in osm_data.stations
        ]
        with open(STATIONS_DIR / f"{cid}.json", "w", encoding="utf-8") as f:
            json.dump(stations_payload, f, separators=(",", ":"), ensure_ascii=False)

        # Report 1-mile (1609m -> bucket 32 = 1600m) all-modes coverage
        all_mask = str(pop_res.available_modes_mask)
        if all_mask in pop_res.pop_curves:
            pop_1mi = pop_res.pop_curves[all_mask][32]
            area_1mi = pop_res.area_curves[all_mask][32]
            pop_pct_1mi = (pop_1mi / pop_res.total_pop * 100.0) if pop_res.total_pop > 0 else 0.0
            area_pct_1mi = (area_1mi / pop_res.total_land_cells * 100.0) if pop_res.total_land_cells > 0 else 0.0
            print(f"  [1-mile all modes] Population: {pop_pct_1mi:.1f}% | Area: {area_pct_1mi:.1f}%")

        minx, miny, maxx, maxy = osm_data.boundary_wgs84.bounds
        centroid = osm_data.boundary_wgs84.centroid

        entry = {
            "id": cid,
            "name": city["name"],
            "country": city["country"],
            "region": city["region"],
            "boundary_desc": city["boundary_desc"],
            "official_pop": official_pop,
            "ghsl_pop": int(round(pop_res.total_pop)),
            "area_km2": pop_res.area_km2,
            "land_cells": pop_res.total_land_cells,
            "bounds": [round(minx, 5), round(miny, 5), round(maxx, 5), round(maxy, 5)],
            "center": [round(centroid.x, 5), round(centroid.y, 5)],
            "station_counts": counts_inside,
            "available_modes_mask": pop_res.available_modes_mask,
            "pop_curves": pop_res.pop_curves,
            "area_curves": pop_res.area_curves,
            "pmtiles_mb": round(size_bytes / (1024 * 1024), 2),
        }
        print(f"  Done in {time.time() - t0:.1f}s")
        return entry
    finally:
        # Always remove temporary GeoJSONSeq files to keep disk usage low
        if city_tmp.exists():
            shutil.rmtree(city_tmp, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Transit Reach city data & PMTiles.")
    parser.add_argument("cities", nargs="*", help="City IDs to build")
    parser.add_argument("--all", action="store_true", help="Build all configured cities")
    parser.add_argument("--skip-existing", action="store_true", help="Skip cities with existing PMTiles & summary")
    parser.add_argument("--cleanup", action="store_true", help="Delete cached city PBFs after building to save disk space")
    parser.add_argument("--continue-on-error", action="store_true", help="Keep building remaining cities if one fails")
    args = parser.parse_args()

    all_cities = load_cities_config()
    by_id = {c["id"]: c for c in all_cities}
    ordered_ids = [c["id"] for c in all_cities]

    if args.all:
        targets = all_cities
    elif args.cities:
        missing = [cid for cid in args.cities if cid not in by_id]
        if missing:
            print(f"Unknown city IDs: {missing}", file=sys.stderr)
            sys.exit(1)
        targets = [by_id[cid] for cid in args.cities]
    else:
        parser.print_help()
        sys.exit(1)

    summary = load_summary()
    failures: List[str] = []

    for idx, city in enumerate(targets):
        cid = city["id"]
        if args.skip_existing and (TILES_DIR / f"{cid}.pmtiles").exists() and cid in summary["cities"]:
            print(f"Skipping {cid} (already built)")
            continue
        try:
            entry = build_one_city(city)
            summary["cities"][cid] = entry
            save_summary(summary, ordered_ids)
        except Exception as exc:
            if not args.continue_on_error:
                raise
            print(f"  [ERROR] {cid} failed: {exc}", file=sys.stderr)
            failures.append(f"{cid}: {exc}")
            continue

        if args.cleanup:
            pbf_cfg = city["pbf"]
            if pbf_cfg["source"] == "bbbike":
                (CACHE_DIR / "pbf" / f"{pbf_cfg['name']}.osm.pbf").unlink(missing_ok=True)
            elif pbf_cfg["source"] == "geofabrik":
                (CACHE_DIR / "pbf" / f"city_{cid}.osm.pbf").unlink(missing_ok=True)
                raw_name = Path(pbf_cfg["path"]).name
                still_needed = any(
                    c["pbf"].get("source") == "geofabrik" and Path(c["pbf"]["path"]).name == raw_name
                    for c in targets[idx + 1 :]
                )
                if not still_needed:
                    (CACHE_DIR / "pbf" / raw_name).unlink(missing_ok=True)

        total_bytes = total_data_size_bytes()
        print(f"  [Total public/data] {total_bytes / (1024 * 1024):.1f} MB / 1024 MB limit")
        if total_bytes > MAX_SITE_BYTES:
            raise RuntimeError(
                f"Total site data ({total_bytes / (1024 * 1024):.1f} MB) exceeds 1 GB GitHub Pages limit!"
            )

    if failures:
        print("\n=== FAILED CITIES ===", file=sys.stderr)
        for msg in failures:
            print("  -", msg, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
