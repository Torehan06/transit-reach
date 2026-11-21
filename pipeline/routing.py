"""Multi-source walking-distance routing on the OSM street network."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.spatial import cKDTree

MODES = ("m", "t", "c", "b", "f", "u")
MAX_ROUTE_DIST_M = 3600.0  # Covers 2 miles (3219m) + cell snap margin


@dataclass
class MergedStation:
    """A deduplicated transit station for a single mode."""
    station_id: int  # Global index in the city's stations list
    mode: str        # One of MODES: m, t, c, b, f, u
    name: str
    lon: float
    lat: float
    x: float         # Local UTM easting (m)
    y: float         # Local UTM northing (m)
    access_xy: List[Tuple[float, float]]  # Constituent platforms/entrances (UTM m)
    inside_boundary: bool


@dataclass
class RoutingResult:
    """Per-mode walking distances and nearest station IDs for every street graph node."""
    dist_by_mode: Dict[str, Optional[np.ndarray]]     # float32 (N,), inf if unreachable
    station_by_mode: Dict[str, Optional[np.ndarray]]  # int32 (N,), -1 if unreachable
    valid_node_indices: np.ndarray                    # int32 indices of nodes on valid components
    valid_kdtree: cKDTree                             # KDTree on valid street node UTM coords


def find_valid_components(
    n_nodes: int,
    edge_u: np.ndarray,
    edge_v: np.ndarray,
    edge_len: np.ndarray,
    min_nodes: int = 25,
    min_length_m: float = 500.0,
) -> np.ndarray:
    """Return boolean mask of nodes belonging to usable street network components.

    Filters out tiny isolated courtyards/platforms while keeping inhabited islands.
    """
    if n_nodes == 0 or len(edge_u) == 0:
        return np.zeros(n_nodes, dtype=bool)

    rows = np.concatenate([edge_u, edge_v])
    cols = np.concatenate([edge_v, edge_u])
    data = np.ones(len(rows), dtype=np.int8)
    adj = csr_matrix((data, (rows, cols)), shape=(n_nodes, n_nodes))
    n_comp, labels = connected_components(adj, directed=False)

    comp_counts = np.bincount(labels, minlength=n_comp)
    comp_len = np.zeros(n_comp, dtype=np.float64)
    np.add.at(comp_len, labels[edge_u], edge_len)

    good_comps = (comp_counts >= min_nodes) | (comp_len >= min_length_m)
    if not np.any(good_comps):
        # Fallback: keep largest component
        good_comps[int(np.argmax(comp_counts))] = True
    return good_comps[labels]


def compute_walking_distances(
    node_xy: np.ndarray,
    edge_u: np.ndarray,
    edge_v: np.ndarray,
    edge_len: np.ndarray,
    stations: List[MergedStation],
    max_dist_m: float = MAX_ROUTE_DIST_M,
) -> RoutingResult:
    """Compute walking distance and nearest station for every walkable street node per mode."""
    n_nodes = len(node_xy)
    valid_mask = find_valid_components(n_nodes, edge_u, edge_v, edge_len)
    valid_indices = np.where(valid_mask)[0].astype(np.int32)
    valid_kdtree = cKDTree(node_xy[valid_indices])

    # Pre-build undirected street edge arrays (strictly positive weights >= 0.5m)
    pos_len = np.maximum(edge_len.astype(np.float32), 0.5)
    base_rows = np.concatenate([edge_u, edge_v]).astype(np.int32)
    base_cols = np.concatenate([edge_v, edge_u]).astype(np.int32)
    base_data = np.concatenate([pos_len, pos_len])

    dist_by_mode: Dict[str, Optional[np.ndarray]] = {}
    station_by_mode: Dict[str, Optional[np.ndarray]] = {}

    for mode in MODES:
        mode_stations = [s for s in stations if s.mode == mode]
        if not mode_stations:
            dist_by_mode[mode] = None
            station_by_mode[mode] = None
            continue

        k_st = len(mode_stations)
        total_n = n_nodes + k_st

        # Connect each station's virtual node (n_nodes + i) to nearest valid street nodes
        v_rows: List[int] = []
        v_cols: List[int] = []
        v_data: List[float] = []

        for i, st in enumerate(mode_stations):
            v_node = n_nodes + i
            connected = False
            seen_street_nodes: Dict[int, float] = {}

            access_pts = st.access_xy if st.access_xy else [(st.x, st.y)]
            # Query up to 2 nearest street nodes per access point within 250m
            pts_arr = np.asarray(access_pts, dtype=np.float64)
            k_query = min(3, len(valid_indices))
            dists, idxs = valid_kdtree.query(pts_arr, k=k_query, distance_upper_bound=250.0)
            if k_query == 1:
                dists = dists[:, None]
                idxs = idxs[:, None]

            for row_d, row_idx in zip(dists, idxs):
                for d_val, idx_val in zip(row_d, row_idx):
                    if np.isfinite(d_val) and idx_val < len(valid_indices):
                        s_node = int(valid_indices[idx_val])
                        w = max(1.0, float(d_val))
                        if s_node not in seen_street_nodes or w < seen_street_nodes[s_node]:
                            seen_street_nodes[s_node] = w
                        connected = True

            # Fallback up to 600m for piers / hilltop aerialways / suburban terminals
            if not connected:
                d_val, idx_val = valid_kdtree.query([st.x, st.y], k=1, distance_upper_bound=600.0)
                if np.isfinite(d_val) and idx_val < len(valid_indices):
                    s_node = int(valid_indices[idx_val])
                    seen_street_nodes[s_node] = max(1.0, float(d_val))

            for s_node, w in seen_street_nodes.items():
                v_rows.append(v_node)
                v_cols.append(s_node)
                v_data.append(w)
                v_rows.append(s_node)
                v_cols.append(v_node)
                v_data.append(w)

        if not v_rows:
            dist_by_mode[mode] = None
            station_by_mode[mode] = None
            continue

        all_rows = np.concatenate([base_rows, np.asarray(v_rows, dtype=np.int32)])
        all_cols = np.concatenate([base_cols, np.asarray(v_cols, dtype=np.int32)])
        all_data = np.concatenate([base_data, np.asarray(v_data, dtype=np.float32)])

        graph = csr_matrix((all_data, (all_rows, all_cols)), shape=(total_n, total_n))
        source_indices = np.arange(n_nodes, total_n, dtype=np.int32)

        dist_all, _preds, sources = dijkstra(
            graph,
            directed=False,
            indices=source_indices,
            return_predecessors=True,
            min_only=True,
            limit=max_dist_m,
        )

        # Map each reachable street node's closest source virtual node -> global station_id
        st_ids_arr = np.array([st.station_id for st in mode_stations], dtype=np.int32)
        src_street = sources[:n_nodes]
        valid_src = (src_street >= n_nodes) & (src_street < total_n) & np.isfinite(dist_all[:n_nodes])
        nearest_st = np.full(n_nodes, -1, dtype=np.int32)
        nearest_st[valid_src] = st_ids_arr[src_street[valid_src] - n_nodes]

        dist_by_mode[mode] = dist_all[:n_nodes].astype(np.float32)
        station_by_mode[mode] = nearest_st

    return RoutingResult(
        dist_by_mode=dist_by_mode,
        station_by_mode=station_by_mode,
        valid_node_indices=valid_indices,
        valid_kdtree=valid_kdtree,
    )
