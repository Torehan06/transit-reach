"""GHSL GHS-POP 2025 loading, coverage curve computation, and tiered dot-density generation."""

from __future__ import annotations

import io
import json
import math
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

import numpy as np
import pyproj
import rasterio
from rasterio.features import geometry_mask
from rasterio.io import MemoryFile
from rasterio.windows import from_bounds
import requests
from shapely.geometry import Point, mapping
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform as shapely_transform
from shapely.prepared import prep

from routing import MODES, RoutingResult

GHSL_URL_TEMPLATE = (
    "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/"
    "GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_54009_100/V1-0/tiles/"
    "GHS_POP_E2025_GLOBE_R2023A_54009_100_V1_0_R{row}_C{col}.zip"
)

MOLLWEIDE_CRS = "ESRI:54009"
TILE_SIZE_M = 1_000_000.0
ORIGIN_X = -18_041_000.0
ORIGIN_Y = 9_000_000.0

BUCKET_STEP_M = 50
MAX_BUCKET_M = 3250
N_BUCKETS = (MAX_BUCKET_M // BUCKET_STEP_M) + 1  # 66 buckets: 0, 50, ..., 3250m
BASE_PPD = 25.0  # 1 dot = 25 people at z14+
DOT_MAX_DIST_M = 3300  # Slightly above 2 miles (3218.69m)

MODE_BITS = {m: 1 << i for i, m in enumerate(MODES)}


@dataclass
class PopulationResult:
    total_pop: float
    total_land_cells: int       # 100m x 100m cells (1 cell = 0.01 km^2)
    area_km2: float
    available_modes_mask: int
    pop_curves: Dict[str, List[int]]   # mask_str -> 66 cumulative ints
    area_curves: Dict[str, List[int]]  # mask_str -> 66 cumulative land cells (hectares)
    dot_count: int


def _ghsl_tiles_for_bounds(minx: float, miny: float, maxx: float, maxy: float) -> List[Tuple[int, int]]:
    c_min = math.floor((minx - ORIGIN_X) / TILE_SIZE_M) + 1
    c_max = math.floor((maxx - ORIGIN_X) / TILE_SIZE_M) + 1
    r_min = math.floor((ORIGIN_Y - maxy) / TILE_SIZE_M) + 1
    r_max = math.floor((ORIGIN_Y - miny) / TILE_SIZE_M) + 1
    tiles = []
    for r in range(r_min, r_max + 1):
        for c in range(c_min, c_max + 1):
            tiles.append((r, c))
    return tiles


def _ensure_ghsl_tile(row: int, col: int, cache_dir: Path) -> Optional[Path]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    zip_path = cache_dir / f"GHS_POP_E2025_R{row}_C{col}.zip"
    if zip_path.exists() and zip_path.stat().st_size > 1000:
        return zip_path

    url = GHSL_URL_TEMPLATE.format(row=row, col=col)
    print(f"  Downloading GHSL tile R{row}_C{col}...")
    resp = requests.get(url, stream=True, timeout=120)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()

    tmp_path = zip_path.with_suffix(".zip.part")
    with open(tmp_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1 << 20):
            if chunk:
                f.write(chunk)
    tmp_path.rename(zip_path)
    return zip_path


def process_population(
    boundary_wgs84: BaseGeometry,
    utm_crs: pyproj.CRS,
    routing: RoutingResult,
    cache_dir: Path,
    dots_geojsonseq_path: Path,
) -> PopulationResult:
    """Load GHSL cells inside city boundary, compute coverage curves, and stream tiered dots."""
    to_moll = pyproj.Transformer.from_crs("EPSG:4326", MOLLWEIDE_CRS, always_xy=True)
    moll_to_utm = pyproj.Transformer.from_crs(MOLLWEIDE_CRS, utm_crs, always_xy=True)
    moll_to_wgs = pyproj.Transformer.from_crs(MOLLWEIDE_CRS, "EPSG:4326", always_xy=True)

    boundary_moll = shapely_transform(to_moll.transform, boundary_wgs84)
    minx, miny, maxx, maxy = boundary_moll.bounds
    tiles = _ghsl_tiles_for_bounds(minx, miny, maxx, maxy)

    # Collect all land cells inside city boundary across intersecting GHSL tiles
    cell_mx_list: List[np.ndarray] = []
    cell_my_list: List[np.ndarray] = []
    cell_pop_list: List[np.ndarray] = []
    cell_seed_list: List[np.ndarray] = []

    for tile_r, tile_c in tiles:
        zip_path = _ensure_ghsl_tile(tile_r, tile_c, cache_dir)
        if zip_path is None:
            continue

        with zipfile.ZipFile(zip_path, "r") as zf:
            tif_names = [n for n in zf.namelist() if n.lower().endswith(".tif")]
            if not tif_names:
                continue
            tif_bytes = zf.read(tif_names[0])

        with MemoryFile(tif_bytes) as mf:
            with mf.open() as ds:
                # Intersect city bounds with tile bounds
                ix0 = max(minx, ds.bounds.left)
                iy0 = max(miny, ds.bounds.bottom)
                ix1 = min(maxx, ds.bounds.right)
                iy1 = min(maxy, ds.bounds.top)
                if ix0 >= ix1 or iy0 >= iy1:
                    continue

                win = from_bounds(ix0, iy0, ix1, iy1, ds.transform)
                win = win.round_offsets().round_lengths()
                if win.width <= 0 or win.height <= 0:
                    continue

                data = ds.read(1, window=win)
                win_transform = ds.window_transform(win)

                # Rasterize boundary onto this cropped window
                outside_mask = geometry_mask(
                    [mapping(boundary_moll)],
                    out_shape=data.shape,
                    transform=win_transform,
                    all_touched=False,
                    invert=False,
                )
                inside = ~outside_mask

                # GHSL nodata is -200 (ocean/open water); valid land cells have data >= 0
                nodata = ds.nodata if ds.nodata is not None else -200.0
                valid_land = inside & (data != nodata) & np.isfinite(data) & (data >= 0.0)
                rr, cc = np.where(valid_land)
                if len(rr) == 0:
                    continue

                # Cell centers in Mollweide meters
                mx = win_transform.c + (cc + 0.5) * win_transform.a
                my = win_transform.f + (rr + 0.5) * win_transform.e
                pops = data[rr, cc].astype(np.float64)

                # Deterministic global cell ID for reproducible random dot jitter
                g_row = (tile_r * 10000) + int(win.row_off) + rr.astype(np.int64)
                g_col = (tile_c * 10000) + int(win.col_off) + cc.astype(np.int64)
                seeds = (g_row * 1_000_003 + g_col).astype(np.int64)

                cell_mx_list.append(mx)
                cell_my_list.append(my)
                cell_pop_list.append(pops)
                cell_seed_list.append(seeds)

    if not cell_mx_list:
        raise RuntimeError("No GHSL cells found inside city boundary!")

    cell_mx = np.concatenate(cell_mx_list)
    cell_my = np.concatenate(cell_my_list)
    cell_pop = np.concatenate(cell_pop_list)
    cell_seed = np.concatenate(cell_seed_list)

    n_cells = len(cell_pop)
    total_pop = float(np.sum(cell_pop))
    area_km2 = n_cells * 0.01  # Each ESRI:54009 100m x 100m cell is exactly 0.01 km^2

    # Snap every cell centroid to nearest walkable street node (in local UTM meters)
    ux, uy = moll_to_utm.transform(cell_mx, cell_my)
    cell_utm_xy = np.column_stack([ux, uy])
    snap_d, kd_idx = routing.valid_kdtree.query(cell_utm_xy, k=1, distance_upper_bound=500.0)
    snapped_ok = np.isfinite(snap_d) & (kd_idx < len(routing.valid_node_indices))
    street_nodes = np.where(snapped_ok, routing.valid_node_indices[np.minimum(kd_idx, len(routing.valid_node_indices) - 1)], -1)

    # Compute per-mode walking distance for every land cell
    cell_dist_by_mode: Dict[str, np.ndarray] = {}
    available_modes: List[str] = []
    available_mask = 0

    for mode in MODES:
        node_d = routing.dist_by_mode.get(mode)
        if node_d is None:
            continue
        cd = np.full(n_cells, np.inf, dtype=np.float32)
        ok_nodes = street_nodes[snapped_ok]
        cd[snapped_ok] = snap_d[snapped_ok].astype(np.float32) + node_d[ok_nodes]
        if np.any(cd <= MAX_BUCKET_M):
            cell_dist_by_mode[mode] = cd
            available_modes.append(mode)
            available_mask |= MODE_BITS[mode]

    # Precompute exact cumulative coverage curves for all non-empty subsets of available_modes
    pop_curves: Dict[str, List[int]] = {}
    area_curves: Dict[str, List[int]] = {}
    n_avail = len(available_modes)

    for subset_idx in range(1, 1 << n_avail):
        mask = 0
        arrays = []
        for bit_i in range(n_avail):
            if subset_idx & (1 << bit_i):
                m = available_modes[bit_i]
                mask |= MODE_BITS[m]
                arrays.append(cell_dist_by_mode[m])

        min_d = arrays[0] if len(arrays) == 1 else np.minimum.reduce(arrays)
        within = min_d <= MAX_BUCKET_M

        pop_hist = np.zeros(N_BUCKETS, dtype=np.float64)
        area_hist = np.zeros(N_BUCKETS, dtype=np.int64)

        if np.any(within):
            buckets = np.ceil(min_d[within] / BUCKET_STEP_M).astype(np.int32)
            buckets = np.clip(buckets, 0, N_BUCKETS - 1)
            np.add.at(pop_hist, buckets, cell_pop[within])
            np.add.at(area_hist, buckets, 1)

        pop_curves[str(mask)] = [int(round(v)) for v in np.cumsum(pop_hist)]
        area_curves[str(mask)] = [int(v) for v in np.cumsum(area_hist)]

    # Generate tiered fixed-position population dots as GeoJSONSeq
    dot_count = _write_tiered_dots(
        cell_mx=cell_mx,
        cell_my=cell_my,
        cell_pop=cell_pop,
        cell_seed=cell_seed,
        cell_dist_by_mode=cell_dist_by_mode,
        available_modes=available_modes,
        boundary_moll=boundary_moll,
        moll_to_wgs=moll_to_wgs,
        out_path=dots_geojsonseq_path,
    )

    return PopulationResult(
        total_pop=total_pop,
        total_land_cells=n_cells,
        area_km2=round(area_km2, 2),
        available_modes_mask=available_mask,
        pop_curves=pop_curves,
        area_curves=area_curves,
        dot_count=dot_count,
    )


def _write_tiered_dots(
    cell_mx: np.ndarray,
    cell_my: np.ndarray,
    cell_pop: np.ndarray,
    cell_seed: np.ndarray,
    cell_dist_by_mode: Dict[str, np.ndarray],
    available_modes: List[str],
    boundary_moll: BaseGeometry,
    moll_to_wgs: pyproj.Transformer,
    out_path: Path,
) -> int:
    """Write deterministic dot-density features with zoom-tiered minzooms.

    Zoom tiers (all lower-zoom dots are a strict subset of higher-zoom dots):
      slot == 0                    -> minzoom 8  (1/20 -> 500 people/dot at z < 11)
      slot in (4, 8, 12, 16)       -> minzoom 11 (5/20 -> 100 people/dot at z 11-12)
      slot in (2, 6, 10, 14, 18)   -> minzoom 13 (10/20 -> 50 people/dot at z 13)
      odd slots                    -> minzoom 14 (20/20 -> 25 people/dot at z >= 14)
    """
    pop_indices = np.where(cell_pop > 0.0)[0]
    if len(pop_indices) == 0:
        out_path.write_text("")
        return 0

    # Deterministic residual carry across populated cells so total dots match population
    residual = 0.0
    counts = np.zeros(len(pop_indices), dtype=np.int32)
    pops_sub = cell_pop[pop_indices]
    for i, p in enumerate(pops_sub):
        residual += float(p)
        n = int(residual // BASE_PPD)
        if n > 0:
            counts[i] = n
            residual -= n * BASE_PPD

    total_dots = int(np.sum(counts))
    if total_dots == 0:
        out_path.write_text("")
        return 0

    # Vectorized jitter generation inside each 100m x 100m Mollweide cell
    dot_mx = np.empty(total_dots, dtype=np.float64)
    dot_my = np.empty(total_dots, dtype=np.float64)
    dot_cell_idx = np.empty(total_dots, dtype=np.int32)

    cursor = 0
    for idx_in_sub, n in enumerate(counts):
        if n == 0:
            continue
        ci = int(pop_indices[idx_in_sub])
        seed = int(cell_seed[ci]) & 0x7FFFFFFF
        rng = np.random.default_rng(seed)
        dx = rng.uniform(-48.0, 48.0, size=n)
        dy = rng.uniform(-48.0, 48.0, size=n)
        dot_mx[cursor : cursor + n] = cell_mx[ci] + dx
        dot_my[cursor : cursor + n] = cell_my[ci] + dy
        dot_cell_idx[cursor : cursor + n] = ci
        cursor += n

    # Batch-transform all dot coordinates to WGS84 in one C call
    dot_lon, dot_lat = moll_to_wgs.transform(dot_mx, dot_my)

    # Precompute 25m-quantized integer distances (or -1 if > DOT_MAX_DIST_M) per available mode
    mode_int_dists: Dict[str, np.ndarray] = {}
    for m in available_modes:
        arr = cell_dist_by_mode[m]
        within = np.isfinite(arr) & (arr <= DOT_MAX_DIST_M)
        safe = np.where(within, arr, 0.0)
        q = (np.rint(safe / 25.0).astype(np.int32)) * 25
        mode_int_dists[m] = np.where(within, q, -1)

    # Tier lookup table for slot = global_dot_idx % 20 (matches z8..z13 tile pyramid)
    #   z < 11 -> 1/20  (500 people/dot)
    #   z = 11 -> 5/20  (100 people/dot)
    #   z = 12 -> 10/20 (50 people/dot)
    #   z >= 13 -> 20/20 (25 people/dot)
    slot_minzoom = [
        8,  # 0  -> 500 ppl/dot
        13, 12, 13, 11,
        13, 12, 13, 11,
        13, 12, 13, 11,
        13, 12, 13, 11,
        13, 12, 13,
    ]

    # Write newline-delimited GeoJSON (GeoJSONSeq) for low-memory streaming into tippecanoe
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for i in range(total_dots):
            ci = int(dot_cell_idx[i])
            props: Dict[str, int] = {}
            for m in available_modes:
                dv = int(mode_int_dists[m][ci])
                if dv >= 0:
                    props[f"d{m}"] = dv

            mz = slot_minzoom[i % 20]
            lon_r = round(float(dot_lon[i]), 5)
            lat_r = round(float(dot_lat[i]), 5)
            feat = {
                "type": "Feature",
                "tippecanoe": {"layer": "dots", "minzoom": mz, "maxzoom": 13},
                "geometry": {"type": "Point", "coordinates": [lon_r, lat_r]},
                "properties": props,
            }
            f.write(json.dumps(feat, separators=(",", ":")))
            f.write("\n")

    return total_dots
