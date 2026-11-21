# Transit Reach

Interactive static web app showing how much of each city—and how many of its residents—are within walking distance of rail and rapid transit across **65 global cities**.

- **Street-network walking distance** (not straight-line circles) from 0 to 2 miles (0 to 3.22 km), with instant client-side slider updates and a `mi` / `km` toggle
- **6 toggleable transit modes**: Metro / Subway, Tram / Light Rail, Commuter / Regional Rail, BRT, Ferry, and Funicular / Cable Car (with duplicate OSM station/platform nodes merged per mode)
- **Zoom-adaptive population dot-density layer** built from GHSL GHS-POP 2025 (100 m equal-area grid), with fixed deterministic dot positions colored covered vs. uncovered and live people-per-dot scaling (`500` → `250` → `125` → `25` people/dot)
- **Side-by-side & ranked comparison** across comparable city-proper boundaries grouped into 5 continents, for any combination of distance and transit modes
- **Tap or click anywhere** inside a city to inspect walking distance to the nearest station and highlight it on the map

---

## Running Locally

### Frontend
Generated city data (`public/data/`) is not committed to git; it is distributed via GitHub Releases. To run locally, either run the pipeline below or download the latest data release into `public/`:

```bash
gh release download data-v2 --pattern transit-reach-data.tar --dir /tmp
tar -xf /tmp/transit-reach-data.tar -C public
```

Then start the dev server:
```bash
npm install
npm run dev
```

Production build & preview:
```bash
npm run build
npm run preview
```

### Offline Data Pipeline
Requires Python 3.12+, `tippecanoe` / `tile-join` (v2.17+ with PMTiles support), and `osmium-tool`.

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt

# Build one or more cities
.venv/bin/python pipeline/build_city.py ankara istanbul new-york

# Build all 65 cities (cleaning up cached PBFs after each city)
.venv/bin/python pipeline/build_city.py --all --cleanup
```

Adding a new city requires only one config entry in [`cities.json`](cities.json) and re-running `pipeline/build_city.py <city_id>`.

### Publishing a New Data Release
Because generated `.pmtiles`, station JSONs, and `summary.json` total ~325 MB across all 65 cities, `public/data/` is gitignored and hosted as a single archive (`transit-reach-data.tar`) on a GitHub Release downloaded by [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) at build time.

To publish updated city data (for example, `data-v3`):
```bash
# 1. Pack public/data/ into a tar archive (.pmtiles are already compressed internally)
tar -cf /tmp/transit-reach-data.tar -C public data

# 2. Create a new GitHub Release and upload the archive
gh release create data-v3 /tmp/transit-reach-data.tar \
  --title "City Data v3" \
  --notes "Updated PMTiles, station lists, and coverage curves for all configured cities."

