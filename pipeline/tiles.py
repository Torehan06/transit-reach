"""GeoJSONSeq generation for streets/boundary and PMTiles packaging via tippecanoe."""

from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from shapely.geometry import LineString, mapping
from shapely.geometry.base import BaseGeometry
from shapely.prepared import prep

from routing import MODES, RoutingResult

MAX_PMTILES_BYTES = 100 * 1024 * 1024  # 100 MB GitHub Pages / GitHub file limit
SEGMENT_MAX_LEN_M = 110.0
SEGMENT_MAX_DIST_DELTA_M = 60.0
STREET_MAX_PROP_DIST_M = 3300.0  # Slider max is 3219m (2 miles); omit far-away properties

ARTERIAL_HIGHWAYS = {
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
}

COLLECTOR_HIGHWAYS = {
    "tertiary",
    "tertiary_link",
}

CONNECTOR_HIGHWAYS = {
    "unclassified",
    "living_street",
    "pedestrian",
    "road",
}

MINOR_HIGHWAYS = {
    "footway",
    "path",
    "steps",
    "service",
    "track",
    "cycleway",
    "bridleway",
    "corridor",
}


def _street_minzoom(highway: str) -> int:
    if highway in ARTERIAL_HIGHWAYS:
        return 8
    if highway in COLLECTOR_HIGHWAYS:
        return 9
    if highway in CONNECTOR_HIGHWAYS:
        return 10
    if highway in MINOR_HIGHWAYS:
        return 12
    # residential
    return 11


def _quantize_dist(d: float) -> int:
    return int(round(d / 25.0)) * 25


