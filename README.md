# Latvia Drone Zones

A clean, interactive map of Latvia's UAS (drone) geographical zones, refreshed
daily from the official **ED-269** dataset published by SJSC *“Latvijas gaisa
satiksme”*. Check whether you can fly at a given spot, with live weather,
daylight, and an A3 ground-risk overlay.

**Live site:** https://cobalt910.github.io/latvia-drone-zones/

> ⚠️ **Not for operational use.** Always confirm at
> [airspace.lv](https://airspace.lv/drones/en) and via NOTAM before flying.
> The A3 overlay is an OpenStreetMap-derived aid, not legal proof.

## Features

- **Drone-zone map** — all Latvian UAS geographical zones rendered as a MapLibre
  overlay, coloured by type, with per-zone details (altitude limits, time
  windows, managing authority + contact).
- **Spot check** — long-press anywhere (or open a `?spot=lat,lng` link) to see
  every zone you're inside and whether it's active now.
- **Live weather & daylight** for the checked spot (via Open-Meteo).
- **Address / place search** (via OpenStreetMap Nominatim).
- **Filters** — show active-now zones only, or filter by your intended flight
  altitude (m AGL).
- **A3 ground-risk overlay** — shaded no-fly areas within 150 m of built-up land
  and public roads, for the EU Open-category A3 subcategory.
- **Layers** — Hybrid (satellite) or Light base map, optional 3D height columns.
- **Dark / light theme** (dark by default).
- **Navigation** — share a spot, or open directions in Google Maps or Waze.
- **Installable PWA** — works offline via a service worker.

## How it works

This is a fully **static site** (plain HTML/CSS/vanilla JS, no framework, no app
build step) hosted on GitHub Pages. The map is [MapLibre GL JS](https://maplibre.org/)
loaded from a CDN. All the "live" data is pre-built into static files in `data/`
and refreshed by scheduled GitHub Actions:

| Workflow | Schedule | What it does |
| --- | --- | --- |
| `update-zones.yml` | daily, 04:17 UTC | Fetches the ED-269 zone dataset, converts it to slim GeoJSON, commits if changed, and deploys to Pages. |
| `update-a3.yml` | monthly, 1st @ 03:00 UTC | Rebuilds the A3 ground-risk overlay from the latest OpenStreetMap extract, commits if changed, and deploys. |

If a data fetch fails, the build keeps the last good copy committed in the repo,
so the site never goes dark.

## Project structure

```
index.html               # markup + splash + UI shell
app.js                   # all app logic (map, search, filters, spot check, sheet)
style.css                # styles (dark/light themes)
sw.js                    # service worker (offline / PWA caching)
manifest.webmanifest     # PWA manifest
data/
  zones.geojson          # UAS zones (built from ED-269)
  meta.json              # zone-dataset metadata (counts, source, timestamp)
  a3-exclusion.geojson.gz # A3 ground-risk no-fly overlay (gzipped)
  a3-meta.json           # A3 overlay metadata
scripts/
  build-zones.mjs        # ED-269 JSON -> zones.geojson (Node)
  build-a3.py            # OSM extract -> A3 overlay (Python / geopandas)
.github/workflows/       # daily zones + monthly A3 refresh/deploy
```

## Local development

No build step is needed to run the site — just serve the folder statically:

```sh
npm run serve          # python -m http.server 8000  -> http://localhost:8000
```

Rebuild the data locally (optional):

```sh
npm run build:data     # refresh data/zones.geojson + meta.json from the ED-269 source

# A3 overlay (downloads a large OSM extract; needs geopandas + pyogrio)
pip install geopandas pyogrio
python scripts/build-a3.py
```

## Data sources & credits

- **Zones:** © SJSC *“Latvijas gaisa satiksme”* — ED-269 UAS geographical zones.
- **Base map:** © [OpenStreetMap](https://www.openstreetmap.org/copyright),
  © [CARTO](https://carto.com/attributions); satellite imagery © Esri, Maxar,
  Earthstar Geographics.
- **Weather:** © [Open-Meteo](https://open-meteo.com/).
- **Search:** © OpenStreetMap (Nominatim).
- **A3 overlay:** OpenStreetMap data via [Geofabrik](https://download.geofabrik.de/).

## License

**Proprietary — all rights reserved.** This source is published for viewing
only. You may **not** use, copy, modify, distribute, or create derivative works
from it without prior written permission. See [`LICENSE`](LICENSE).

Third-party data and libraries (ED-269 zone data, OpenStreetMap, CARTO/Esri
basemaps, Open-Meteo, MapLibre GL JS) remain under their own licenses and the
attributions listed above.
