#!/usr/bin/env node
// Fetch the Latvian UAS geographical-zone dataset (ED-269 JSON, published by
// SJSC "Latvijas gaisa satiksme") and convert it into a slim GeoJSON
// FeatureCollection the static map can load directly.
//
// Run by the daily GitHub Action and locally via `npm run build:data`.
// On a fetch failure it keeps the previously committed data so the site never
// goes dark — it just serves the last good copy.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SOURCE_URL = 'https://drz.lv/api/v1/export-history/UASZoneVersion';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const GEOJSON_PATH = join(DATA_DIR, 'zones.geojson');
const META_PATH = join(DATA_DIR, 'meta.json');

// Round coordinates to 6 decimals (~0.11 m) and drop consecutive duplicates.
// This roughly halves the file with no visible accuracy loss at any zoom.
const round = (n) => Math.round(n * 1e6) / 1e6;
function cleanRing(ring) {
  const out = [];
  let prev = null;
  for (const pt of ring) {
    const p = [round(pt[0]), round(pt[1])];
    if (!prev || p[0] !== prev[0] || p[1] !== prev[1]) out.push(p);
    prev = p;
  }
  return out;
}
function cleanPolygon(coords) {
  return coords.map(cleanRing);
}

const toMs = (s) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

function buildFeatures(dataset) {
  const features = [];
  const seen = new Set(); // drop byte-identical duplicate volumes
  for (const zone of dataset.features || []) {
    const ext = zone.extendedProperties || {};
    const apps = Array.isArray(zone.applicability) ? zone.applicability : [];
    const permanent = apps.length > 0 && apps.every((a) => a.permanent === 'YES');
    // Time windows as [startMs, endMs] pairs, stringified for safe transport.
    const windows = permanent
      ? []
      : apps
          .filter((a) => a.permanent !== 'YES')
          .map((a) => [toMs(a.startDateTime), toMs(a.endDateTime)])
          .filter((w) => w[0] !== null || w[1] !== null);

    // zoneAuthority is a list of authority objects (name/service/email/phone/…)
    const za = (Array.isArray(zone.zoneAuthority) ? zone.zoneAuthority[0] : zone.zoneAuthority) || {};

    const volumes = Array.isArray(zone.geometry) ? zone.geometry : [];
    volumes.forEach((vol, vi) => {
      const hp = vol.horizontalProjection;
      if (!hp || hp.type !== 'Polygon' || !Array.isArray(hp.coordinates)) return;
      const coords = cleanPolygon(hp.coordinates);
      // Skip exact duplicates: same shape + name + restriction + altitude band.
      // (The dataset ships some byte-identical repeated volumes.)
      const dupKey = `${zone.restriction}|${vol.lowerLimit}|${vol.upperLimit}|${zone.name}|${JSON.stringify(coords)}`;
      if (seen.has(dupKey)) return;
      seen.add(dupKey);
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: coords },
        properties: {
          id: zone.identifier,
          vol: vi,
          name: zone.name || zone.identifier,
          restriction: zone.restriction || 'UNKNOWN',
          reason: Array.isArray(zone.reason) ? zone.reason.join(', ') : zone.reason || '',
          lower: vol.lowerLimit ?? null,
          upper: vol.upperLimit ?? null,
          lowerRef: vol.lowerVerticalReference || '',
          upperRef: vol.upperVerticalReference || '',
          uom: vol.uomDimensions || 'M',
          permanent: permanent ? 1 : 0,
          windows: JSON.stringify(windows),
          msgEn: ext.messageEng || '',
          msgLv: zone.message || '',
          authority: za.name || null,
          authService: za.service || null,
          authEmail: za.email || null,
          authPhone: za.phone ? String(za.phone) : null,
          authContact: za.contactName || null,
          authUrl: za.siteUrl || za.siteURL || null,
        },
      });
    });
  }
  return features;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let dataset;
  try {
    console.log(`Fetching ${SOURCE_URL} ...`);
    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': 'AirspaceZones/1.0 (+github actions daily refresh)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dataset = await res.json();
  } catch (err) {
    console.error(`Fetch/parse failed: ${err.message}`);
    if (existsSync(GEOJSON_PATH)) {
      console.error('Keeping previously committed data (last good copy).');
      process.exit(0);
    }
    process.exit(1);
  }

  const features = buildFeatures(dataset);
  if (features.length === 0) throw new Error('No features produced — refusing to overwrite.');

  const fc = { type: 'FeatureCollection', features };
  const meta = {
    title: dataset.title || null,
    crc: dataset.crC32Q || null,
    description: dataset.description || null,
    zoneCount: dataset.zoneCount ?? (dataset.features || []).length,
    volumeCount: features.length,
    sourceUrl: SOURCE_URL,
    generatedAt: new Date().toISOString(),
  };

  let prevCrc = null;
  if (existsSync(META_PATH)) {
    try {
      prevCrc = JSON.parse(await readFile(META_PATH, 'utf8')).crc;
    } catch {}
  }

  await writeFile(GEOJSON_PATH, JSON.stringify(fc));
  await writeFile(META_PATH, JSON.stringify(meta, null, 2));

  const kb = (Buffer.byteLength(JSON.stringify(fc)) / 1024).toFixed(0);
  console.log(`Zones: ${meta.zoneCount} | volumes: ${meta.volumeCount} | ${kb} KB`);
  console.log(`Export: ${meta.title} | CRC ${meta.crc}${prevCrc === meta.crc ? ' (unchanged)' : ' (CHANGED)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