def write_boundary_geojsonseq(boundary_wgs84: BaseGeometry, out_path: Path) -> None:
    """Write city boundary geometry as a GeoJSONSeq feature in layer 'boundary'."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Slightly simplify boundary for crisp tiles (~5m at equator = ~0.00005 deg)
    geom = boundary_wgs84.simplify(0.00005, preserve_topology=True)
    feat = {
        "type": "Feature",
        "tippecanoe": {"layer": "boundary", "minzoom": 8, "maxzoom": 13},
        "geometry": mapping(geom),
        "properties": {"kind": "boundary"},
    }
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(feat, separators=(",", ":")))
        f.write("\n")


def write_streets_geojsonseq(
    ways: List[Tuple[str, List[int]]],
    node_xy: np.ndarray,
    node_lonlat: np.ndarray,
    boundary_utm: BaseGeometry,
    routing: RoutingResult,
    out_path: Path,
) -> int:
    """Segment walkable ways inside the city boundary and stream to GeoJSONSeq.

    Each segment gets integer walking distance (dm..du) and nearest station ID (sm..su)
    for every reachable mode, enabling instant client-side filtering & click-to-inspect.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    prep_boundary = prep(boundary_utm)
    b_minx, b_miny, b_maxx, b_maxy = boundary_utm.bounds

    # Pre-check which nodes lie inside the city boundary bbox (fast filter)
    n_nodes = len(node_xy)
    in_bbox = (
        (node_xy[:, 0] >= b_minx)
        & (node_xy[:, 0] <= b_maxx)
        & (node_xy[:, 1] >= b_miny)
        & (node_xy[:, 1] <= b_maxy)
    )

    active_modes = [m for m in MODES if routing.dist_by_mode.get(m) is not None]
    dist_arrays = {m: routing.dist_by_mode[m] for m in active_modes}
    st_arrays = {m: routing.station_by_mode[m] for m in active_modes}

    def _node_min_dist(u: int) -> float:
        best = math.inf
        for m in active_modes:
            d = float(dist_arrays[m][u])
            if d < best:
                best = d
        return best

    def _emit_chunk(
        f,
        chunk_nodes: List[int],
        highway: str,
    ) -> int:
        if len(chunk_nodes) < 2:
            return 0

        # Check midpoint inside city boundary polygon
        mid_i = len(chunk_nodes) // 2
        mid_u = chunk_nodes[mid_i]
        mx, my = float(node_xy[mid_u, 0]), float(node_xy[mid_u, 1])
        if not (b_minx <= mx <= b_maxx and b_miny <= my <= b_maxy):
            return 0

        from shapely.geometry import Point
        if not prep_boundary.contains(Point(mx, my)):
            # Also check endpoints in case segment crosses boundary
            u0, u1 = chunk_nodes[0], chunk_nodes[-1]
            if not (
                prep_boundary.contains(Point(float(node_xy[u0, 0]), float(node_xy[u0, 1])))
                or prep_boundary.contains(Point(float(node_xy[u1, 0]), float(node_xy[u1, 1])))
            ):
                return 0

        # Build rounded WGS84 coordinate list, dropping duplicate consecutive points
        coords = []
        last_pt = None
        for u in chunk_nodes:
            pt = [round(float(node_lonlat[u, 0]), 5), round(float(node_lonlat[u, 1]), 5)]
            if pt != last_pt:
                coords.append(pt)
                last_pt = pt
        if len(coords) < 2:
            return 0

        # Compute segment properties using midpoint (or endpoint average) per active mode
        u_start = chunk_nodes[0]
        u_end = chunk_nodes[-1]
        props: Dict[str, int] = {}
        for m in active_modes:
            d_arr = dist_arrays[m]
            s_arr = st_arrays[m]
            d_mid = float(d_arr[mid_u])
            if not math.isfinite(d_mid):
                d0, d1 = float(d_arr[u_start]), float(d_arr[u_end])
                if math.isfinite(d0) and math.isfinite(d1):
                    d_mid = 0.5 * (d0 + d1)
                elif math.isfinite(d0):
                    d_mid = d0
                elif math.isfinite(d1):
                    d_mid = d1
                else:
                    continue
            else:
                d0, d1 = float(d_arr[u_start]), float(d_arr[u_end])
                if math.isfinite(d0) and math.isfinite(d1):
                    d_mid = 0.5 * (d0 + d1)

            if d_mid <= STREET_MAX_PROP_DIST_M:
                props[f"d{m}"] = _quantize_dist(d_mid)
                sid = int(s_arr[mid_u])
                if sid < 0:
                    sid = int(s_arr[u_start])
                if sid < 0:
                    sid = int(s_arr[u_end])
                if sid >= 0:
                    props[f"s{m}"] = sid

        minzoom = _street_minzoom(highway)
        feat = {
            "type": "Feature",
            "tippecanoe": {"layer": "streets", "minzoom": minzoom, "maxzoom": 13},
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": props,
        }
        f.write(json.dumps(feat, separators=(",", ":")))
        f.write("\n")
        return 1

    feature_count = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for highway, nodes in ways:
            if len(nodes) < 2:
                continue
            # Quick bbox reject if no node in this way is inside city boundary bbox
            if not any(in_bbox[u] for u in nodes):
                continue

            chunk = [nodes[0]]
            chunk_len = 0.0
            start_min_d = _node_min_dist(nodes[0])

            for i in range(1, len(nodes)):
                u_prev = nodes[i - 1]
                u_curr = nodes[i]
                dx = float(node_xy[u_curr, 0] - node_xy[u_prev, 0])
                dy = float(node_xy[u_curr, 1] - node_xy[u_prev, 1])
                seg_len = math.hypot(dx, dy)

                # If a single OSM edge is very long (> 150m), interpolate intermediate points
                if seg_len > 150.0:
                    if len(chunk) >= 2:
                        feature_count += _emit_chunk(f, chunk, highway)
                    # Split this single edge cleanly into <= 90m pieces
                    n_sub = max(2, int(math.ceil(seg_len / SEGMENT_MAX_LEN_M)))
                    lon0, lat0 = float(node_lonlat[u_prev, 0]), float(node_lonlat[u_prev, 1])
                    lon1, lat1 = float(node_lonlat[u_curr, 0]), float(node_lonlat[u_curr, 1])
                    x0, y0 = float(node_xy[u_prev, 0]), float(node_xy[u_prev, 1])
                    x1, y1 = float(node_xy[u_curr, 0]), float(node_xy[u_curr, 1])
                    from shapely.geometry import Point
                    for s_idx in range(n_sub):
                        t0 = s_idx / n_sub
                        t1 = (s_idx + 1) / n_sub
                        tm = 0.5 * (t0 + t1)
                        mx = x0 + tm * (x1 - x0)
                        my = y0 + tm * (y1 - y0)
                        if not (b_minx <= mx <= b_maxx and b_miny <= my <= b_maxy):
                            continue
                        if not prep_boundary.contains(Point(mx, my)):
                            continue
                        props: Dict[str, int] = {}
                        for m in active_modes:
                            d0 = float(dist_arrays[m][u_prev])
                            d1 = float(dist_arrays[m][u_curr])
                            if math.isfinite(d0) and math.isfinite(d1):
                                # Shortest path from either endpoint along this edge
                                dm = min(d0 + tm * seg_len, d1 + (1.0 - tm) * seg_len)
                                sid = int(st_arrays[m][u_prev] if d0 + tm * seg_len <= d1 + (1.0 - tm) * seg_len else st_arrays[m][u_curr])
                            elif math.isfinite(d0):
                                dm = d0 + tm * seg_len
                                sid = int(st_arrays[m][u_prev])
                            elif math.isfinite(d1):
                                dm = d1 + (1.0 - tm) * seg_len
                                sid = int(st_arrays[m][u_curr])
                            else:
                                continue
                            if dm <= STREET_MAX_PROP_DIST_M:
                                props[f"d{m}"] = _quantize_dist(dm)
                                if sid >= 0:
                                    props[f"s{m}"] = sid
                        minzoom = _street_minzoom(highway)
                        coords = [
                            [round(lon0 + t0 * (lon1 - lon0), 5), round(lat0 + t0 * (lat1 - lat0), 5)],
                            [round(lon0 + t1 * (lon1 - lon0), 5), round(lat0 + t1 * (lat1 - lat0), 5)],
                        ]
                        feat = {
                            "type": "Feature",
                            "tippecanoe": {"layer": "streets", "minzoom": minzoom, "maxzoom": 13},
                            "geometry": {"type": "LineString", "coordinates": coords},
                            "properties": props,
                        }
                        f.write(json.dumps(feat, separators=(",", ":")))
                        f.write("\n")
                        feature_count += 1
                    chunk = [u_curr]
                    chunk_len = 0.0
                    start_min_d = _node_min_dist(u_curr)
                    continue

                chunk.append(u_curr)
                chunk_len += seg_len
                curr_min_d = _node_min_dist(u_curr)

                dist_changed = (
                    math.isfinite(start_min_d) != math.isfinite(curr_min_d)
                    or (
                        math.isfinite(start_min_d)
                        and abs(curr_min_d - start_min_d) >= SEGMENT_MAX_DIST_DELTA_M
                    )
                )

                if chunk_len >= SEGMENT_MAX_LEN_M or dist_changed:
                    feature_count += _emit_chunk(f, chunk, highway)
                    chunk = [u_curr]
                    chunk_len = 0.0
                    start_min_d = curr_min_d

            if len(chunk) >= 2:
                feature_count += _emit_chunk(f, chunk, highway)

    return feature_count


