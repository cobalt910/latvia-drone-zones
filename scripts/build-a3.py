#!/usr/bin/env python3
r"""
Build the "A3 ground-risk" overlay for Latvia.

EU Open-category subcategory A3 (Reg. (EU) 2019/947, UAS.OPEN.040) requires the
remote pilot to keep at least **150 m horizontal distance from residential,
commercial, industrial and recreational areas** (and to fly where no uninvolved
person is endangered). The cleanly mappable part of that is a 150 m buffer around
built-up + recreational land.

This script takes every building plus the relevant land-use polygons from the
OpenStreetMap (Geofabrik) Latvia extract, buffers them by 150 m in a metre-based
projection, dissolves the result into one clean (non-overlapping) geometry,
simplifies it, and writes a compact GeoJSON. The shaded area = where A3 is **not**
allowed; everything clear = A3-permissible on the ground (the airspace geozone
layer and the 120 m limit still apply).

  output: data/a3-exclusion.geojson   (+ data/a3-meta.json)

NOT authoritative. OSM is incomplete and "recreational area" is a judgement call —
always confirm visually before flight.

Usage:
  py scripts/build-a3.py --zip path\to\latvia-latest-free.shp.zip
  py scripts/build-a3.py            # downloads the extract itself (CI)
"""

import argparse
import gzip
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone

import numpy as np
import geopandas as gpd
import shapely
from shapely import buffer, union_all, simplify, make_valid, GeometryCollection
from shapely.geometry import mapping

SOURCE_URL = "https://download.geofabrik.de/europe/latvia-latest-free.shp.zip"
METRIC_CRS = "EPSG:3059"   # LKS-92 / Latvia TM — metres, accurate across Latvia
WGS84 = "EPSG:4326"
BUFFER_M = 150.0           # A3 horizontal separation
QUAD_SEGS = 1              # minimal buffer corners — keeps the union small
DEFAULT_SIMPLIFY_M = 25.0  # post-dissolve simplification tolerance (m)
COORD_DECIMALS = 4         # ~11 m — fine for a 150 m advisory, keeps the file small

# Reg (EU) 2019/947, UAS.OPEN.040 has two conditions:
#  (b) keep 150 m from residential/commercial/industrial/recreational AREAS, and
#  (a) keep clear of uninvolved persons.
# We map (b) via land-use zones + buildings + recreational areas. From clause (a)
# we add only public CAR ROADS — constant traffic makes uninvolved persons
# reliably present there. Footpaths/tracks are left out (occupancy unpredictable),
# so that part of (a) remains the pilot's real-time judgement.
LANDUSE_KEEP = {
    "residential", "commercial", "retail", "industrial",  # built-up
    "recreation_ground", "park",                          # recreational
}
# recreational POI areas (leisure / sport / outdoor recreation)
POI_KEEP = {
    "park", "recreation_ground", "pitch", "playground", "sports_centre",
    "sports_hall", "stadium", "swimming_pool", "ice_rink", "fitness_centre",
    "golf_course", "dog_park", "zoo", "theme_park", "picnic_site",
    "camp_site", "caravan_site", "attraction",
}
# recreational natural areas
NATURAL_KEEP = {"beach"}
# Public CAR ROADS only. A road isn't one of the four "areas" in clause (b), but
# its constant traffic means uninvolved persons (clause a) are reliably present,
# so a fixed 150 m buffer is justified. Footpaths/tracks are excluded: their
# occupancy is unpredictable, so that part of clause (a) stays the pilot's call.
ROAD_FCLASSES = {
    "motorway", "motorway_link", "trunk", "trunk_link",
    "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential", "living_street",
}

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")


def log(msg):
    print(msg, flush=True)


def vsizip(zip_path, inner):
    return "/vsizip/" + zip_path.replace("\\", "/") + "/" + inner


def round_coords(obj, nd):
    # mapping() gives nested tuples; round the leaf [x, y] pairs, drop the rest.
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], nd), round(obj[1], nd)]
        return [round_coords(x, nd) for x in obj]
    return obj


