"""OSM .pbf downloading, boundary extraction, transit station deduplication, and street graph building."""

from __future__ import annotations

import math
import re
import subprocess
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
import osmium
import pyproj
import requests
from scipy.spatial import cKDTree
from shapely import wkb as shapely_wkb
from shapely.geometry import Point, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform as shapely_transform, unary_union
from shapely.prepared import prep
from shapely.validation import make_valid

from routing import MODES, MergedStation

BUFFER_METERS = 3500.0  # > 2 miles (3218.69m) so border stations & routes serve boundary interior

WALKABLE_HIGHWAYS = {
    "footway",
    "pedestrian",
    "path",
    "steps",
    "living_street",
    "residential",
    "unclassified",
    "tertiary",
    "tertiary_link",
    "secondary",
    "secondary_link",
    "primary",
    "primary_link",
    "service",
    "track",
    "road",
    "corridor",
    "bridleway",
    "cycleway",
}

EXCLUDED_SERVICE = {"driveway", "parking_aisle", "emergency_access", "private"}
EXCLUDED_ACCESS = {"no", "private"}
ALLOWED_FOOT = {"yes", "designated", "permissive", "customers", "destination"}

STOP_ROLES = {
    "stop",
    "stop_entry_only",
    "stop_exit_only",
    "platform",
    "platform_entry_only",
    "platform_exit_only",
    "station",
}

PLATFORM_WAY_ROLES = {
    "platform",
    "platform_entry_only",
    "platform_exit_only",
    "station",
}


@dataclass
class RawCandidate:
    mode: str
    x: float
    y: float
    lon: float
    lat: float
    name: str
    stop_area_id: Optional[int]
    priority: int  # 3=station/ferry/aerialway, 2=tram_stop/halt/pt_station, 1=platform/stop_pos


@dataclass
class CityOSMData:
    boundary_wgs84: BaseGeometry
    boundary_utm: BaseGeometry
    utm_crs: pyproj.CRS
    stations: List[MergedStation]
    node_xy: np.ndarray          # (N, 2) float64 UTM meters
    node_lonlat: np.ndarray      # (N, 2) float64 WGS84
    edge_u: np.ndarray           # (E,) int32
    edge_v: np.ndarray           # (E,) int32
    edge_len: np.ndarray         # (E,) float32 meters
    ways: List[Tuple[str, List[int]]]  # (highway_type, [local_node_idx, ...]) for rendering


def _normalize_name(name: str) -> str:
    """Normalize station name across Turkish, Kazakh/Cyrillic, European, and CJK scripts."""
    if not name:
        return ""
    # Turkish special case before lower()
    s = name.replace("İ", "i").replace("I", "i").replace("ı", "i")
    s = s.lower().strip()
    # Fold Latin diacritics (keep Cyrillic / CJK intact)
    decomposed = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    # Remove parenthetical notes like "(M2)" or "(Exit A)"
    s = re.sub(r"\([^)]*\)", " ", s)
    # Strip common transit station suffixes/prefixes
    s = re.sub(
        r"\b(station|metro|subway|tram|tramway|lrt|brt|metrobus|pier|ferry|terminal|wharf|"
        r"istasyonu|istasyon|duragi|durak|iskelesi|iskele|teleferik|funikuler|"
        r"bahnhof|bhf|u-bhf|s-bhf|haltestelle|gare|arret|estacion|estacio|stazione|"
        r"platform|peron|stop|halt|bound|northbound|southbound|eastbound|westbound|"
        r"st\.?|ave\.?|blvd\.?|rd\.?)\b",
        " ",
        s,
    )
    s = re.sub(r"[^\w]+", " ", s, flags=re.UNICODE)
    return " ".join(s.split())


def _match_tag_rules(tags: Dict[str, str], rules: List[Dict[str, str]]) -> bool:
    """Check if OSM tags satisfy any matcher rule dict (all keys in a rule must regex-match)."""
    for rule in rules:
        ok = True
        for key, pattern in rule.items():
            val = tags.get(key, "")
            if not val or not re.search(pattern, val, flags=re.IGNORECASE):
                ok = False
                break
        if ok:
            return True
    return False