# 3. Point deploy.yml at the new tag, commit, and push to main
#    Update DATA_RELEASE_TAG: data-v3 in .github/workflows/deploy.yml
rm -f /tmp/transit-reach-data.tar
```

---

## Methodology & OSM Tagging Calls

- **Walking network**: All pedestrian-accessible OpenStreetMap ways within a 3.5 km buffer of each city boundary (so stations just outside the border still serve residents inside). Walking distances are precomputed via multi-source Dijkstra per mode (`scipy.sparse.csgraph.dijkstra`) up to 3.6 km and packaged into one PMTiles file per city (`public/data/tiles/<city_id>.pmtiles`). Low-zoom vector tiles (`z8–z11`) thin streets by road class and cap tile sizes while preserving exact population dot densities and full street detail when zoomed in.
- **Station deduplication**: Duplicate OSM station nodes, `stop_position` nodes, platforms, and `public_transport=stop_area` members belonging to the same station and mode are merged into a single station while preserving constituent entrances/platforms as routing access points.
- **Population & area**: Computed on GHSL GHS-POP 2025 (`GHS_POP_E2025_GLOBE_R2023A_54009_100`, 100 m × 100 m equal-area Mollweide grid). Ocean/open-water `nodata` cells (`-200`) are excluded; inland/estuary cells within OSM municipal boundaries are retained uniformly across cities. Nearly all cities match official figures within ±15%. A few cities show known GHSL R2023A allocation divergence despite exact administrative boundaries:
  - **Shanghai (`+47%`) & Beijing (`+26%`)**: GHSL distributes municipal population by built-up building volume (`GHS-BUILT-V`), concentrating extra population into high-rise central districts (especially Pudong/Puxi and inner Beijing) relative to registered census counts.
  - **Bursa (`+16.2%`), Astana (`-17.9%`), Shymkent (`+19.5%`)**: Rapid recent demographic growth relative to GHSL R2023A's 2025 projection.
  - **Mexico City (`-15.6%`)**: Modest GHSL under-allocation in dense low/mid-rise neighborhoods inside CDMX's 16 alcaldías.
- **Sparse OSM street coverage in China (Shanghai & Beijing)**: OpenStreetMap's pedestrian/compound street network in Shanghai (~190 segments/km²) and Beijing (~155 segments/km²) is noticeably sparser than in Tokyo, Seoul, or Taipei (~350–600 segments/km²), especially inside gated residential compounds (*xiaoqu*) and hutong alleys. Both cities are included with an explicit in-app notice; their walking distances and coverage figures should be read as conservative lower-bound estimates.
- **Notable OSM mode classification calls**:
  - **Ankara**: Ankaray (A1) is tagged `light_rail` in OSM and classified under Tram / Light Rail; M1–M4 are Metro; Başkentray is Commuter Rail; Yenimahalle–Şentepe Teleferik is Funicular / Cable Car.
  - **Istanbul**: İETT Metrobüs (`network=Metrobus`, 44 stations) is classified as BRT while regular İETT feeder buses mentioning Metrobüs in destination names are excluded. Marmaray is Commuter Rail; Şehir Hatları / İDO / Turyol / Dentur piers are Ferries; F1–F4 and TF1–TF2 are Funicular / Cable Car.
  - **Astana**: Astana LRT (*Tarlan Astana*, opened to passengers in May 2026, 18 Phase 1 stations from Airport to Nurly Zhol) is included under Tram / Light Rail (including an override for `construction` tags if present, excluding the unopened Phase 2 Qosshy extension). Two LRT platform/station ways in OSM (`way/1531992951` at Әуежай and `way/1531992956` at Ұлы Дала) carry `subway=yes`; these are reclassified from Metro to Tram / Light Rail since Astana has no metro.
  - **Almaty**: Almaty Metro is Metro; Kok-Tobe / Shymbulak aerialways are Funicular / Cable Car.
  - **Boston**: MBTA Silver Line (`SL1`–`SL5`) is classified as BRT; Green Line and Mattapan Trolley are Tram / Light Rail; Red/Orange/Blue are Metro.
  - **Los Angeles**: Metro G (Orange) and J (Silver) Lines are classified as BRT; B/D Lines are Metro; A/C/E/K Lines are Light Rail; Angels Flight is Funicular.
  - **New York**: MTA Select Bus Service (SBS) operates largely in curbside lanes without full grade separation and is not classified as BRT. JFK AirTrain is under Tram / Light Rail; NYC Subway + Staten Island Railway are Metro; LIRR + Metro-North are Commuter Rail; Roosevelt Island Tramway is Funicular / Cable Car.
  - **San Francisco**: Historic Muni Cable Cars are classified under Funicular / Cable Car; BART is Metro; Muni Metro and F Market streetcar are Tram / Light Rail; Caltrain is Commuter Rail.
  - **Vancouver**: SkyTrain (Expo, Millennium, Canada Lines) is classified as Metro rather than Light Rail via a city override in `cities.json`.
  - **Ottawa**: O-Train Lines 1/2/4 are Tram / Light Rail; remaining dedicated Transitway stations are classified as BRT.
  - **Seattle**: Link Light Rail, Seattle Streetcar, and Seattle Center Monorail are classified under Tram / Light Rail as tagged in OSM; RapidRide arterial buses are excluded from BRT.
  - **Mexico City**: Metrobús (7 corridors, ~247 stations) is classified as BRT; Cablebús lines are Funicular / Cable Car; Tren Ligero is Tram / Light Rail; Tren Suburbano is Commuter Rail; STC Metro is Metro.
  - **Rio de Janeiro**: MOBI-Rio BRT corridors (TransOeste, TransCarioca, TransOlímpica, TransBrasil) are classified as BRT; VLT Carioca is Tram / Light Rail; SuperVia is Commuter Rail; MetrôRio is Metro; Guanabara Bay ferries are Ferry; Sugarloaf / Santa Teresa / Corcovado aerialways & funiculars are Funicular / Cable Car.
  - **Sydney & Melbourne**: Australian state capitals have very small central-CBD municipalities (e.g. City of Sydney is only 26 km²), so contiguous inner & middle metropolitan Local Government Areas (19 LGAs in Sydney, 17 LGAs in Melbourne) are unioned to match the urban footprint of peer cities. Melbourne's suburban rail network (`Metro Trains Melbourne`) is tagged `railway=station` / commuter rail in OSM, alongside its 760+ tram stops.
  - **London / Tokyo / Osaka / Berlin / Vienna / Moscow / Seoul / Singapore / Hong Kong / Dubai**: Automated/elevated people movers and light metros (e.g., London DLR, Tokyo Yurikamome/Monorail, Osaka New Tram, Singapore LRT, Dubai Palm Monorail, Miami Metromover, Montreal REM) follow their OSM `light_rail`/`monorail` tagging under Tram / Light Rail, while heavy underground/urban metro lines are Metro and suburban/regional networks (Overground/National Rail, JR/private railways, S-Bahn, RER, MCD/Elektrichka, Cercanías, Rodalies, GO Transit, Metra, CPTM, SuperVia) are Commuter Rail.

---

## City Boundaries (All 65 Cities)

Comparable "the city itself" administrative boundaries are used across all 65 cities. In Türkiye, metropolitan municipalities span entire mostly-rural provinces, so the central urban districts (*merkez ilçeler*) are used instead; analogous urban-core district groupings are used for Shanghai, Beijing, Moscow, Athens, Baku, Santiago, Sydney, and Melbourne.

| Continent | City | Country | Boundary Chosen |
| --- | --- | --- | --- |
| Europe | Vienna | Austria | City and State of Vienna (*Stadt Wien*, 23 districts) |
| Europe | Brussels | Belgium | Brussels-Capital Region (19 municipalities) |
| Europe | Prague | Czechia | Capital City of Prague (*Hlavní město Praha*) |
| Europe | Copenhagen | Denmark | Copenhagen and Frederiksberg municipalities (Frederiksberg enclave included) |
| Europe | Paris | France | City of Paris (*Ville de Paris*, 20 arrondissements) |
| Europe | Berlin | Germany | State of Berlin (*Land Berlin*) |
| Europe | Frankfurt | Germany | City of Frankfurt am Main (*Stadt Frankfurt am Main*) |
| Europe | Hamburg | Germany | Free and Hanseatic City of Hamburg (mainland & Elbe, excluding offshore Neuwerk) |
| Europe | Munich | Germany | City of Munich (*Stadt München*) |
| Europe | Athens | Greece | Athens–Piraeus Urban Area (Central, North, South, West Athens & Piraeus Regional Units) |
| Europe | Milan | Italy | Municipality of Milan (*Comune di Milano*) |
| Europe | Rome | Italy | Municipality of Rome (*Roma Capitale*) |
| Europe | Amsterdam | Netherlands | Municipality of Amsterdam (*Gemeente Amsterdam*) |
| Europe | Warsaw | Poland | Capital City of Warsaw (*Miasto Stołeczne Warszawa*) |
| Europe | Lisbon | Portugal | Municipality of Lisbon (*Município de Lisboa*) |
| Europe | Moscow | Russia | 9 urban administrative okrugs of Old Moscow (excluding rural New Moscow and Zelenograd exclave) |
| Europe | Barcelona | Spain | Municipality of Barcelona (*Municipi de Barcelona*) |
| Europe | Madrid | Spain | Municipality of Madrid (*Municipio de Madrid*) |
| Europe | Stockholm | Sweden | City of Stockholm (*Stockholms kommun*) |
| Europe | Zurich | Switzerland | City of Zurich (*Stadt Zürich*) |
| Europe | Istanbul | Türkiye | 36 urban districts of Istanbul Province (excluding outlying rural Çatalca, Silivri, and Şile) |
| Europe | London | United Kingdom | Greater London (32 boroughs + City of London) |
| Asia | Baku | Azerbaijan | City of Baku urban core (excludes rural Absheron Peninsula settlements) |
| Asia | Beijing | China | 6 central urban districts (Dongcheng, Xicheng, Chaoyang, Haidian, Fengtai, Shijingshan) |
| Asia | Shanghai | China | 8 central urban districts (Huangpu, Xuhui, Changning, Jing'an, Putuo, Hongkou, Yangpu, Pudong New Area; land-only subdistricts) |
| Asia | Tbilisi | Georgia | City of Tbilisi (Tbilisi Municipality) |
| Asia | Hong Kong | Hong Kong | Hong Kong Special Administrative Region (all 18 districts) |
| Asia | Delhi | India | National Capital Territory of Delhi (NCT Delhi) |
| Asia | Osaka | Japan | City of Osaka (24 wards) |
| Asia | Tokyo | Japan | Tokyo 23 Special Wards (*Tokubetsu-ku*) |
| Asia | Almaty | Kazakhstan | City of Almaty (City of Republican Significance) |
| Asia | Astana | Kazakhstan | City of Astana (City of Republican Significance) |
| Asia | Shymkent | Kazakhstan | City of Shymkent (City of Republican Significance) |
| Asia | Singapore | Singapore | Republic of Singapore (main island & inhabited coastal islands) |
| Asia | Seoul | South Korea | Seoul Special City |
| Asia | Taipei | Taiwan | Taipei City (12 districts) |
| Asia | Ankara | Türkiye | 8 central urban districts (Altındağ, Çankaya, Etimesgut, Keçiören, Mamak, Pursaklar, Sincan, Yenimahalle) |
| Asia | Bursa | Türkiye | 3 central urban districts (Nilüfer, Osmangazi, Yıldırım) |
| Asia | Eskişehir | Türkiye | 2 central urban districts (Odunpazarı, Tepebaşı) |
| Asia | Kayseri | Türkiye | 3 central urban districts (Kocasinan, Melikgazi, Talas) |
| Asia | Konya | Türkiye | 3 central urban districts (Karatay, Meram, Selçuklu) |
| Asia | İzmir | Türkiye | 11 central urban districts (Balçova, Bayraklı, Bornova, Buca, Çiğli, Gaziemir, Güzelbahçe, Karabağlar, Karşıyaka, Konak, Narlıdere) |
| Asia | Dubai | United Arab Emirates | Emirate of Dubai (urban & coastal territory, excluding inland Hatta exclave) |
| North America | Edmonton | Canada | City of Edmonton |
| North America | Montreal | Canada | Agglomeration of Montreal (Island of Montreal, including enclave municipalities) |
| North America | Ottawa | Canada | City of Ottawa |
| North America | Toronto | Canada | City of Toronto |
| North America | Vancouver | Canada | City of Vancouver |
| North America | Mexico City | Mexico | Mexico City (*Ciudad de México*, 16 alcaldías) |
| North America | Boston | United States | City of Boston |
| North America | Chicago | United States | City of Chicago |
| North America | Houston | United States | City of Houston |
| North America | Los Angeles | United States | City of Los Angeles |
| North America | Miami | United States | City of Miami |
| North America | New York | United States | New York City (5 boroughs) |
| North America | Philadelphia | United States | City and County of Philadelphia |
| North America | San Francisco | United States | City and County of San Francisco (mainland & bay islands, excluding Farallon Islands) |
| North America | Seattle | United States | City of Seattle |
| North America | Washington DC | United States | District of Columbia |
| South America | Buenos Aires | Argentina | Autonomous City of Buenos Aires (CABA) |
| South America | Rio de Janeiro | Brazil | Municipality of Rio de Janeiro (*Município do Rio de Janeiro*) |
| South America | São Paulo | Brazil | Municipality of São Paulo (*Município de São Paulo*) |
| South America | Santiago | Chile | Greater Santiago (32 contiguous urban comunas: Provincia de Santiago excl. mountain Lo Barnechea, plus Puente Alto) |
| Oceania | Melbourne | Australia | 17 inner & middle metropolitan LGAs of Melbourne (City of Melbourne to Darebin, Boroondara, Monash, Bayside, Brimbank & Hobsons Bay) |
| Oceania | Sydney | Australia | 19 inner & middle metropolitan LGAs of Sydney (City of Sydney to Parramatta, Ryde, Chatswood, Canterbury-Bankstown & Randwick) |

---

## Data Attribution & Licenses

- **Basemap tiles**: [OpenFreeMap](https://openfreemap.org) (based on OpenStreetMap data)
- **Streets, boundaries & transit stations**: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), built from [BBBike](https://download.bbbike.org/osm/bbbike/) and [Geofabrik](https://download.geofabrik.de/) `.osm.pbf` extracts
- **Population grid**: Schiavina M., Freire S., Carioli A., MacManus K. (2023): *GHS-POP R2023A - GHS population grid multitemporal (1975-2030)*. European Commission, Joint Research Centre (JRC). DOI: [10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE](https://doi.org/10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE). Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