def main():
    # Windows consoles default to a legacy codepage (cp1251 here) that can't encode
    # characters like → — force UTF-8 so progress prints never crash the build.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="Geofabrik *-free.shp.zip (downloaded if omitted)")
    ap.add_argument("--out", default=os.path.join(DATA_DIR, "a3-exclusion.geojson"))
    ap.add_argument("--meta", default=os.path.join(DATA_DIR, "a3-meta.json"))
    ap.add_argument("--simplify", type=float, default=DEFAULT_SIMPLIFY_M)
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    t0 = time.time()

    zip_path = args.zip
    tmp = None
    if not zip_path:
        tmp = os.path.join(tempfile.gettempdir(), "latvia-latest-free.shp.zip")
        log(f"Downloading {SOURCE_URL} -> {tmp}")
        urllib.request.urlretrieve(SOURCE_URL, tmp)
        zip_path = tmp
    if not os.path.exists(zip_path):
        log(f"ERROR: extract not found: {zip_path}")
        sys.exit(1)
    log(f"Source: {zip_path}  ({os.path.getsize(zip_path)/1e6:.0f} MB)")

    # ---- read buildings + relevant land use, reproject to metres ----------
    log("Reading buildings...")
    b = gpd.read_file(vsizip(zip_path, "gis_osm_buildings_a_free_1.shp"),
                      columns=["osm_id"])
    log(f"  {len(b):,} buildings  ({time.time()-t0:.0f}s)")

    log("Reading built-up + recreational land use...")
    lu = gpd.read_file(vsizip(zip_path, "gis_osm_landuse_a_free_1.shp"),
                       columns=["fclass"])
    lu = lu[lu["fclass"].isin(LANDUSE_KEEP)]
    log(f"  {len(lu):,} land-use polygons")

    log("Reading recreational POI areas (parks, pitches, playgrounds, ...)...")
    poi = gpd.read_file(vsizip(zip_path, "gis_osm_pois_a_free_1.shp"),
                        columns=["fclass"])
    poi = poi[poi["fclass"].isin(POI_KEEP)]
    log(f"  {len(poi):,} recreational POI areas")

    log("Reading beaches...")
    nat = gpd.read_file(vsizip(zip_path, "gis_osm_natural_a_free_1.shp"),
                        columns=["fclass"])
    nat = nat[nat["fclass"].isin(NATURAL_KEEP)]
    log(f"  {len(nat):,} beach polygons")

    log("Reading public car roads...")
    rd = gpd.read_file(vsizip(zip_path, "gis_osm_roads_free_1.shp"),
                       columns=["fclass"])
    rd = rd[rd["fclass"].isin(ROAD_FCLASSES)]
    log(f"  {len(rd):,} public car-road features")

    log(f"Reprojecting to {METRIC_CRS}...")
    b = b.to_crs(METRIC_CRS)
    lu = lu.to_crs(METRIC_CRS)
    poi = poi.to_crs(METRIC_CRS)
    nat = nat.to_crs(METRIC_CRS)
    rd = rd.to_crs(METRIC_CRS)

    geoms = np.concatenate([
        b.geometry.values, lu.geometry.values, poi.geometry.values,
        nat.geometry.values, rd.geometry.values,
    ])
    n_src = len(geoms)
    log(f"  {n_src:,} source features total  ({time.time()-t0:.0f}s)")

    # ---- buffer 150 m + dissolve -----------------------------------------
    # Buffering one combined collection dissolves overlaps in a single GEOS
    # pass — far cheaper than unioning 700k individual buffers.
    log("Cleaning geometry (make_valid)...")
    geoms = make_valid(geoms)

    log(f"Buffering {BUFFER_M:.0f} m (vectorized)...")
    t1 = time.time()
    buffered = buffer(geoms, BUFFER_M, quad_segs=QUAD_SEGS)  # array in -> array out, C-level
    log(f"  buffered {len(buffered):,} polygons  ({time.time()-t1:.0f}s)")

    log("Dissolving (union_all, cascaded — the slow step)...")
    t2 = time.time()
    merged = union_all(buffered)  # one clean, non-overlapping (multi)polygon
    log(f"  dissolve done  ({time.time()-t2:.0f}s)")

    log(f"Simplifying (tolerance {args.simplify:.0f} m)...")
    t3 = time.time()
    # preserve_topology=False = plain Douglas-Peucker: dramatically faster on a
    # country-sized multipolygon, and the rare tiny self-intersection is invisible
    # on a translucent advisory overlay.
    merged = simplify(merged, args.simplify, preserve_topology=False)
    area_km2 = shapely.area(merged) / 1e6
    log(f"  simplified  ({time.time()-t3:.0f}s)")

    # ---- back to WGS84, explode to polygons, write compact GeoJSON --------
    log("Reprojecting to WGS84 + exploding...")
    gs = gpd.GeoSeries([merged], crs=METRIC_CRS).to_crs(WGS84)
    gs = gs.explode(index_parts=False).reset_index(drop=True)
    gs = gs[~gs.is_empty & gs.notna()]
    gdf = gpd.GeoDataFrame(geometry=gs, crs=WGS84)
    n_parts = len(gdf)

    log(f"Writing {n_parts:,} polygons -> GeoJSON...")
    if os.path.exists(args.out):
        os.remove(args.out)
    # GDAL rounds coordinates to COORD_DECIMALS at write time (C-level) — far
    # faster than a Python coordinate walk, and keeps the file small.
    gdf.to_file(args.out, driver="GeoJSON", engine="pyogrio",
                COORDINATE_PRECISION=str(COORD_DECIMALS))

    # Ship only a gzipped copy — the client decompresses it via the built-in
    # DecompressionStream. ~4x smaller committed file (matters for the monthly
    # auto-rebuild) with no loss of detail.
    raw_kb = os.path.getsize(args.out) / 1024
    gz_path = args.out + ".gz"
    with open(args.out, "rb") as fin, gzip.open(gz_path, "wb", compresslevel=9) as fout:
        shutil.copyfileobj(fin, fout)
    os.remove(args.out)

    meta = {
        "rule": "EU Open A3 (UAS.OPEN.040): 150 m from residential/commercial/industrial/recreational areas + public car roads",
        "bufferMeters": BUFFER_M,
        "sourceBuildings": int(len(b)),
        "sourceLanduse": int(len(lu)),
        "sourceRecreationPois": int(len(poi)),
        "sourceBeaches": int(len(nat)),
        "sourceRoads": int(len(rd)),
        "landuseClasses": sorted(LANDUSE_KEEP),
        "recreationPoiClasses": sorted(POI_KEEP),
        "roadClasses": sorted(ROAD_FCLASSES),
        "coverage": "buildings + residential/commercial/industrial/recreational areas + public car roads (footpaths/tracks excluded — situational)",
        "polygonCount": n_parts,
        "excludedAreaKm2": round(area_km2, 1),
        "simplifyMeters": args.simplify,
        "source": "OpenStreetMap via Geofabrik",
        "sourceUrl": SOURCE_URL,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    with open(args.meta, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    gz_kb = os.path.getsize(gz_path) / 1024
    log("")
    log(f"DONE in {time.time()-t0:.0f}s")
    log(f"  polygons: {n_parts:,}  |  excluded area: {area_km2:,.0f} km2")
    log(f"  output:   {gz_path}  ({gz_kb:,.0f} KB gz / {raw_kb:,.0f} KB raw)")

    if tmp and os.path.exists(tmp):
        try:
            os.remove(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    main()