def _download_file(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 10_000:
        return dest
    print(f"  Downloading {url}...")
    resp = requests.get(url, stream=True, timeout=180)
    resp.raise_for_status()
    tmp = dest.with_suffix(dest.suffix + ".part")
    with open(tmp, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1 << 20):
            if chunk:
                f.write(chunk)
    tmp.rename(dest)
    return dest


def ensure_city_pbf(city: Dict[str, Any], cache_dir: Path) -> Path:
    """Ensure a city-sized OSM .pbf exists in cache_dir/pbf/."""
    pbf_dir = cache_dir / "pbf"
    pbf_dir.mkdir(parents=True, exist_ok=True)
    pbf_cfg = city["pbf"]
    source = pbf_cfg["source"]

    if source == "bbbike":
        name = pbf_cfg["name"]
        url = f"https://download.bbbike.org/osm/bbbike/{name}/{name}.osm.pbf"
        return _download_file(url, pbf_dir / f"{name}.osm.pbf")

    if source == "geofabrik":
        rel_path = pbf_cfg["path"]
        raw_name = Path(rel_path).name
        city_slice = pbf_dir / f"city_{city['id']}.osm.pbf"
        if city_slice.exists() and city_slice.stat().st_size > 10_000:
            return city_slice

        raw_pbf = _download_file(f"https://download.geofabrik.de/{rel_path}", pbf_dir / raw_name)
        west, south, east, north = city["bbox"]
        bbox_str = f"{west},{south},{east},{north}"
        print(f"  Clipping {raw_name} to {city['id']} ({bbox_str})...")
        tmp_slice = pbf_dir / f"city_{city['id']}.tmp.osm.pbf"
        cmd = [
            "osmium",
            "extract",
            "-b",
            bbox_str,
            "--strategy=smart",
            # Also complete boundary relations (not just multipolygons), so city
            # boundaries that cross the clip bbox can still be assembled.
            "-S",
            "types=multipolygon,boundary",
            "--overwrite",
            "-o",
            str(tmp_slice),
            str(raw_pbf),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(f"osmium extract failed for {city['id']}:\n{res.stderr}")
        tmp_slice.rename(city_slice)
        return city_slice

    raise ValueError(f"Unknown pbf source: {source}")


def _choose_utm_crs(lon: float, lat: float) -> pyproj.CRS:
    zone = int(math.floor((lon + 180.0) / 6.0)) + 1
    epsg = (32600 if lat >= 0 else 32700) + zone
    return pyproj.CRS.from_epsg(epsg)


def _fold_name(s: str) -> str:
    s = s.replace("İ", "i").replace("I", "i").replace("ı", "i").lower().strip()
    decomposed = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def extract_boundary(pbf_path: Path, city: Dict[str, Any]) -> Tuple[BaseGeometry, BaseGeometry, pyproj.CRS]:
    """Extract and assemble the configured administrative boundary multipolygon from OSM PBF."""
    b_cfg = city["boundary"]
    west, south, east, north = city["bbox"]
    bbox_poly = box(west, south, east, north)

    target_rel_ids: Optional[Set[int]] = set(b_cfg["relation_ids"]) if b_cfg.get("relation_ids") else None
    admin_levels = b_cfg.get("admin_level")
    if isinstance(admin_levels, str):
        admin_levels = {admin_levels}
    elif isinstance(admin_levels, list):
        admin_levels = {str(x) for x in admin_levels}
    else:
        admin_levels = None

    wanted_names = {_fold_name(n) for n in b_cfg.get("names", [])}
    exclude_names = {_fold_name(n) for n in b_cfg.get("exclude_names", [])}
    # Optional custom tag filters (e.g. {"ISO3166-2": "TR-34"})
    extra_tags: Dict[str, str] = b_cfg.get("tags", {})

    wkb_fab = osmium.geom.WKBFactory()
    matched_geoms: List[Tuple[str, BaseGeometry]] = []

    fp = (
        osmium.FileProcessor(str(pbf_path))
        .with_areas(osmium.filter.KeyFilter("boundary"))
        .with_filter(osmium.filter.EntityFilter(osmium.osm.AREA))
    )
    for a in fp:
        if a.from_way():
            continue
        t = a.tags
        if t.get("boundary") != "administrative":
            continue

        orig_id = a.orig_id()
        if target_rel_ids is not None:
            if orig_id not in target_rel_ids:
                continue
        else:
            if admin_levels is not None and t.get("admin_level") not in admin_levels:
                continue
            skip = False
            for k, v in extra_tags.items():
                if t.get(k) != v:
                    skip = True
                    break
            if skip:
                continue
            cand_names = {
                _fold_name(t.get(k, ""))
                for k in ("name", "name:en", "official_name", "short_name", "int_name")
                if t.get(k)
            }
            if exclude_names and (cand_names & exclude_names):
                continue
            if wanted_names and not (cand_names & wanted_names):
                continue

        try:
            geom = shapely_wkb.loads(wkb_fab.create_multipolygon(a))
        except Exception:
            continue
        if not geom.is_valid:
            geom = make_valid(geom)
        if geom.is_empty:
            continue
        c = geom.centroid
        if not bbox_poly.contains(c) and not geom.intersects(bbox_poly):
            continue
        matched_geoms.append((t.get("name", str(orig_id)), geom))

    if not matched_geoms:
        raise RuntimeError(
            f"No administrative boundary matched for {city['id']} in {pbf_path.name}! "
            f"Config: {b_cfg}"
        )

    matched_names = sorted({n for n, _ in matched_geoms})
    if wanted_names and len(matched_names) < len(wanted_names):
        print(
            f"  [WARN] {city['id']}: matched {len(matched_names)}/{len(wanted_names)} "
            f"boundary names: {matched_names}"
        )
    else:
        print(f"  Boundary matched ({len(matched_names)} polygons): {', '.join(matched_names[:10])}{'...' if len(matched_names) > 10 else ''}")

    boundary_wgs84 = unary_union([g for _, g in matched_geoms])
    if b_cfg.get("fill_holes"):
        from shapely.geometry import MultiPolygon as _MP, Polygon as _P
        if isinstance(boundary_wgs84, _P):
            boundary_wgs84 = _P(boundary_wgs84.exterior)
        elif isinstance(boundary_wgs84, _MP):
            boundary_wgs84 = _MP([_P(g.exterior) for g in boundary_wgs84.geoms])
    if b_cfg.get("clip_bbox"):
        cw, cs, ce, cn = b_cfg["clip_bbox"]
        boundary_wgs84 = boundary_wgs84.intersection(box(cw, cs, ce, cn))
    if not boundary_wgs84.is_valid:
        boundary_wgs84 = make_valid(boundary_wgs84)

    centroid = boundary_wgs84.centroid
    utm_crs = _choose_utm_crs(centroid.x, centroid.y)
    to_utm = pyproj.Transformer.from_crs("EPSG:4326", utm_crs, always_xy=True)
    boundary_utm = shapely_transform(to_utm.transform, boundary_wgs84)
    if not boundary_utm.is_valid:
        boundary_utm = make_valid(boundary_utm)

    return boundary_wgs84, boundary_utm, utm_crs


def _classify_route_relation(
    tags: Dict[str, str],
    overrides: Dict[str, Any],
) -> Optional[str]:
    """Classify an OSM route relation into one of the 6 modes (or None)."""
    if tags.get("type") != "route":
        return None
    if tags.get("disused") == "yes" or tags.get("abandoned") == "yes" or tags.get("historic") == "yes":
        return None
    if tags.get("usage") in ("tourism", "freight", "industrial") or tags.get("service") == "tourism":
        return None
    if tags.get("heritage") == "yes" or tags.get("state") == "proposed":
        return None

    exclude_routes = overrides.get("exclude_routes", [])
    if exclude_routes and _match_tag_rules(tags, exclude_routes):
        return None

    # Check city-specific overrides first
    for mode_key, mode_code in (
        ("metro_match", "m"),
        ("tram_match", "t"),
        ("commuter_match", "c"),
        ("brt_match", "b"),
        ("ferry_match", "f"),
        ("funicular_match", "u"),
    ):
        rules = overrides.get(mode_key, [])
        if rules and _match_tag_rules(tags, rules):
            return mode_code

    route = tags.get("route", "")

    # Optional inclusion of under-construction routes (e.g. Astana LRT)
    inc_const = overrides.get("include_construction", [])
    if inc_const:
        const_route = tags.get("construction:route") or tags.get("construction") or ""
        if route in ("construction", "proposed", "") or tags.get("state") == "construction":
            for rule in inc_const:
                target_mode = rule.get("mode", "t")
                tag_rule = {k: v for k, v in rule.items() if k != "mode"}
                if not tag_rule or _match_tag_rules(tags, [tag_rule]) or const_route in ("light_rail", "tram", "subway"):
                    return target_mode

    if route == "subway":
        return "m"
    if route in ("tram", "light_rail", "monorail"):
        return "t"
    if route in ("train", "railway", "suburban"):
        if tags.get("passenger") == "no" or tags.get("freight") == "yes":
            return None
        return "c"
    if route in ("bus:rapid_transit", "brt"):
        return "b"
    if route == "bus":
        if (
            tags.get("brt") == "yes"
            or tags.get("bus_rapid_transit") == "yes"
            or tags.get("bus") == "rapid"
            or tags.get("service") == "brt"
        ):
            return "b"
        return None
    if route == "ferry":
        if tags.get("foot") == "no" or tags.get("passenger") == "no" or tags.get("cargo") == "yes":
            return None
        return "f"
    if route == "funicular":
        return "u"
    if route == "aerialway":
        aw = tags.get("aerialway", "")
        if aw in ("chair_lift", "drag_lift", "t-bar", "j-bar", "platter", "magic_carpet", "zip_line"):
            return None
        return "u"

    return None


def _classify_element_tags(
    tags: Dict[str, str],
    rel_modes: Set[str],
    overrides: Dict[str, Any],
    is_urban_aerialway_node: bool = False,
) -> Tuple[Set[str], int]:
    """Return (modes_set, priority) for a node/way element."""
    # Exclusions
    if (
        tags.get("disused") == "yes"
        or tags.get("abandoned") == "yes"
        or tags.get("historic") == "yes"
        or tags.get("passenger") == "no"
        or tags.get("usage") in ("freight", "industrial", "tourism")
        or tags.get("heritage") == "yes"
        or tags.get("access") == "private"
    ):
        return set(), 0

    railway = tags.get("railway", "")
    station = tags.get("station", "")
    pt = tags.get("public_transport", "")
    amenity = tags.get("amenity", "")
    aerialway = tags.get("aerialway", "")
    highway = tags.get("highway", "")

    if railway in ("disused", "abandoned", "proposed", "miniature", "razed", "dismantled"):
        return set(), 0
    if station in ("miniature", "disused", "abandoned", "proposed", "freight"):
        return set(), 0

    exclude_stations = overrides.get("exclude_stations", [])
    if exclude_stations and _match_tag_rules(tags, exclude_stations):
        return set(), 0

    # Check under-construction handling (e.g. Astana LRT)
    is_construction = (
        railway == "construction"
        or tags.get("construction") in ("station", "subway", "light_rail", "tram_stop", "halt")
        or tags.get("construction:railway") in ("station", "halt", "tram_stop")
        or bool(tags.get("construction:station"))
    )
    if is_construction:
        inc_const = overrides.get("include_construction", [])
        if not inc_const:
            return set(), 0
        matched_const_modes: Set[str] = set()
        for rule in inc_const:
            target_mode = rule.get("mode", "t")
            tag_rule = {k: v for k, v in rule.items() if k != "mode"}
            if not tag_rule or _match_tag_rules(tags, [tag_rule]):
                matched_const_modes.add(target_mode)
        if matched_const_modes:
            return matched_const_modes, 3
        return set(), 0

    modes: Set[str] = set(rel_modes)
    priority = 1 if rel_modes else 0

    # Direct OSM station/stop tag classification
    if railway in ("station", "halt"):
        priority = max(priority, 3 if railway == "station" else 2)
        explicit_submode = False
        if station == "subway" or tags.get("subway") == "yes":
            modes.add("m")
            explicit_submode = True
        if station in ("light_rail", "tram", "monorail") or tags.get("light_rail") == "yes" or tags.get("tram") == "yes" or tags.get("monorail") == "yes":
            modes.add("t")
            explicit_submode = True
        if station == "funicular" or tags.get("funicular") == "yes":
            modes.add("u")
            explicit_submode = True
        if tags.get("train") == "yes" or station in ("rail", "train", "commuter", "regional"):
            modes.add("c")
            explicit_submode = True
        if not explicit_submode and not (rel_modes & {"m", "t", "u"}):
            # Default untyped railway=station / halt is commuter/regional rail
            modes.add("c")

    elif railway == "tram_stop":
        modes.add("t")
        priority = max(priority, 2)

    elif railway == "stop":
        priority = max(priority, 2)
        if tags.get("subway") == "yes":
            modes.add("m")
        if tags.get("light_rail") == "yes" or tags.get("tram") == "yes":
            modes.add("t")
        if tags.get("train") == "yes":
            modes.add("c")
        if tags.get("funicular") == "yes":
            modes.add("u")

    if amenity == "ferry_terminal":
        if tags.get("foot") != "no" and tags.get("cargo") != "yes" and tags.get("ferry") != "cargo":
            modes.add("f")
            priority = max(priority, 3)

    if aerialway == "station":
        # Exclude ski lifts unless explicitly matched
        if not tags.get("piste:type") and tags.get("sport") != "skiing":
            if is_urban_aerialway_node or pt in ("station", "stop_position", "platform") or "u" in rel_modes:
                modes.add("u")
                priority = max(priority, 3)

    if pt in ("station", "stop_position", "platform"):
        p_val = 2 if pt == "station" else 1
        if tags.get("subway") == "yes":
            modes.add("m")
            priority = max(priority, p_val)
        if tags.get("light_rail") == "yes" or tags.get("tram") == "yes":
            modes.add("t")
            priority = max(priority, p_val)
        if tags.get("train") == "yes":
            modes.add("c")
            priority = max(priority, p_val)
        if tags.get("funicular") == "yes":
            modes.add("u")
            priority = max(priority, p_val)
        if tags.get("ferry") == "yes" and tags.get("foot") != "no":
            modes.add("f")
            priority = max(priority, p_val)

    # BRT direct tags
    if (
        tags.get("brt") == "yes"
        or tags.get("bus_rapid_transit") == "yes"
        or tags.get("bus") == "rapid"
        or station == "bus_rapid_transit"
    ):
        if highway == "bus_stop" or pt in ("station", "platform", "stop_position") or amenity == "bus_station":
            modes.add("b")
            priority = max(priority, 2)

    # City-specific tag overrides on nodes/ways
    is_transit_elem = bool(
        modes
        or railway in ("station", "halt", "stop", "tram_stop", "platform")
        or pt in ("station", "platform", "stop_position")
        or highway == "bus_stop"
        or amenity in ("ferry_terminal", "bus_station")
        or aerialway == "station"
    )
    if is_transit_elem:
        for mode_key, mode_code in (
            ("metro_match", "m"),
            ("tram_match", "t"),
            ("commuter_match", "c"),
            ("brt_match", "b"),
            ("ferry_match", "f"),
            ("funicular_match", "u"),
        ):
            rules = overrides.get(mode_key, [])
            if rules and _match_tag_rules(tags, rules):
                modes.add(mode_code)
                priority = max(priority, 2)

        # Optional reclassification (replace one mode with another when tags match, or unconditionally if no tag filter)
        for rule in overrides.get("reclassify", []):
            from_m = rule["from"]
            to_m = rule["to"]
            tag_rule = {k: v for k, v in rule.items() if k not in ("from", "to")}
            if from_m in modes and (not tag_rule or _match_tag_rules(tags, [tag_rule])):
                modes.discard(from_m)
                modes.add(to_m)

    # Clean up: if a station was ONLY tagged as subway/tram/funicular via overrides, don't keep stray modes
    if not modes:
        return set(), 0
    return modes, max(priority, 1)


def _is_walkable_way(tags: Dict[str, str]) -> Tuple[bool, str, bool]:
    """Return (is_walkable, highway_kind, include_in_rendered_streets)."""
    foot = tags.get("foot", "")
    access = tags.get("access", "")
    if foot in EXCLUDED_ACCESS:
        return False, "", False
    if access in EXCLUDED_ACCESS and foot not in ALLOWED_FOOT:
        return False, "", False

    hw = tags.get("highway", "")
    if hw in WALKABLE_HIGHWAYS:
        if hw == "service" and tags.get("service", "") in EXCLUDED_SERVICE:
            return False, "", False
        return True, hw, True

    if hw in ("trunk", "trunk_link"):
        if tags.get("motorroad") == "yes":
            return False, "", False
        if foot in ALLOWED_FOOT or tags.get("sidewalk", "") in ("both", "left", "right", "yes"):
            return True, hw, True
        return False, "", False

    # Include station platforms in routing graph so stations snap cleanly, but omit from street visuals
    if tags.get("public_transport") == "platform" or tags.get("railway") == "platform":
        return True, "platform", False

    return False, "", False


def _merge_mode_stations(
    candidates: List[RawCandidate],
    mode: str,
    subway_entrances: List[Tuple[float, float]],
    boundary_utm: BaseGeometry,
    utm_to_wgs: pyproj.Transformer,
    start_id: int,
) -> List[MergedStation]:
    """Cluster duplicate OSM station/platform/stop nodes of the same mode into one station."""
    if not candidates:
        return []

    n = len(candidates)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    coords = np.array([[c.x, c.y] for c in candidates], dtype=np.float64)
    norms = [_normalize_name(c.name) for c in candidates]
    tree = cKDTree(coords)

    # Radii tailored to mode geometry
    tight_r = 75.0 if mode in ("t", "b") else 115.0
    name_r = 260.0 if mode in ("t", "b") else 420.0
    unnamed_r = 140.0
    stop_area_r = 550.0

    max_r = max(tight_r, name_r, unnamed_r, stop_area_r)
    pairs = tree.query_pairs(r=max_r, output_type="ndarray")

    for i, j in pairs:
        ci = candidates[i]
        cj = candidates[j]
        dist = math.hypot(ci.x - cj.x, ci.y - cj.y)

        # 1. Same OSM stop_area relation
        if ci.stop_area_id is not None and ci.stop_area_id == cj.stop_area_id and dist <= stop_area_r:
            union(i, j)
            continue

        # 2. Tight spatial proximity (opposite-side platforms / duplicate nodes)
        if dist <= tight_r:
            union(i, j)
            continue

        ni, nj = norms[i], norms[j]

        # 3. Matching normalized name within station complex radius
        if ni and nj and dist <= name_r:
            if ni == nj or (len(ni) >= 4 and len(nj) >= 4 and (ni in nj or nj in ni)):
                union(i, j)
                continue

        # 4. Unnamed platform/stop_position near a named station
        if dist <= unnamed_r and ((not ni and nj) or (ni and not nj)):
            union(i, j)
            continue

    # Group clusters
    clusters: Dict[int, List[RawCandidate]] = {}
    for idx, c in enumerate(candidates):
        clusters.setdefault(find(idx), []).append(c)

    # Build entrance KDTree for attaching subway exits to metro stations
    ent_arr = np.array(subway_entrances, dtype=np.float64) if (mode == "m" and subway_entrances) else None
    ent_tree = cKDTree(ent_arr) if ent_arr is not None else None

    boundary_dist_tol = 200.0 if mode == "f" else 50.0
    prep_boundary = prep(boundary_utm)

    merged: List[MergedStation] = []
    next_id = start_id

    for members in clusters.values():
        # Drop isolated low-priority unnamed platforms/stop_positions
        named_members = [m for m in members if m.name.strip()]
        max_prio = max(m.priority for m in members)
        if not named_members and max_prio < 2:
            continue

        # Choose cleanest name from highest-priority named members
        if named_members:
            best_prio = max(m.priority for m in named_members)
            top_named = [m for m in named_members if m.priority == best_prio]
            # Prefer concise name without platform numbers
            best_name = min(top_named, key=lambda m: (len(m.name), m.name)).name.strip()
        else:
            mode_label = {
                "m": "Metro Station",
                "t": "Tram Stop",
                "c": "Rail Station",
                "b": "BRT Station",
                "f": "Ferry Terminal",
                "u": "Cable Car / Funicular",
            }[mode]
            best_name = mode_label

        # Centroid of highest-priority members for crisp marker placement
        top_members = [m for m in members if m.priority == max_prio]
        cx = float(np.mean([m.x for m in top_members]))
        cy = float(np.mean([m.y for m in top_members]))
        clon, clat = utm_to_wgs.transform(cx, cy)

        # Deduplicated access points (10m grid rounding)
        access_map: Dict[Tuple[int, int], Tuple[float, float]] = {}
        for m in members:
            key = (int(round(m.x / 10.0)), int(round(m.y / 10.0)))
            access_map[key] = (m.x, m.y)
        access_map[(int(round(cx / 10.0)), int(round(cy / 10.0)))] = (cx, cy)

        # Attach nearby subway_entrance nodes to metro stations
        if ent_tree is not None and ent_arr is not None:
            near_idxs = ent_tree.query_ball_point([cx, cy], r=220.0)
            for ei in near_idxs:
                ex, ey = float(ent_arr[ei, 0]), float(ent_arr[ei, 1])
                key = (int(round(ex / 10.0)), int(round(ey / 10.0)))
                access_map[key] = (ex, ey)

        pt = Point(cx, cy)
        inside = prep_boundary.contains(pt) or (boundary_utm.distance(pt) <= boundary_dist_tol)

        merged.append(
            MergedStation(
                station_id=next_id,
                mode=mode,
                name=best_name,
                lon=round(float(clon), 6),
                lat=round(float(clat), 6),
                x=cx,
                y=cy,
                access_xy=list(access_map.values()),
                inside_boundary=inside,
            )
        )
        next_id += 1

    return merged


def extract_city_osm(city: Dict[str, Any], cache_dir: Path) -> CityOSMData:
    """Run full OSM extraction: boundary, transit stations, and walkable street graph."""
    pbf_path = ensure_city_pbf(city, cache_dir)
    boundary_wgs84, boundary_utm, utm_crs = extract_boundary(pbf_path, city)

    to_utm = pyproj.Transformer.from_crs("EPSG:4326", utm_crs, always_xy=True)
    to_wgs = pyproj.Transformer.from_crs(utm_crs, "EPSG:4326", always_xy=True)

    buffered_utm = boundary_utm.buffer(BUFFER_METERS)
    buffered_wgs84 = shapely_transform(to_wgs.transform, buffered_utm)
    buf_minlon, buf_minlat, buf_maxlon, buf_maxlat = buffered_wgs84.bounds
    prep_buf_utm = prep(buffered_utm)

    overrides = city.get("mode_overrides", {})

    # ── Pass 1: Relations (stop_areas + transit routes) — C++ filtered ──
    stop_area_of: Dict[Tuple[str, int], int] = {}
    stop_area_name: Dict[int, str] = {}
    member_modes: Dict[Tuple[str, int], Set[str]] = {}

    rel_fp = (
        osmium.FileProcessor(str(pbf_path))
        .with_filter(osmium.filter.EntityFilter(osmium.osm.RELATION))
        .with_filter(osmium.filter.KeyFilter("route", "public_transport", "construction", "construction:route"))
    )
    for r in rel_fp:
        tags = {t.k: t.v for t in r.tags}
        if tags.get("public_transport") == "stop_area":
            sa_name = tags.get("name", "")
            if sa_name:
                stop_area_name[r.id] = sa_name
            for m in r.members:
                stop_area_of[(m.type, m.ref)] = r.id
            continue

        mode = _classify_route_relation(tags, overrides)
        if mode is None:
            continue

        for m in r.members:
            if m.type == "n" and (m.role in STOP_ROLES or m.role == ""):
                member_modes.setdefault(("n", m.ref), set()).add(mode)
            elif m.type == "w" and m.role in PLATFORM_WAY_ROLES:
                member_modes.setdefault(("w", m.ref), set()).add(mode)

    # ── Pass 2: Nodes & Ways (streets + station candidates + aerialway lines) — C++ filtered ──
    raw_candidates: Dict[str, List[RawCandidate]] = {m: [] for m in MODES}
    subway_entrances: List[Tuple[float, float]] = []
    aerialway_station_nodes: Set[int] = set()

    # Walkable street storage: OSM node_id -> local int index
    osm_to_local: Dict[int, int] = {}
    node_lon_list: List[float] = []
    node_lat_list: List[float] = []
    edge_u_list: List[int] = []
    edge_v_list: List[int] = []
    rendered_ways: List[Tuple[str, List[int]]] = []

    pending_aerialway_nodes: List[Tuple[int, float, float, float, float, str, Optional[int], Set[str]]] = []

    elem_key_filter = osmium.filter.KeyFilter(
        "highway",
        "railway",
        "public_transport",
        "amenity",
        "aerialway",
        "station",
        "brt",
        "bus_rapid_transit",
        "bus",
        "construction",
        "construction:railway",
        "construction:station",
    )
    elem_fp = (
        osmium.FileProcessor(str(pbf_path))
        .with_locations()
        .with_filter(osmium.filter.EntityFilter(osmium.osm.NODE | osmium.osm.WAY))
        .with_filter(elem_key_filter)
    )

    for obj in elem_fp:
        if obj.is_node():
            n = obj
            if not n.location.valid():
                continue
            lon = n.location.lon
            lat = n.location.lat
            if not (buf_minlon <= lon <= buf_maxlon and buf_minlat <= lat <= buf_maxlat):
                continue

            tags = {t.k: t.v for t in n.tags}
            if tags.get("railway") == "subway_entrance":
                x, y = to_utm.transform(lon, lat)
                if prep_buf_utm.contains(Point(x, y)):
                    subway_entrances.append((x, y))
                continue

            rel_m = member_modes.get(("n", n.id), set())
            if tags.get("aerialway") == "station" and not tags.get("piste:type") and tags.get("sport") != "skiing":
                x, y = to_utm.transform(lon, lat)
                if prep_buf_utm.contains(Point(x, y)):
                    sa_id = stop_area_of.get(("n", n.id))
                    name = tags.get("name") or (stop_area_name.get(sa_id, "") if sa_id else "")
                    pending_aerialway_nodes.append((n.id, x, y, lon, lat, name, sa_id, rel_m))
                continue

            modes, prio = _classify_element_tags(tags, rel_m, overrides)
            if not modes:
                continue

            x, y = to_utm.transform(lon, lat)
            if not prep_buf_utm.contains(Point(x, y)):
                continue

            sa_id = stop_area_of.get(("n", n.id))
            name = tags.get("name") or (stop_area_name.get(sa_id, "") if sa_id else "")
            for m in modes:
                raw_candidates[m].append(
                    RawCandidate(
                        mode=m,
                        x=x,
                        y=y,
                        lon=lon,
                        lat=lat,
                        name=name,
                        stop_area_id=sa_id,
                        priority=prio,
                    )
                )
        elif obj.is_way():
            w = obj
            if len(w.nodes) < 2:
                continue
            tags = {t.k: t.v for t in w.tags}

            aw = tags.get("aerialway", "")
            if aw in ("cable_car", "gondola") and not tags.get("piste:type"):
                for nd in w.nodes:
                    aerialway_station_nodes.add(nd.ref)

            rel_m = member_modes.get(("w", w.id), set())
            if (
                rel_m
                or tags.get("railway") in ("station", "halt", "tram_stop", "construction")
                or tags.get("amenity") == "ferry_terminal"
                or tags.get("aerialway") == "station"
                or tags.get("public_transport") in ("station", "platform")
                or tags.get("brt") == "yes"
                or tags.get("bus_rapid_transit") == "yes"
            ):
                valid_coords = [(nd.lon, nd.lat) for nd in w.nodes if nd.location.valid()]
                if valid_coords:
                    clon = sum(p[0] for p in valid_coords) / len(valid_coords)
                    clat = sum(p[1] for p in valid_coords) / len(valid_coords)
                    if buf_minlon <= clon <= buf_maxlon and buf_minlat <= clat <= buf_maxlat:
                        is_urban_aw = any(nd.ref in aerialway_station_nodes for nd in w.nodes)
                        modes, prio = _classify_element_tags(tags, rel_m, overrides, is_urban_aerialway_node=is_urban_aw)
                        if modes:
                            cx, cy = to_utm.transform(clon, clat)
                            if prep_buf_utm.contains(Point(cx, cy)):
                                sa_id = stop_area_of.get(("w", w.id))
                                name = tags.get("name") or (stop_area_name.get(sa_id, "") if sa_id else "")
                                for m in modes:
                                    raw_candidates[m].append(
                                        RawCandidate(
                                            mode=m,
                                            x=cx,
                                            y=cy,
                                            lon=clon,
                                            lat=clat,
                                            name=name,
                                            stop_area_id=sa_id,
                                            priority=prio,
                                        )
                                    )

            walkable, hw_kind, render_street = _is_walkable_way(tags)
            if not walkable:
                continue

            w_nodes = [(nd.ref, nd.lon, nd.lat) for nd in w.nodes if nd.location.valid()]
            if len(w_nodes) < 2:
                continue
            in_any = False
            for _, lon, lat in (w_nodes[0], w_nodes[len(w_nodes) // 2], w_nodes[-1]):
                if buf_minlon <= lon <= buf_maxlon and buf_minlat <= lat <= buf_maxlat:
                    in_any = True
                    break
            if not in_any:
                continue

            local_ids: List[int] = []
            for nid, lon, lat in w_nodes:
                lidx = osm_to_local.get(nid)
                if lidx is None:
                    lidx = len(node_lon_list)
                    osm_to_local[nid] = lidx
                    node_lon_list.append(lon)
                    node_lat_list.append(lat)
                local_ids.append(lidx)

            for i in range(len(local_ids) - 1):
                u, v = local_ids[i], local_ids[i + 1]
                if u != v:
                    edge_u_list.append(u)
                    edge_v_list.append(v)

            if render_street:
                rendered_ways.append((hw_kind, local_ids))

    # Resolve pending aerialway=station nodes against urban cable_car/gondola lines
    for nid, x, y, lon, lat, name, sa_id, rel_m in pending_aerialway_nodes:
        if nid in aerialway_station_nodes or "u" in rel_m:
            raw_candidates["u"].append(
                RawCandidate(
                    mode="u",
                    x=x,
                    y=y,
                    lon=lon,
                    lat=lat,
                    name=name,
                    stop_area_id=sa_id,
                    priority=3,
                )
            )

    # Project all street graph nodes to local UTM in one vectorized C call
    node_lon = np.asarray(node_lon_list, dtype=np.float64)
    node_lat = np.asarray(node_lat_list, dtype=np.float64)
    node_x, node_y = to_utm.transform(node_lon, node_lat)
    node_xy = np.column_stack([node_x, node_y])
    node_lonlat = np.column_stack([node_lon, node_lat])

    edge_u = np.asarray(edge_u_list, dtype=np.int32)
    edge_v = np.asarray(edge_v_list, dtype=np.int32)
    dx = node_x[edge_v] - node_x[edge_u]
    dy = node_y[edge_v] - node_y[edge_u]
    edge_len = np.hypot(dx, dy).astype(np.float32)

    # Deduplicate / merge stations per mode
    all_stations: List[MergedStation] = []
    for mode in MODES:
        merged = _merge_mode_stations(
            candidates=raw_candidates[mode],
            mode=mode,
            subway_entrances=subway_entrances,
            boundary_utm=boundary_utm,
            utm_to_wgs=to_wgs,
            start_id=len(all_stations),
        )
        all_stations.extend(merged)

    return CityOSMData(
        boundary_wgs84=boundary_wgs84,
        boundary_utm=boundary_utm,
        utm_crs=utm_crs,
        stations=all_stations,
        node_xy=node_xy,
        node_lonlat=node_lonlat,
        edge_u=edge_u,
        edge_v=edge_v,
        edge_len=edge_len,
        ways=rendered_ways,
    )
