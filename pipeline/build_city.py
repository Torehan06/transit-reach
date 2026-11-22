#!/usr/bin/env python3
"""Main offline data pipeline for Transit Reach.

Usage:
    .venv/bin/python pipeline/build_city.py ankara istanbul new-york
    .venv/bin/python pipeline/build_city.py --all
    .venv/bin/python pipeline/build_city.py --all --skip-existing
    .venv/bin/python pipeline/build_city.py --all --uc-only   # urban-centre stats only

Urban centres: pipeline/ucdb_cities.json maps each city to the GHS-UCDB R2024A
urban centre (EC JRC, CC BY 4.0) containing it. After the city itself is built,
a second, stats-only pass computes coverage curves over that urban centre so
cities can be compared on one definition of "the city". Several cities can share
one urban centre (Tokyo/Yokohama/Kawasaki); it is computed once, for the most
populous of them, and the others point to it. Results go to summary_uc.json,
which the site loads only when the urban-area view is switched on.
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
SUMMARY_UC_PATH = PUBLIC_DATA / "summary_uc.json"
SUMMARY_NRES_PATH = PUBLIC_DATA / "summary_nres.json"
UCDB_CITIES = Path(__file__).resolve().parent / "ucdb_cities.json"
UC_PAD_DEG = 0.06  # > 3.5 km street/station buffer around the urban centre

MAX_SITE_BYTES = 1024 * 1024 * 1024  # 1 GB GitHub Pages limit


def load_cities_config() -> List[Dict[str, Any]]:
    with open(CITIES_CONFIG, "r", encoding="utf-8") as f:
        return json.load(f)


def load_ucdb() -> Dict[str, Any]:
    if UCDB_CITIES.exists():
        with open(UCDB_CITIES, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def load_summary() -> Dict[str, Any]:
    if SUMMARY_PATH.exists():
        with open(SUMMARY_PATH, "r", encoding="utf-8") as f:
            summary = json.load(f)
        if SUMMARY_UC_PATH.exists():
            with open(SUMMARY_UC_PATH, "r", encoding="utf-8") as f:
                uc = json.load(f).get("cities", {})
            for cid, val in uc.items():
                if cid in summary["cities"]:
                    summary["cities"][cid]["uc"] = val
        if SUMMARY_NRES_PATH.exists():
            with open(SUMMARY_NRES_PATH, "r", encoding="utf-8") as f:
                nres = json.load(f).get("cities", {})
            for cid, val in nres.items():
                if cid in summary["cities"]:
                    summary["cities"][cid]["nres"] = val
        return summary
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
    summary["bucket_step_m"] = BUCKET_STEP_M
    summary["max_bucket_m"] = MAX_BUCKET_M
    summary["cities"] = ordered_cities

    # Urban-centre stats live in their own file so the default page load stays small.
    main = dict(summary)
    main["cities"] = {cid: {k: v for k, v in val.items() if k not in ("uc", "nres")} for cid, val in ordered_cities.items()}
    uc = {cid: val["uc"] for cid, val in ordered_cities.items() if val.get("uc")}
    nres = {cid: val["nres"] for cid, val in ordered_cities.items() if val.get("nres")}
    main["has_nres"] = len(nres) >= 0.9 * max(1, len(ordered_cities))
    # Only advertise the urban-area view once (nearly) every city has it.
    main["has_uc"] = len(uc) >= 0.9 * max(1, len(ordered_cities))
    for path, payload in (
        (SUMMARY_PATH, main),
        (SUMMARY_UC_PATH, {"source": "GHS-UCDB R2024A (EC JRC, CC BY 4.0)", "cities": uc}),
        (SUMMARY_NRES_PATH, {"source": "GHS-BUILT-S NRES R2023A, 2025 epoch (EC JRC, CC BY 4.0)", "cities": nres}),
    ):
        tmp_path = path.with_suffix(".json.tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
        tmp_path.rename(path)


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

        # Report 1-mile (1609m -> 1600m bucket) all-modes coverage
        all_mask = str(pop_res.available_modes_mask)
        idx_1mi = 1600 // BUCKET_STEP_M
        if all_mask in pop_res.pop_curves:
            pop_1mi = pop_res.pop_curves[all_mask][idx_1mi]
            area_1mi = pop_res.area_curves[all_mask][idx_1mi]
            pop_pct_1mi = (pop_1mi / pop_res.total_pop * 100.0) if pop_res.total_pop > 0 else 0.0
            area_pct_1mi = (area_1mi / pop_res.total_land_cells * 100.0) if pop_res.total_land_cells > 0 else 0.0
            print(f"  [1-mile all modes] Population: {pop_pct_1mi:.1f}% | Area: {area_pct_1mi:.1f}%")

        minx, miny, maxx, maxy = osm_data.boundary_wgs84.bounds
        centroid = osm_data.boundary_wgs84.centroid

        entry: Dict[str, Any] = {
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
        if city.get("data_warning"):
            entry["data_warning"] = city["data_warning"]
        print(f"  Done in {time.time() - t0:.1f}s")
        return entry
    finally:
        # Always remove temporary GeoJSONSeq files to keep disk usage low
        if city_tmp.exists():
            shutil.rmtree(city_tmp, ignore_errors=True)


def uc_primary(cid: str, ucdb: Dict[str, Any], by_id: Dict[str, Dict[str, Any]]) -> str:
    """The city that carries the stats for a shared urban centre: the most populous one."""
    uid = ucdb[cid]["uc_id"]
    sharers = [k for k, v in ucdb.items() if v and v["uc_id"] == uid and k in by_id]
    return max(sharers, key=lambda k: (by_id[k]["official_pop"], k))


def build_uc_stats(city: Dict[str, Any], uc: Dict[str, Any]) -> Dict[str, Any]:
    """Stats-only pass over the city's GHS-UCDB urban centre (no tiles, no dots)."""
    from shapely.geometry import shape
    from shapely.prepared import prep

    t0 = time.time()
    geom = shape(uc["geom"])
    minx, miny, maxx, maxy = geom.bounds
    ucity = dict(city)
    ucity["id"] = f"{city['id']}__uc"
    ucity["bbox"] = [
        round(min(minx - UC_PAD_DEG, city["bbox"][0]), 4),
        round(min(miny - UC_PAD_DEG, city["bbox"][1]), 4),
        round(max(maxx + UC_PAD_DEG, city["bbox"][2]), 4),
        round(max(maxy + UC_PAD_DEG, city["bbox"][3]), 4),
    ]
    ucity["boundary"] = {"geojson": uc["geom"]}
    if city.get("uc_pbf"):
        # A larger extract when the city's own one does not cover the whole urban centre.
        ucity["pbf"] = city["uc_pbf"]
    print(f"  [UC] {uc['uc_name']} ({uc['uc_km2']:.0f} km², UCDB pop {uc['uc_pop']:,})")
    osm_data = extract_city_osm(ucity, CACHE_DIR)
    routing = compute_walking_distances(
        node_xy=osm_data.node_xy,
        edge_u=osm_data.edge_u,
        edge_v=osm_data.edge_v,
        edge_len=osm_data.edge_len,
        stations=osm_data.stations,
    )
    pop_res = process_population(
        boundary_wgs84=osm_data.boundary_wgs84,
        utm_crs=osm_data.utm_crs,
        routing=routing,
        cache_dir=CACHE_DIR / "ghsl",
        dots_geojsonseq_path=None,
    )
    pg = prep(geom)
    from shapely.geometry import Point
    counts = {m: 0 for m in MODES}
    for st in osm_data.stations:
        if pg.contains(Point(st.lon, st.lat)):
            counts[st.mode] += 1
    all_mask = str(pop_res.available_modes_mask)
    pct = 0.0
    if all_mask in pop_res.pop_curves and pop_res.total_pop > 0:
        pct = pop_res.pop_curves[all_mask][1600 // BUCKET_STEP_M] / pop_res.total_pop * 100
    print(
        f"  [UC] pop {pop_res.total_pop:,.0f}, {sum(counts.values())} stations, 1-mile {pct:.1f}%, "
        f"street coverage {pop_res.snapped_pop_share * 100:.1f}% ({time.time() - t0:.1f}s)"
    )
    return {
        "uc_id": uc["uc_id"],
        "name": uc["uc_name"],
        "ghsl_pop": int(round(pop_res.total_pop)),
        "area_km2": pop_res.area_km2,
        "land_cells": pop_res.total_land_cells,
        "station_counts": counts,
        "available_modes_mask": pop_res.available_modes_mask,
        "pop_curves": pop_res.pop_curves,
        "area_curves": pop_res.area_curves,
        "street_share": round(pop_res.snapped_pop_share, 4),
        "geom": uc["geom"],
    }


def add_uc(entry: Dict[str, Any], city: Dict[str, Any], ucdb: Dict[str, Any], by_id: Dict[str, Dict[str, Any]]) -> None:
    """Attach urban-centre stats (or a pointer to the city that carries them) to a summary entry."""
    uc = ucdb.get(city["id"])
    if not uc:
        entry.pop("uc", None)
        return
    primary = uc_primary(city["id"], ucdb, by_id)
    if primary != city["id"]:
        entry["uc"] = {"uc_id": uc["uc_id"], "name": uc["uc_name"], "same_as": primary}
        print(f"  [UC] shares {uc['uc_name']} with {primary}")
        return
    try:
        entry["uc"] = build_uc_stats(city, uc)
    except Exception as exc:  # never lose the city build over the urban-centre pass
        print(f"  [UC][ERROR] {city['id']}: {exc}", file=sys.stderr)
    finally:
        shutil.rmtree(TMP_DIR / f"{city['id']}__uc", ignore_errors=True)
        (CACHE_DIR / "pbf" / f"city_{city['id']}__uc.osm.pbf").unlink(missing_ok=True)
        if city.get("uc_pbf", {}).get("path"):
            (CACHE_DIR / "pbf" / Path(city["uc_pbf"]["path"]).name).unlink(missing_ok=True)


def build_nres_stats(city: Dict[str, Any], ucdb: Dict[str, Any], by_id: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Stats-only pass: non-residential built-up surface within walking distance,
    for the city limits and (for the city that carries it) its urban centre.
    One street graph over city limits ∪ urban centre serves both."""
    from shapely.geometry import mapping, shape
    from shapely.ops import unary_union

    from nres import process_nres
    from osm_extract import ensure_city_pbf, extract_boundary

    t0 = time.time()
    cid = city["id"]
    admin_pbf = ensure_city_pbf(city, CACHE_DIR)
    admin, _, _ = extract_boundary(admin_pbf, city)
    uc = ucdb.get(cid)
    uc_geom = None
    uc_pointer = None
    if uc:
        primary = uc_primary(cid, ucdb, by_id)
        if primary == cid:
            uc_geom = shape(uc["geom"])
        else:
            uc_pointer = {"same_as": primary}
    area = unary_union([admin, uc_geom]) if uc_geom is not None else admin
    minx, miny, maxx, maxy = area.bounds
    ncity = dict(city)
    ncity["id"] = f"{cid}__nres"
    ncity["bbox"] = [
        round(min(minx - UC_PAD_DEG, city["bbox"][0]), 4),
        round(min(miny - UC_PAD_DEG, city["bbox"][1]), 4),
        round(max(maxx + UC_PAD_DEG, city["bbox"][2]), 4),
        round(max(maxy + UC_PAD_DEG, city["bbox"][3]), 4),
    ]
    ncity["boundary"] = {"geojson": mapping(area)}
    if uc_geom is not None and city.get("uc_pbf"):
        ncity["pbf"] = city["uc_pbf"]
    osm_data = extract_city_osm(ncity, CACHE_DIR)
    routing = compute_walking_distances(
        node_xy=osm_data.node_xy,
        edge_u=osm_data.edge_u,
        edge_v=osm_data.edge_v,
        edge_len=osm_data.edge_len,
        stations=osm_data.stations,
    )
    out: Dict[str, Any] = {"city": process_nres(admin, osm_data.utm_crs, routing, CACHE_DIR / "ghsl")}
    if uc_geom is not None:
        out["uc"] = process_nres(uc_geom, osm_data.utm_crs, routing, CACHE_DIR / "ghsl")
    elif uc_pointer:
        out["uc"] = uc_pointer

    def pct(r: Dict[str, Any]) -> float:
        c = r.get("curves", {}).get(str(r.get("available_modes_mask")))
        return c[805 // BUCKET_STEP_M] / r["total_m2"] * 100 if c and r.get("total_m2") else 0.0

    msg = f"  [NRES] city {out['city']['total_m2'] / 1e6:.1f} km² non-res, {pct(out['city']):.1f}% within 0.8 km"
    if uc_geom is not None:
        msg += f"; urban centre {out['uc']['total_m2'] / 1e6:.1f} km², {pct(out['uc']):.1f}%"
    print(msg + f" ({time.time() - t0:.1f}s)")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Transit Reach city data & PMTiles.")
    parser.add_argument("cities", nargs="*", help="City IDs to build")
    parser.add_argument("--all", action="store_true", help="Build all configured cities")
    parser.add_argument("--skip-existing", action="store_true", help="Skip cities with existing PMTiles & summary")
    parser.add_argument("--cleanup", action="store_true", help="Delete cached city PBFs after building to save disk space")
    parser.add_argument("--continue-on-error", action="store_true", help="Keep building remaining cities if one fails")
    parser.add_argument("--uc-only", action="store_true", help="Only (re)compute urban-centre stats for already-built cities")
    parser.add_argument("--no-uc", action="store_true", help="Skip the urban-centre pass")
    parser.add_argument("--nres-only", action="store_true", help="Only (re)compute non-residential built-up stats for built cities")
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
    ucdb = load_ucdb()
    failures: List[str] = []

    for idx, city in enumerate(targets):
        cid = city["id"]
        if not (args.uc_only or args.nres_only) and args.skip_existing and (TILES_DIR / f"{cid}.pmtiles").exists() and cid in summary["cities"]:
            print(f"Skipping {cid} (already built)")
            continue
        try:
            if args.nres_only:
                if cid not in summary["cities"]:
                    print(f"Skipping {cid} (not built yet)")
                    continue
                if args.skip_existing and summary["cities"][cid].get("nres"):
                    print(f"Skipping {cid} (non-residential done)")
                    continue
                print(f"\n=== {city['name']} ({cid}) non-residential ===")
                entry = summary["cities"][cid]
                try:
                    entry["nres"] = build_nres_stats(city, ucdb, by_id)
                except Exception as exc:
                    print(f"  [NRES][ERROR] {cid}: {exc}", file=sys.stderr)
                finally:
                    shutil.rmtree(TMP_DIR / f"{cid}__nres", ignore_errors=True)
                    (CACHE_DIR / "pbf" / f"city_{cid}__nres.osm.pbf").unlink(missing_ok=True)
                    if city.get("uc_pbf", {}).get("path"):
                        (CACHE_DIR / "pbf" / Path(city["uc_pbf"]["path"]).name).unlink(missing_ok=True)
                summary["cities"][cid] = entry
                save_summary(summary, ordered_ids)
                if args.cleanup:
                    pbf_cfg = city["pbf"]
                    if pbf_cfg["source"] == "bbbike":
                        (CACHE_DIR / "pbf" / f"{pbf_cfg['name']}.osm.pbf").unlink(missing_ok=True)
                    else:
                        (CACHE_DIR / "pbf" / f"city_{cid}.osm.pbf").unlink(missing_ok=True)
                        raw_name = Path(pbf_cfg["path"]).name
                        if not any(
                            c["pbf"].get("source") == "geofabrik" and Path(c["pbf"]["path"]).name == raw_name
                            for c in targets[idx + 1 :]
                        ):
                            (CACHE_DIR / "pbf" / raw_name).unlink(missing_ok=True)
                continue
            if args.uc_only:
                if cid not in summary["cities"]:
                    print(f"Skipping {cid} (not built yet)")
                    continue
                if args.skip_existing and summary["cities"][cid].get("uc"):
                    print(f"Skipping {cid} (urban centre done)")
                    continue
                print(f"\n=== {city['name']} ({cid}) urban centre ===")
                entry = summary["cities"][cid]
            else:
                entry = build_one_city(city)
            if not args.no_uc:
                add_uc(entry, city, ucdb, by_id)
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
