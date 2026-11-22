"""Non-residential built-up surface (GHS-BUILT-S NRES R2023A, 2025 epoch) near stations.

A proxy for where people go during the day (offices, campuses, hospitals,
shops, factories): square metres of built-up surface in grid cells of
predominantly non-residential use, on the same 100 m Mollweide grid as the
population data. It is floor *footprint*, not people or jobs, so the site
reports it as "non-residential buildings", never as a head count.

Curves mirror the population curves: for every subset of available modes, the
cumulative non-residential m² within 0, 100, ... 3300 m walking distance.
"""

from __future__ import annotations

import time
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pyproj
import requests
from rasterio.features import geometry_mask
from rasterio.io import MemoryFile
from rasterio.windows import from_bounds
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform as shapely_transform

from population import BUCKET_STEP_M, MAX_BUCKET_M, MODE_BITS, MOLLWEIDE_CRS, N_BUCKETS, _ghsl_tiles_for_bounds
from routing import MODES, RoutingResult

NRES_URL_TEMPLATE = (
    "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_S_GLOBE_R2023A/"
    "GHS_BUILT_S_NRES_E2025_GLOBE_R2023A_54009_100/V1-0/tiles/"
    "GHS_BUILT_S_NRES_E2025_GLOBE_R2023A_54009_100_V1_0_R{row}_C{col}.zip"
)


def _ensure_nres_tile(row: int, col: int, cache_dir: Path) -> Optional[Path]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    zip_path = cache_dir / f"GHS_NRES_E2025_R{row}_C{col}.zip"
    if zip_path.exists() and zip_path.stat().st_size > 1000:
        return zip_path
    url = NRES_URL_TEMPLATE.format(row=row, col=col)
    print(f"  Downloading GHSL NRES tile R{row}_C{col}...")
    for attempt in range(5):
        try:
            resp = requests.get(url, stream=True, timeout=120)
            if resp.status_code == 404:
                return None
            if resp.status_code < 500:
                resp.raise_for_status()
                break
        except requests.RequestException:
            if attempt == 4:
                raise
        time.sleep(30 * (attempt + 1))
    else:
        resp.raise_for_status()
    tmp = zip_path.with_suffix(".zip.part")
    with open(tmp, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1 << 20):
            if chunk:
                f.write(chunk)
    tmp.rename(zip_path)
    return zip_path


def process_nres(
    boundary_wgs84: BaseGeometry,
    utm_crs: pyproj.CRS,
    routing: RoutingResult,
    cache_dir: Path,
) -> Dict[str, Any]:
    """Cumulative non-residential built-up m² by walking distance, per mode subset."""
    to_moll = pyproj.Transformer.from_crs("EPSG:4326", MOLLWEIDE_CRS, always_xy=True)
    moll_to_utm = pyproj.Transformer.from_crs(MOLLWEIDE_CRS, utm_crs, always_xy=True)
    boundary_moll = shapely_transform(to_moll.transform, boundary_wgs84)
    minx, miny, maxx, maxy = boundary_moll.bounds

    mx_l: List[np.ndarray] = []
    my_l: List[np.ndarray] = []
    v_l: List[np.ndarray] = []
    for tr, tc in _ghsl_tiles_for_bounds(minx, miny, maxx, maxy):
        zp = _ensure_nres_tile(tr, tc, cache_dir)
        if zp is None:
            continue
        with zipfile.ZipFile(zp) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".tif")]
            if not names:
                continue
            data_bytes = zf.read(names[0])
        with MemoryFile(data_bytes) as mf, mf.open() as ds:
            ix0, iy0 = max(minx, ds.bounds.left), max(miny, ds.bounds.bottom)
            ix1, iy1 = min(maxx, ds.bounds.right), min(maxy, ds.bounds.top)
            if ix0 >= ix1 or iy0 >= iy1:
                continue
            win = from_bounds(ix0, iy0, ix1, iy1, ds.transform).round_offsets().round_lengths()
            if win.width <= 0 or win.height <= 0:
                continue
            data = ds.read(1, window=win)
            wt = ds.window_transform(win)
            inside = ~geometry_mask([mapping(boundary_moll)], out_shape=data.shape, transform=wt, invert=False)
            nodata = ds.nodata
            valid = inside & (data > 0) & np.isfinite(data)
            if nodata is not None:
                valid &= data != nodata
            rr, cc = np.where(valid)
            if not len(rr):
                continue
            mx_l.append(wt.c + (cc + 0.5) * wt.a)
            my_l.append(wt.f + (rr + 0.5) * wt.e)
            v_l.append(data[rr, cc].astype(np.float64))

    if not v_l:
        return {"total_m2": 0, "available_modes_mask": 0, "curves": {}}
    mx = np.concatenate(mx_l)
    my = np.concatenate(my_l)
    val = np.concatenate(v_l)
    total = float(val.sum())

    ux, uy = moll_to_utm.transform(mx, my)
    snap_d, kd_idx = routing.valid_kdtree.query(np.column_stack([ux, uy]), k=1, distance_upper_bound=500.0)
    ok = np.isfinite(snap_d) & (kd_idx < len(routing.valid_node_indices))
    nodes = np.where(ok, routing.valid_node_indices[np.minimum(kd_idx, len(routing.valid_node_indices) - 1)], -1)

    dist_by_mode: Dict[str, np.ndarray] = {}
    avail: List[str] = []
    mask_all = 0
    for m in MODES:
        nd = routing.dist_by_mode.get(m)
        if nd is None:
            continue
        cd = np.full(len(val), np.inf, dtype=np.float32)
        cd[ok] = snap_d[ok].astype(np.float32) + nd[nodes[ok]]
        if np.any(cd <= MAX_BUCKET_M):
            dist_by_mode[m] = cd
            avail.append(m)
            mask_all |= MODE_BITS[m]

    curves: Dict[str, List[int]] = {}
    for subset in range(1, 1 << len(avail)):
        mask = 0
        arrs = []
        for i, m in enumerate(avail):
            if subset & (1 << i):
                mask |= MODE_BITS[m]
                arrs.append(dist_by_mode[m])
        dmin = arrs[0] if len(arrs) == 1 else np.minimum.reduce(arrs)
        w = dmin <= MAX_BUCKET_M
        hist = np.zeros(N_BUCKETS, dtype=np.float64)
        if np.any(w):
            b = np.clip(np.ceil(dmin[w] / BUCKET_STEP_M).astype(np.int32), 0, N_BUCKETS - 1)
            np.add.at(hist, b, val[w])
        curves[str(mask)] = [int(round(v)) for v in np.cumsum(hist)]
    return {"total_m2": int(round(total)), "available_modes_mask": mask_all, "curves": curves}