def _run_cmd(cmd: List[str], label: str) -> None:
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"{label} failed:\n{res.stderr}\n{res.stdout}")


def build_pmtiles(
    boundary_path: Path,
    streets_path: Path,
    dots_path: Path,
    output_pmtiles: Path,
) -> int:
    """Package boundary, streets, and tiered dots into one fast PMTiles archive.

    Builds each layer with tailored tippecanoe settings and merges via tile-join:
      - streets: capped tile bytes with --drop-smallest-as-needed at low/mid zooms
                 so initial load and zoom-out tiles stay small & snappy
      - dots:    -r1 --no-feature-limit --no-tile-size-limit so exact zoom-tiered
                 people-per-dot ratios are never randomly dropped
      - boundary: lightweight polygon outline across z8..z13
    """
    output_pmtiles.parent.mkdir(parents=True, exist_ok=True)
    work_dir = boundary_path.parent
    boundary_pm = work_dir / "boundary.pmtiles"
    streets_pm = work_dir / "streets.pmtiles"
    dots_pm = work_dir / "dots.pmtiles"
    tmp_out = output_pmtiles.with_name(f"{output_pmtiles.stem}.tmp.pmtiles")
    for p in (boundary_pm, streets_pm, dots_pm, tmp_out):
        p.unlink(missing_ok=True)

    print(f"  Running tippecanoe (streets + dots + boundary) -> {output_pmtiles.name}...")

    _run_cmd(
        [
            "tippecanoe",
            "-o", str(boundary_pm),
            "--force",
            "-Z8",
            "-z13",
            "--no-tile-size-limit",
            str(boundary_path),
        ],
        "tippecanoe(boundary)",
    )

    _run_cmd(
        [
            "tippecanoe",
            "-o", str(streets_pm),
            "--force",
            "-Z8",
            "-z13",
            "--simplification=6",
            "--maximum-tile-bytes=150000",
            "--maximum-tile-features=40000",
            "--drop-smallest-as-needed",
            "--read-parallel",
            str(streets_path),
        ],
        "tippecanoe(streets)",
    )

    _run_cmd(
        [
            "tippecanoe",
            "-o", str(dots_pm),
            "--force",
            "-Z8",
            "-z13",
            "-r1",
            "--no-feature-limit",
            "--no-tile-size-limit",
            "--read-parallel",
            str(dots_path),
        ],
        "tippecanoe(dots)",
    )

    _run_cmd(
        [
            "tile-join",
            "-f",
            "-pk",
            "-o", str(tmp_out),
            str(boundary_pm),
            str(streets_pm),
            str(dots_pm),
        ],
        "tile-join",
    )

    size_bytes = tmp_out.stat().st_size
    if size_bytes > MAX_PMTILES_BYTES:
        tmp_out.unlink(missing_ok=True)
        raise RuntimeError(
            f"PMTiles file {output_pmtiles.name} is {size_bytes / (1024*1024):.1f} MB, "
            f"exceeding the 100 MB GitHub Pages limit!"
        )

    tmp_out.rename(output_pmtiles)
    return size_bytes
