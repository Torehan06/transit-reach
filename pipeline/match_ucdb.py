"""Match each configured city to the GHS-UCDB R2024A urban centre containing its centre.
Writes pipeline/ucdb_cities.json: {city_id: {uc_id, uc_name, uc_pop, uc_km2, geom (GeoJSON, WGS84, simplified)}}."""
import json, sqlite3, sys
from pathlib import Path
import pyproj
from shapely import wkb
from shapely.geometry import Point, mapping
from shapely.ops import transform
ROOT = Path(__file__).resolve().parents[1]
gpkg = ROOT / 'cache/ucdb/GHS_UCDB_GLOBE_R2024A.gpkg'
cities = json.load(open(ROOT / 'cities.json'))
summary = json.load(open(ROOT / 'public/data/summary.json'))['cities']
extra = {c['id']: c['_center'] for c in json.load(open(ROOT / 'cache/probe_cities5.json'))}
to_moll = pyproj.Transformer.from_crs('EPSG:4326', 'ESRI:54009', always_xy=True)
to_wgs = pyproj.Transformer.from_crs('ESRI:54009', 'EPSG:4326', always_xy=True)
con = sqlite3.connect(gpkg)
T = 'GHSL_UCDB_THEME_GENERAL_CHARACTERISTICS_GLOBE_R2024A'
rows = []
for gid, blob, name, cnt, km2, pop in con.execute(f'select ID_UC_G0, geom, GC_UCN_MAI_2025, GC_CNT_GAD_2025, GC_UCA_KM2_2025, GC_POP_TOT_2025 from {T}'):
    # GeoPackage binary: magic(2) ver(1) flags(1) srs(4) envelope(var) then WKB
    flags = blob[3]
    env = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    g = wkb.loads(bytes(blob[8 + env:]))
    rows.append((gid, g, name, cnt, km2, pop))
print('UCs', len(rows), file=sys.stderr)
import unicodedata
def fold(t):
    t = unicodedata.normalize('NFKD', t or '').encode('ascii', 'ignore').decode().lower()
    return ''.join(ch for ch in t if ch.isalnum() or ch == ' ').strip()
ALIAS = {'kocaeli': 'kocaeli|izmit', 'washington-dc': 'washington', 'new-york': 'new york', 'tel-aviv': 'tel aviv',
         'ho-chi-minh-city': 'ho chi minh', 'dar-es-salaam': 'dar es', 'mexico-city': 'mexico city',
         'kyiv': 'kyiv|kiev', 'bengaluru': 'bengaluru|bangalore', 'chennai': 'chennai|madras', 'mumbai': 'mumbai|bombay',
         'delhi': 'delhi', 'naples': 'napoli|naples', 'turin': 'torino|turin', 'antwerp': 'antwerp|antwerpen',
         'cologne': 'cologne|koln', 'munich': 'munich|munchen', 'lisbon': 'lisbon|lisboa', 'prague': 'prague|praha',
         'warsaw': 'warsaw|warszawa', 'krakow': 'krakow', 'bucharest': 'bucharest|bucuresti', 'belgrade': 'belgrade|beograd',
         'rome': 'rome|roma', 'milan': 'milan|milano', 'vienna': 'vienna|wien', 'brussels': 'brussels|bruxelles',
         'copenhagen': 'copenhagen|kobenhavn', 'athens': 'athens|athina', 'saint-petersburg': 'petersburg',
         'nizhny-novgorod': 'nizhn', 'kinshasa': 'kinshasa', 'cairo': 'cairo|qahira', 'alexandria': 'alexandria|iskandariyah',
         'riyadh': 'riyadh', 'sanliurfa': 'urfa', 'diyarbakir': 'diyarbakir', 'fort-lauderdale': 'miami|fort lauderdale',
         'kawasaki': 'tokyo', 'yokohama': 'tokyo', 'kobe': 'osaka|kobe', 'shenzhen': 'shenzhen',
         'addis-ababa': 'addis', 'quito': 'quito', 'panama-city': 'panama', 'santo-domingo': 'santo domingo',
         'zurich': 'zurich', 'dusseldorf': 'dusseldorf', 'cape-town': 'cape town', 'ankara': 'ankara',
         'ottawa': 'ottawa', 'tekirdag': 'tekirdag|corlu|suleymanpasa', 'yozgat': 'yozgat'}
DOWNTOWN = {'kyoto': (135.768, 35.011), 'cape-town': (18.424, -33.925), 'shenzhen': (114.057, 22.543)}
out = {}
ids = {c['id'] for c in cities}
names = {c['id']: c['name'] for c in cities}
names.update({c['id']: c['name'] for c in json.load(open(ROOT / 'cache/probe_cities5.json'))})
for c in cities + [{'id': k} for k in extra if k not in ids]:
    cid = c['id']
    ctr = summary.get(cid, {}).get('center') or extra.get(cid) or ([(c['bbox'][0]+c['bbox'][2])/2, (c['bbox'][1]+c['bbox'][3])/2] if c.get('bbox') else None)
    if not ctr:
        print('no center', cid, file=sys.stderr); continue
    if cid in DOWNTOWN: ctr = DOWNTOWN[cid]
    p = Point(*to_moll.transform(*ctr))
    pats = ALIAS.get(cid, fold(names[cid])).split('|')
    near = [r for r in rows if r[1].distance(p) < 60000]
    named = [r for r in near if any(pt in fold(r[2]) for pt in pats)]
    if named:
        hit = min(named, key=lambda r: (r[1].distance(p), -r[5]))
    else:
        cont = [r for r in near if r[1].contains(p)]
        hit = cont[0] if cont else None
    if not hit:
        out[cid] = None; print('NO UC', cid, [ (r[2], int(r[5])) for r in sorted(near, key=lambda r:-r[5])[:4]], file=sys.stderr); continue
    gid, g, name, cnt, km2, pop = hit
    gw = transform(to_wgs.transform, g).simplify(0.002, preserve_topology=True)
    out[cid] = {'uc_id': int(gid), 'uc_name': name, 'uc_country': cnt, 'uc_km2': round(km2, 1), 'uc_pop': int(pop), 'geom': mapping(gw)}
json.dump(out, open(ROOT / 'pipeline/ucdb_cities.json', 'w'), separators=(',', ':'), ensure_ascii=False)
for cid, v in out.items():
    print(cid, 'MATCH' , v and v['uc_id'], v and v['uc_name'], v and v['uc_pop'], v and v['uc_km2'], (summary.get(cid) or {}).get('ghsl_pop'))
