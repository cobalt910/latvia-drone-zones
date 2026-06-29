'use strict';

/* ------------------------------------------------------------------ *
 * Latvia Drone Zones — interactive map of UAS geographical zones.
 * Data: official ED-269 export, slimmed to data/zones.geojson by the
 * daily build script. Base maps are free, key-less raster tiles.
 * ------------------------------------------------------------------ */

const RESTRICTIONS = [
  { key: 'PROHIBITED',       label: 'Prohibited',           color: '#d11149' },
  { key: 'REQ_AUTHORISATION', label: 'Authorisation req.',  color: '#ef6c00' },
  { key: 'CONDITIONAL',      label: 'Conditional',          color: '#f5c518' },
  { key: 'NO_RESTRICTION',   label: 'No restriction',       color: '#2e9e5b' },
  { key: 'UNKNOWN',          label: 'Other',                color: '#8a94a3' },
];
const COLOR_OF = Object.fromEntries(RESTRICTIONS.map((r) => [r.key, r.color]));
const SEVERITY = { PROHIBITED: 4, REQ_AUTHORISATION: 3, CONDITIONAL: 2, NO_RESTRICTION: 1, UNKNOWN: 0 };
const CAA_APPLY = 'https://e.caa.gov.lv/uas-operations';

// MapLibre color expression: restriction -> fill color.
const colorExpr = ['match', ['get', 'restriction']];
for (const r of RESTRICTIONS) colorExpr.push(r.key, r.color);
colorExpr.push('#8a94a3'); // default

// Brighter ramp used over the near-black base map — the canonical colours go
// muddy at low opacity on black, these read as clean glows.
const DARK_COLORS = {
  PROHIBITED: '#ff4d6d', REQ_AUTHORISATION: '#ff9a3d', CONDITIONAL: '#ffd24a',
  NO_RESTRICTION: '#3ddc84', UNKNOWN: '#aab4c2',
};
const colorExprDark = ['match', ['get', 'restriction']];
for (const r of RESTRICTIONS) colorExprDark.push(r.key, DARK_COLORS[r.key] || r.color);
colorExprDark.push('#aab4c2');

const CARTO_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>';
const ESRI_ATTR = 'Imagery © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';

/* ---------- base style (raster basemaps, toggled by visibility) ---------- */
const style = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    'carto-dark': {
      type: 'raster', tileSize: 256, attribution: CARTO_ATTR,
      tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
    },
    'carto-light': {
      type: 'raster', tileSize: 256, attribution: CARTO_ATTR,
      tiles: ['https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'],
    },
    'carto-dark-labels': {
      type: 'raster', tileSize: 256, attribution: CARTO_ATTR,
      tiles: ['https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png'],
    },
    'esri-imagery': {
      type: 'raster', tileSize: 256, attribution: ESRI_ATTR,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    },
  },
  layers: [
    // default = Hybrid (imagery + labels). b-dark / b-light kept but hidden so
    // the Dark/Satellite base maps can be re-enabled later by adding buttons back.
    { id: 'b-dark',    type: 'raster', source: 'carto-dark', layout: { visibility: 'none' },
      paint: { 'raster-brightness-min': 0.3, 'raster-contrast': 0.12, 'raster-saturation': 0.2 } },
    { id: 'b-imagery', type: 'raster', source: 'esri-imagery' },
    { id: 'b-light',   type: 'raster', source: 'carto-light',       layout: { visibility: 'none' } },
    { id: 'b-labels',  type: 'raster', source: 'carto-dark-labels' },
  ],
};

const BASEMAPS = {
  dark:      { 'b-dark': 1, 'b-imagery': 0, 'b-light': 0, 'b-labels': 0 },
  satellite: { 'b-dark': 0, 'b-imagery': 1, 'b-light': 0, 'b-labels': 0 },
  hybrid:    { 'b-dark': 0, 'b-imagery': 1, 'b-light': 0, 'b-labels': 1 },
  light:     { 'b-dark': 0, 'b-imagery': 0, 'b-light': 1, 'b-labels': 0 },
};

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [24.6, 56.88],
  zoom: 6.6,
  maxZoom: 18,
  attributionControl: false,
  hash: true, // shareable URL: #zoom/lat/lng
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserHeading: true,
});
map.addControl(geolocate, 'bottom-right');
// Run the spot check only on an explicit locate request (button / trigger), not
// on every passive tracking update — otherwise the card reopens after you close it.
let geoRequested = false, lastGps = null;
geolocate.on('trackuserlocationstart', () => { geoRequested = true; });
geolocate.on('geolocate', (e) => {
  lastGps = { lng: e.coords.longitude, lat: e.coords.latitude };
  if (!geoRequested) return; // ignore passive tracking updates
  geoRequested = false;
  placeSpot(lastGps, { gps: true });
});

/* ---------- state ---------- */
const enabled = new Set(RESTRICTIONS.map((r) => r.key)); // visible restrictions
let activeOnly = false;
let altCap = Infinity; // altitude filter off until the user enables it
let is3D = false;
let allFeatures = [];

// Zones read very differently over a near-black base vs bright imagery, so the
// fill opacity / outline weight track the active base map (not the UI theme):
// a dark base needs faint fills + bright borders or the overlaps turn to mush.
let currentBase = 'hybrid';
const FILL_BY_BASE = { dark: 0.12, satellite: 0.30, hybrid: 0.30, light: 0.30 };
const LINE_BY_BASE = { dark: 1.7, satellite: 1.1, hybrid: 1.1, light: 1.0 };
function applyZoneStyleForBase(base) {
  if (!map.getLayer('zones-fill')) return;
  const fo = FILL_BY_BASE[base] ?? 0.16;
  const lw = LINE_BY_BASE[base] ?? 1.4;
  const expr = base === 'dark' ? colorExprDark : colorExpr;
  map.setPaintProperty('zones-fill', 'fill-color', expr);
  map.setPaintProperty('zones-line', 'line-color', expr);
  if (map.getLayer('zones-3d')) map.setPaintProperty('zones-3d', 'fill-extrusion-color', expr);
  map.setPaintProperty('zones-fill', 'fill-opacity', fo);
  map.setPaintProperty('zones-line', 'line-width', lw);
  map.setPaintProperty('zones-line', 'line-opacity', base === 'dark' ? 1 : 0.9);
}

/* ---------- helpers ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s)]+)/g,
  '<a href="$1" target="_blank" rel="noopener">$1</a>');
const fmtDate = (ms) => ms == null ? '—' : new Date(ms).toLocaleDateString('en-GB',
  { day: '2-digit', month: 'short', year: 'numeric' });
const labelOf = (k) => (RESTRICTIONS.find((r) => r.key === k) || {}).label || k;
const needsAuth = (r) => r === 'REQ_AUTHORISATION' || r === 'CONDITIONAL';
const applyBtn = (r) => needsAuth(r)
  ? `<a class="apply" href="${CAA_APPLY}" target="_blank" rel="noopener">Apply / check with CAA ↗</a>` : '';

// authority block: who manages the zone + clickable email / phone
function authorityHtml(p) {
  if (!p.authority && !p.authEmail && !p.authPhone) return '';
  const row = (k, v) => `<div class="zp-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const name = `${esc(p.authority || 'Authority')}${p.authService ? ` <span class="muted">· ${esc(p.authService)}</span>` : ''}`;
  return row('Authority', name)
    + (p.authContact ? row('Contact', esc(p.authContact)) : '')
    + (p.authEmail ? row('Email', `<a href="mailto:${esc(p.authEmail)}">${esc(p.authEmail)}</a>`) : '')
    + (p.authPhone ? row('Phone', `<a href="tel:${esc(String(p.authPhone).replace(/\s+/g, ''))}">${esc(p.authPhone)}</a>`) : '')
    + (p.authUrl ? row('Web', `<a href="${esc(p.authUrl)}" target="_blank" rel="noopener">${esc(p.authUrl)}</a>`) : '');
}

function isActive(p, now) {
  if (p.permanent === 1) return true;
  let wins;
  try { wins = JSON.parse(p.windows || '[]'); } catch { wins = []; }
  if (!wins.length) return true; // no window info -> assume active
  return wins.some(([s, e]) => (s == null || now >= s) && (e == null || now <= e));
}

// JS mirror of the MapLibre filter, for counting.
function passes(p) {
  if (!enabled.has(p.restriction in COLOR_OF ? p.restriction : 'UNKNOWN')) return false;
  if (activeOnly && p.activeNow !== 1) return false;
  if (isFinite(altCap) && (p.lower ?? 0) > altCap) return false;
  return true;
}

function mapFilter() {
  const f = ['all', ['in', ['get', 'restriction'], ['literal', [...enabled]]]];
  if (activeOnly) f.push(['==', ['get', 'activeNow'], 1]);
  if (isFinite(altCap)) f.push(['<=', ['coalesce', ['get', 'lower'], 0], altCap]);
  return f;
}

function applyFilter() {
  const f = mapFilter();
  for (const id of ['zones-fill', 'zones-line', 'zones-3d']) {
    if (map.getLayer(id)) map.setFilter(id, f);
  }
  const shown = allFeatures.reduce((n, ft) => n + (passes(ft.properties) ? 1 : 0), 0);
  document.getElementById('zoneCount').textContent = `· ${shown} of ${allFeatures.length}`;
}

/* ---------- detail bottom sheet (zone taps + spot checks share one sheet) ---------- */
const sheet = document.getElementById('sheet');
const sheetBody = document.getElementById('sheetBody');
const sheetShare = document.getElementById('sheetShare');
const sheetTop = sheet.querySelector('.sheet-top');

// the sheet has two snap points: 'full' (all content) and 'peek' (just the header)
const PEEK_VISIBLE = 100;             // px kept on screen when collapsed to peek
let sheetState = 'full';
function setSheetState(state) {
  sheetState = state;
  sheet.style.transition = '';        // animate to the snap point via the CSS class
  sheet.style.transform = '';
  sheet.classList.toggle('peek', state === 'peek');
  if (state === 'peek') sheetBody.scrollTop = 0; // show the header, not wherever it was scrolled
  updateRecenter();
}
function peekOffset() { return Math.max(0, sheet.offsetHeight - PEEK_VISIBLE); }

// write the content and raise the sheet up (a fresh result always opens full)
function fillSheet(html, opts) {
  sheetBody.innerHTML = html;
  sheetBody.scrollTop = 0;
  sheetShare.hidden = !opts.share;
  sheet.style.transition = '';        // default slide-up easing
  sheet.style.transform = '';
  sheet.classList.remove('peek');
  sheetState = 'full';
  sheet.hidden = false;
  void sheet.offsetHeight;            // reflow so it animates from off-screen
  sheet.classList.add('open');
  if (opts.panTo) panAboveSheet(opts.panTo);
  if (opts.after) opts.after();       // content is in the DOM now
  updateRecenter();
}

function openSheet(html, opts = {}) {
  clearTimeout(openSheet._hideT);
  clearTimeout(openSheet._reopenT);
  if (!sheet.hidden && sheet.classList.contains('open')) {
    // already on screen (checking another spot) → drop the current card out, then
    // raise the new one. Pure transform, so it stays smooth (no layout-bound tween).
    sheet.style.transition = 'transform .16s cubic-bezier(.4, 0, 1, 1)'; // quick exit
    sheet.classList.remove('open');                                      // slides off-screen
    openSheet._reopenT = setTimeout(() => fillSheet(html, opts), 170);   // swap while hidden, then rise
    return;
  }
  fillSheet(html, opts);
}
function closeSheet() {
  if (sheet.hidden) return;
  clearTimeout(openSheet._reopenT);
  sheet.style.transition = '';         // default easing (not the quick-exit one)
  sheet.classList.remove('open', 'peek');
  sheet.style.transform = '';          // let the CSS transition carry it back down
  sheetState = 'full';
  if (spotMarker) { spotMarker.remove(); spotMarker = null; }
  openSheet._hideT = setTimeout(() => { sheet.hidden = true; }, 360);
}
// ease the point of interest up into the band above the sheet so it stays visible
function panAboveSheet(ll) {
  const h = sheet.getBoundingClientRect().height || sheet.offsetHeight || 0;
  map.easeTo({ center: [ll.lng, ll.lat], offset: [0, -h * 0.42], duration: 420 });
}
// the recenter button only makes sense once the marker has been panned out of view
// (off-screen, or hidden behind the peek bar at the bottom)
function markerVisible() {
  if (!lastSpotLL || sheet.hidden) return false;
  const p = map.project([lastSpotLL.lng, lastSpotLL.lat]);
  const c = map.getContainer();
  // bottom of the visible map = the sheet's top edge at its current snap point
  const sheetTop = sheetState === 'peek' ? c.clientHeight - PEEK_VISIBLE : c.clientHeight - sheet.offsetHeight;
  return p.x > 24 && p.x < c.clientWidth - 24 && p.y > 24 && p.y < sheetTop - 16;
}
function updateRecenter() {
  sheet.classList.toggle('show-recenter', !sheet.hidden && !!lastSpotLL && !markerVisible());
}
map.on('move', updateRecenter);

// drag the top bar between snap points: full ⇄ peek ⇄ dismiss
let sheetDragStart = null, sheetDragBase = 0, sheetDragDY = 0;
sheetTop.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.sheet-btn')) return;  // let the close / share buttons click through
  sheetDragStart = e.clientY;
  sheetDragBase = sheetState === 'peek' ? peekOffset() : 0;   // current resting offset
  sheetDragDY = 0;
  sheet.style.transition = 'none';
  sheetTop.setPointerCapture(e.pointerId);
});
sheetTop.addEventListener('pointermove', (e) => {
  if (sheetDragStart == null) return;
  sheetDragDY = e.clientY - sheetDragStart;
  const y = Math.max(0, sheetDragBase + sheetDragDY);         // 0 = full, larger = lower
  sheet.style.transform = `translate(-50%, ${y}px)`;
});
function endSheetDrag() {
  if (sheetDragStart == null) return;
  sheetDragStart = null;
  const moved = sheetDragDY; sheetDragDY = 0;
  if (sheetState === 'full') {
    setSheetState(moved > 80 ? 'peek' : 'full');              // pull down → peek, else snap back
  } else {                                                    // peek
    if (moved < -50) setSheetState('full');                  // push up → expand
    else if (moved > 80) closeSheet();                       // pull down → dismiss
    else setSheetState('peek');                              // snap back
  }
}
sheetTop.addEventListener('pointerup', endSheetDrag);
sheetTop.addEventListener('pointercancel', endSheetDrag);

// the recenter button works in any state; tapping elsewhere on the peek bar expands it
sheet.addEventListener('click', (e) => {
  if (e.target.closest('.sheet-expand')) {        // recenter on the marker (and unfold if peeked)
    if (sheetState === 'peek') setSheetState('full');
    if (lastSpotLL) panAboveSheet(lastSpotLL);
    return;
  }
  if (sheetState !== 'peek') return;              // tap-to-expand only applies while peeked
  if (e.target.closest('.sheet-btn, summary, a, input, label')) return;
  setSheetState('full');                          // tap elsewhere on the peek bar → unfold
});

// animate the zone fold-outs — native <details> snaps, so tween the body height.
// Delegated on the sheet body so it keeps working after the content is re-rendered.
sheetBody.addEventListener('click', (e) => {
  const summary = e.target.closest('summary');
  if (!summary || !sheetBody.contains(summary)) return;
  const details = summary.parentElement;
  const body = summary.nextElementSibling; // .zd-body
  if (!details || !body || details._animating) return;
  e.preventDefault();                       // take over the instant native toggle
  const opening = !details.open;
  details._animating = true;
  if (opening) details.open = true;         // reveal so we can measure the full height
  const full = body.scrollHeight;
  body.style.overflow = 'hidden';
  const anim = body.animate(
    opening ? [{ height: '0px' }, { height: full + 'px' }]
            : [{ height: full + 'px' }, { height: '0px' }],
    // decelerate on open, accelerate on close — a symmetric ease-in-out crawls at both ends
    { duration: opening ? 190 : 150, easing: opening ? 'cubic-bezier(0, 0, .2, 1)' : 'cubic-bezier(.4, 0, 1, 1)' }
  );
  anim.onfinish = () => {
    if (!opening) details.open = false;     // collapse done — now hide the content
    body.style.overflow = '';
    details._animating = false;
  };
});

function altText(p) {
  const u = p.uom || 'M';
  if (p.lowerRef === p.upperRef) return `${p.lower}–${p.upper} ${u} ${p.lowerRef}`;
  return `${p.lower} ${u} ${p.lowerRef} → ${p.upper} ${u} ${p.upperRef}`;
}
function validityText(p) {
  if (p.permanent === 1) return 'Permanent';
  let wins; try { wins = JSON.parse(p.windows || '[]'); } catch { wins = []; }
  if (!wins.length) return '—';
  return wins.map(([s, e]) => `${fmtDate(s)} → ${fmtDate(e)}`).join('<br>');
}
// one expandable zone row — used inside the spot result sheet.
// The "Apply / check with CAA" link lives inside each row's fold-out.
function zoneRow(p, opts = {}) {
  const color = COLOR_OF[p.restriction] || COLOR_OF.UNKNOWN;
  const msg = p.msgEn || p.msgLv;
  return `<details class="zd${opts.dim ? ' dim' : ''}"${opts.open ? ' open' : ''}>
    <summary>
      <span class="zd-dot" style="background:${color}"></span>
      <span class="zd-name">${esc(p.name)}</span>
      <span class="zd-band">${esc(altText(p))}</span>
      <svg class="zd-chev" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </summary>
    <div class="zd-body">
      <span class="badge2" style="background:${color}">${esc(labelOf(p.restriction))}</span>
      <div class="zp-row"><span class="k">Reason</span><span class="v">${esc(p.reason) || '—'}</span></div>
      <div class="zp-row"><span class="k">Validity</span><span class="v">${validityText(p)}</span></div>
      ${authorityHtml(p)}
      ${msg ? `<div class="zp-msg">${linkify(msg)}</div>` : ''}
      ${applyBtn(p.restriction)}
      <div class="zp-id">ID ${esc(p.id)}${p.vol ? ' · vol ' + p.vol : ''}</div>
    </div>
  </details>`;
}

/* ---------- "can I fly here?" spot check ---------- */
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) &&
        (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function inPolygon(pt, rings) {
  if (!rings.length || !inRing(pt, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(pt, rings[k])) return false; // holes
  return true;
}
function bandText(p) {
  const u = p.uom || 'M';
  return p.lowerRef === p.upperRef
    ? `${p.lower}–${p.upper} ${u} ${p.lowerRef}`
    : `${p.lower} ${u} ${p.lowerRef}→${p.upper} ${u} ${p.upperRef}`;
}

// Merge a set of [start,end] windows, joining overlapping or contiguous ones.
function mergeIntervals(wins) {
  const norm = wins.map(([s, e]) => [s ?? -Infinity, e ?? Infinity]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of norm) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1000) last[1] = Math.max(last[1], e); // join if within 1s
    else out.push([s, e]);
  }
  return out.map(([s, e]) => [s === -Infinity ? null : s, e === Infinity ? null : e]);
}

// Collapse zones that look identical (same name + restriction + altitude band),
// merging their validity windows. The dataset frequently splits one zone into
// adjacent time periods under the same name, which otherwise read as duplicates.
function dedupeZones(propsList) {
  const now = Date.now();
  const groups = new Map();
  for (const p of propsList) {
    const key = [p.name, p.restriction, p.lower, p.upper, p.lowerRef, p.upperRef].join('|');
    let wins; try { wins = JSON.parse(p.windows || '[]'); } catch { wins = []; }
    const g = groups.get(key);
    if (!g) groups.set(key, { ...p, _wins: wins.slice(), _perm: p.permanent === 1 });
    else { g._wins.push(...wins); g._perm = g._perm || p.permanent === 1; }
  }
  return [...groups.values()].map((g) => {
    const merged = mergeIntervals(g._wins);
    const active = g._perm || merged.length === 0 ||
      merged.some(([s, e]) => (s == null || now >= s) && (e == null || now <= e));
    const { _wins, _perm, ...rest } = g;
    return { ...rest, permanent: g._perm ? 1 : 0, windows: JSON.stringify(merged), activeNow: active ? 1 : 0 };
  });
}

let spotMarker = null;
let lastSpotLL = null;    // last spot-checked location, for the Share button
let lastLongPressAt = 0;  // perf-clock time of the last long-press, so its trailing click (and any compat mouse events) are ignored
function placeSpot(lngLat, opts = {}) {
  const ll = lngLat.lng !== undefined ? lngLat : { lng: lngLat[0], lat: lngLat[1] };
  lastSpotLL = ll;
  const pt = [ll.lng, ll.lat];
  const hits = dedupeZones(
    allFeatures.filter((ft) => inPolygon(pt, ft.geometry.coordinates)).map((ft) => ft.properties));
  const active = hits.filter((h) => h.activeNow === 1);

  // verdict = strictest active zone (or "clear" if none)
  let color = COLOR_OF.NO_RESTRICTION, label = 'No active zones here', sev = 0;
  for (const h of active) {
    const s = SEVERITY[h.restriction] || 0;
    if (s > sev) { sev = s; color = COLOR_OF[h.restriction]; label = labelOf(h.restriction); }
  }

  if (spotMarker) spotMarker.remove();
  spotMarker = new maplibregl.Marker({ color }).setLngLat(ll).addTo(map);
  renderSpot({ ll, hits, active, color, label, sev, gps: !!opts.gps, a3: a3StatusAt(ll) });
}

function renderSpot(s) {
  const { ll, hits, active, color, label, gps } = s;
  const seasonal = hits.filter((h) => h.activeNow !== 1);
  const bySeverity = (a, b) =>
    (SEVERITY[b.restriction] || 0) - (SEVERITY[a.restriction] || 0) || (a.lower ?? 0) - (b.lower ?? 0);
  active.sort(bySeverity);   // strictest first, so the open row matches the verdict
  seasonal.sort(bySeverity);

  let advice;
  if (active.length) {
    const minFloor = Math.min(...active.map((h) => h.lower ?? 0));
    advice = minFloor > 0
      ? `Clear below <b>${minFloor} m AGL</b> · restricted above. Expand a zone for details.`
      : `Restricted from the ground up — expand a zone below for details.`;
  } else {
    advice = 'No UAS zone at this point. Still respect the 120 m open-category limit and current NOTAMs.';
  }

  const html = `
    <div class="spot-head" style="background:${color}">
      <div class="spot-verdict">${gps ? '📍 ' : ''}${esc(label)}</div>
      <div class="spot-sub">${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)} · ${active.length} active zone${active.length === 1 ? '' : 's'}</div>
      <button class="sheet-expand" aria-label="Centre on the marker and expand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>
      </button>
    </div>
    <div class="spot-inner">
      <div class="spot-advice">${advice}</div>
      ${s.a3 ? `<div class="spot-a3 ${s.a3.flyable ? 'a3-ok' : 'a3-no'}"><b>A3:</b> ${s.a3.flyable
        ? 'clear of built-up / recreational areas & roads here'
        : 'within 150 m of a built-up / recreational area or road — A3 not allowed'}</div>` : ''}
      ${(active.length || seasonal.length) ? `<div class="spot-zones">
        ${active.map((p) => zoneRow(p)).join('')}
        ${seasonal.length ? `<div class="spot-seasonal">Seasonal / not active now</div>` : ''}
        ${seasonal.map((p) => zoneRow(p, { dim: true })).join('')}
      </div>` : ''}
      <div class="spot-weather" id="spotWeather">Loading weather…</div>
    </div>`;
  openSheet(html, { share: true, panTo: ll, after: () => loadWeather(ll) });
  panel.classList.add('collapsed'); // a result opened — get the drawer out of the way
}

/* ---------- weather + daylight (Open-Meteo, no key) ---------- */
async function loadWeather(ll) {
  const el = document.getElementById('spotWeather');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${ll.lat.toFixed(4)}&longitude=${ll.lng.toFixed(4)}` +
    `&current=temperature_2m,precipitation,cloud_cover,wind_speed_10m,wind_gusts_10m` +
    `&daily=sunrise,sunset&wind_speed_unit=ms&timezone=auto&forecast_days=1`;
  let w;
  try { w = await (await fetch(url)).json(); }
  catch { if (el && el.isConnected) el.textContent = 'Weather unavailable offline'; return; }
  if (!el || !el.isConnected) return;

  const c = w.current || {}, d = w.daily || {};
  const wind = c.wind_speed_10m, gust = c.wind_gusts_10m;
  const sunrise = d.sunrise && d.sunrise[0], sunset = d.sunset && d.sunset[0];
  const now = Date.now();
  const isDay = sunrise && sunset ? (now >= Date.parse(sunrise) && now <= Date.parse(sunset)) : true;

  let level = 'ok'; const reasons = [];
  if (gust >= 12 || wind >= 11) { level = 'bad'; reasons.push('strong wind'); }
  else if (gust >= 8 || wind >= 8) { level = 'warn'; reasons.push('gusty'); }
  if (c.precipitation > 0) { level = level === 'bad' ? 'bad' : 'warn'; reasons.push('precipitation'); }
  if (!isDay) { level = level === 'bad' ? 'bad' : 'warn'; reasons.push('after dark'); }
  const verdict = { ok: 'Good to fly', warn: 'Marginal', bad: 'Poor conditions' }[level];
  const hm = (iso) => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';
  const n0 = (x) => (x == null ? '—' : Math.round(x));

  el.className = `spot-weather wx-${level}`;
  el.innerHTML = `<div class="wx-top"><b>${verdict}</b>${reasons.length ? ' · ' + esc(reasons.join(', ')) : ''}</div>
    <div class="wx-grid">
      <span>💨 ${n0(wind)} m/s <span class="muted">gust ${n0(gust)}</span></span>
      <span>🌡️ ${n0(c.temperature_2m)}°C</span>
      <span>🌧️ ${c.precipitation ?? 0} mm</span>
      <span>☁️ ${n0(c.cloud_cover)}%</span>
      <span>🌅 ${hm(sunrise)}</span>
      <span>🌇 ${hm(sunset)}</span>
    </div>`;
}

/* ---------- splash ---------- */
function hideSplash() {
  const s = document.getElementById('splash');
  if (!s) return;
  s.classList.add('hide');
  setTimeout(() => s.remove(), 600);
}
setTimeout(hideSplash, 15000); // safety: never let the splash get stuck

/* ---------- data load ---------- */
// radial ring next to each date: fills as the next scheduled rebuild approaches
// (elapsed since last refresh / cadence). Hover shows "Refreshes daily/monthly".
function setCad(id, sinceIso, periodMs) {
  const svg = document.getElementById(id);
  const fill = svg && svg.querySelector('.cad-fill');
  if (!fill || !sinceIso) return;
  const C = 2 * Math.PI * 8; // r = 8
  const p = Math.max(0, Math.min(1, (Date.now() - Date.parse(sinceIso)) / periodMs));
  fill.setAttribute('stroke-dashoffset', (C * (1 - p)).toFixed(2));
  svg.style.display = '';
}

fetch('data/meta.json').then((r) => r.json()).then((m) => {
  const el = document.getElementById('updated');
  const when = m.generatedAt ? new Date(m.generatedAt).toLocaleDateString('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  el.textContent = `updated ${when}`;
  el.title = `${m.title || ''}  (CRC ${m.crc || '?'})`;
  setCad('zonesCad', m.generatedAt, 86400000);          // daily
}).catch(() => { document.getElementById('updated').textContent = ''; });

// A3 overlay refresh date (it has its own monthly rebuild)
fetch('data/a3-meta.json').then((r) => r.json()).then((m) => {
  const el = document.getElementById('a3Updated');
  if (el && m.generatedAt) {
    el.textContent = 'A3 ground-risk · updated ' + new Date(m.generatedAt).toLocaleDateString('en-GB',
      { day: '2-digit', month: 'short', year: 'numeric' });
    setCad('a3Cad', m.generatedAt, 30 * 86400000);      // ~monthly
  }
}).catch(() => {});

map.on('load', async () => {
  let data;
  try {
    data = await (await fetch('data/zones.geojson')).json();
  } catch (e) {
    document.getElementById('updated').textContent = 'data failed to load';
    hideSplash();
    return;
  }
  const now = Date.now();
  for (const ft of data.features) ft.properties.activeNow = isActive(ft.properties, now) ? 1 : 0;
  allFeatures = data.features;

  map.addSource('zones', { type: 'geojson', data, generateId: true });

  map.addLayer({
    id: 'zones-fill', type: 'fill', source: 'zones',
    paint: {
      'fill-color': colorExpr,
      'fill-opacity': 0.32,
    },
  });
  map.addLayer({
    id: 'zones-line', type: 'line', source: 'zones',
    paint: {
      'line-color': colorExpr,
      'line-width': 1,
      'line-opacity': 0.9,
    },
  });
  map.addLayer({
    id: 'zones-3d', type: 'fill-extrusion', source: 'zones',
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': colorExpr,
      'fill-extrusion-opacity': 0.5,
      'fill-extrusion-base': ['coalesce', ['get', 'lower'], 0],
      'fill-extrusion-height': ['coalesce', ['get', 'upper'], 0],
    },
  });

  buildLegend();
  applyFilter();
  applyZoneStyleForBase(currentBase);
  map.once('idle', hideSplash); // fade the splash once the first frame is rendered

  // open a shared spot, if the URL carries one (?spot=lat,lng)
  const sp = new URLSearchParams(location.search).get('spot');
  if (sp) {
    const [la, lo] = sp.split(',').map(Number);
    if (isFinite(la) && isFinite(lo)) {
      map.flyTo({ center: [lo, la], zoom: Math.max(map.getZoom(), 13), duration: 0 });
      placeSpot({ lng: lo, lat: la });
    }
  }

  // zones are display-only — no hover / selection (details come from the long-press spot check)

});

// long-press (or right-click) = "can I fly here?" spot check; a map tap collapses the sheet to peek
map.on('click', () => {
  // The synthetic click trailing a long-press — plus the compatibility mouse
  // events some browsers fire after a touch — must not collapse the sheet it opened.
  if (performance.now() - lastLongPressAt < 1000) return;
  if (!sheet.hidden && sheetState === 'full') setSheetState('peek'); // collapse to peek — never dismiss on a map tap
});
// panning the map also collapses the sheet to peek so it's out of the way
map.on('dragstart', () => { if (!sheet.hidden && sheetState === 'full') setSheetState('peek'); });

// long-press detector (touch + mouse); right-click is an instant alias
let pressTimer = null, pressPt = null;
const LONG_MS = 450, MOVE_TOL = 8;
function startPress(e) {
  pressPt = e.point;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    lastLongPressAt = performance.now();
    placeSpot(e.lngLat);
    try { if (navigator.vibrate) navigator.vibrate(15); } catch (err) { /* ignore */ }
  }, LONG_MS);
}
function endPress() { clearTimeout(pressTimer); pressTimer = null; pressPt = null; }
function moveCheck(e) {
  if (!pressPt) return;
  const dx = e.point.x - pressPt.x, dy = e.point.y - pressPt.y;
  if (dx * dx + dy * dy > MOVE_TOL * MOVE_TOL) endPress(); // moved -> it's a pan, not a hold
}
map.on('mousedown', startPress);
map.on('touchstart', (e) => { (e.points && e.points.length > 1) ? endPress() : startPress(e); });
map.on('mousemove', moveCheck);
map.on('touchmove', moveCheck);
map.on('mouseup', endPress);
map.on('touchend', endPress);
map.on('dragstart', endPress);
map.on('contextmenu', (e) => { lastLongPressAt = performance.now(); placeSpot(e.lngLat); });

/* ---------- legend ---------- */
function buildLegend() {
  const counts = {};
  for (const ft of allFeatures) {
    const k = ft.properties.restriction in COLOR_OF ? ft.properties.restriction : 'UNKNOWN';
    counts[k] = (counts[k] || 0) + 1;
  }
  const ul = document.getElementById('legend');
  ul.innerHTML = '';
  for (const r of RESTRICTIONS) {
    if (!counts[r.key] && r.key === 'UNKNOWN') continue;
    const li = document.createElement('li');
    li.dataset.key = r.key;
    li.innerHTML = `<span class="swatch" style="background:${r.color}"></span>
      <span class="lbl">${r.label}</span><span class="cnt">${counts[r.key] || 0}</span>`;
    li.addEventListener('click', () => {
      if (enabled.has(r.key)) enabled.delete(r.key); else enabled.add(r.key);
      li.classList.toggle('off', !enabled.has(r.key));
      applyFilter();
    });
    ul.appendChild(li);
  }
}

/* ---------- A3 ground-risk overlay (Open-category 150 m rule) ---------- */
// Where the A3 subcategory may NOT fly: within 150 m of buildings + built-up /
// recreational land. Precomputed from OpenStreetMap into data/a3-exclusion.geojson
// and loaded lazily — the file is only fetched the first time the layer is shown.
const A3_FILL = '#8b5cf6', A3_LINE = '#c4b5fd';
let a3Loaded = false, a3Loading = null;

function ensureA3() {
  if (a3Loaded) return Promise.resolve(true);
  if (a3Loading) return a3Loading;
  a3Loading = fetch('data/a3-exclusion.geojson.gz')
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // decompress with the built-in DecompressionStream (no library)
      return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).json();
    })
    .then((data) => {
      if (!map.getSource('a3')) {
        map.addSource('a3', { type: 'geojson', data });
        // sit just under the place labels (town names stay readable) and under
        // the airspace zones so those remain the dominant layer.
        const before = map.getLayer('b-labels') ? 'b-labels' : undefined;
        map.addLayer({
          id: 'a3-fill', type: 'fill', source: 'a3', layout: { visibility: 'none' },
          paint: { 'fill-color': A3_FILL, 'fill-opacity': 0.28 },
        }, before);
        map.addLayer({
          id: 'a3-line', type: 'line', source: 'a3', layout: { visibility: 'none' },
          paint: { 'line-color': A3_LINE, 'line-width': 0.5, 'line-opacity': 0.4 },
        }, before);
      }
      a3Loaded = true;
      return true;
    })
    .catch((e) => { a3Loading = null; toast('A3 layer unavailable'); throw e; });
  return a3Loading;
}
function setA3Visible(on) {
  for (const id of ['a3-fill', 'a3-line']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}
// A3 verdict for the spot card — only when the layer is on (cheap GPU query).
function a3StatusAt(ll) {
  if (!map.getLayer('a3-fill')) return null;
  if (map.getLayoutProperty('a3-fill', 'visibility') !== 'visible') return null;
  const hit = map.queryRenderedFeatures(map.project(ll), { layers: ['a3-fill'] });
  return { flyable: hit.length === 0 };
}

/* ---------- UI controls ---------- */
document.getElementById('activeOnly').addEventListener('change', (e) => {
  activeOnly = e.target.checked; applyFilter();
});
const altInput = document.getElementById('altitude');
const altOn = document.getElementById('altOn');
altOn.addEventListener('change', () => {
  altInput.disabled = !altOn.checked;
  altCap = altOn.checked ? +altInput.value : Infinity;
  applyFilter();
});
altInput.addEventListener('input', (e) => {
  document.getElementById('altVal').textContent = e.target.value;
  if (altOn.checked) { altCap = +e.target.value; applyFilter(); }
});

document.getElementById('basemaps').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const vis = BASEMAPS[btn.dataset.base]; if (!vis) return;
  for (const [id, on] of Object.entries(vis)) {
    map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  document.querySelectorAll('#basemaps button').forEach((b) => b.classList.toggle('active', b === btn));
  currentBase = btn.dataset.base;
  applyZoneStyleForBase(currentBase);
});

document.getElementById('threeD').addEventListener('change', (e) => {
  is3D = e.target.checked;
  map.setLayoutProperty('zones-3d', 'visibility', is3D ? 'visible' : 'none');
  map.setLayoutProperty('zones-fill', 'visibility', is3D ? 'none' : 'visible');
  map.easeTo({ pitch: is3D ? 55 : 0, duration: 600 });
});

// A3 ground-risk overlay toggle (lazy-loads the GeoJSON on first activation)
const a3On = document.getElementById('a3On');
if (a3On) a3On.addEventListener('change', async (e) => {
  if (e.target.checked) {
    try { await ensureA3(); setA3Visible(true); }
    catch (_) { e.target.checked = false; } // load failed — bounce the checkbox back
  } else {
    setA3Visible(false);
  }
});

// sheet controls
document.getElementById('sheetClose').addEventListener('click', closeSheet);
document.getElementById('sheetShare').addEventListener('click', shareSpot);
// directions / navigation to the checked spot
document.getElementById('sheetGmaps').addEventListener('click', () => {
  if (lastSpotLL) window.open(`https://www.google.com/maps/dir/?api=1&destination=${lastSpotLL.lat},${lastSpotLL.lng}`, '_blank', 'noopener');
});
document.getElementById('sheetWaze').addEventListener('click', () => {
  if (lastSpotLL) window.open(`https://waze.com/ul?ll=${lastSpotLL.lat},${lastSpotLL.lng}&navigate=yes`, '_blank', 'noopener');
});

// share the currently-checked spot (native share where available, else copy a link)
async function shareSpot() {
  if (!lastSpotLL) return;
  const url = `${location.origin}${location.pathname}?spot=${lastSpotLL.lat.toFixed(5)},${lastSpotLL.lng.toFixed(5)}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Latvia Drone Zones', text: 'UAS zones at this spot', url }); return; }
    catch (e) { return; } // user dismissed the share sheet
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch (e) { toast(legacyCopy(url) ? 'Link copied' : 'Copy failed'); }
}
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

/* ---------- address / place search (OpenStreetMap Nominatim, no key) ---------- */
const search = document.getElementById('search');
const searchResults = document.getElementById('searchResults');
let searchAbort = null, searchTimer = null, lastResults = [], selIdx = -1;

function hideResults() {
  searchResults.innerHTML = '';
  searchResults.classList.remove('show');
  lastResults = []; selIdx = -1;
}
// Build a readable two-line label from a Nominatim hit. Nominatim's `name` for a
// house is just the number (e.g. "19 k-3"), so for street addresses we compose
// "<street> <number>" and push the locality to the sub-line — like Google Maps.
function formatResult(r) {
  const a = r.address || {};
  const road = a.road || a.pedestrian || a.footway || a.path || a.cycleway;
  const houseNo = a.house_number;
  let main;
  if (r.name && r.name !== houseNo && r.name !== road) main = r.name; // named POI / place / street
  else if (road) main = [road, houseNo].filter(Boolean).join(' ');    // street address
  else main = (r.display_name || '').split(',')[0];                   // fallback
  const ctx = [a.suburb || a.neighbourhood || a.quarter || a.city_district,
    a.city || a.town || a.village || a.municipality, a.postcode, a.country];
  if (road && !main.includes(road)) ctx.unshift(road);               // keep the street when main is a POI
  const sub = ctx.filter((p) => p && !main.includes(p)).join(', ');
  return { main, sub: sub || (r.display_name || '').split(',').slice(1).join(',').trim() };
}
function renderResults(items) {
  lastResults = items; selIdx = -1;
  if (!items.length) { searchResults.innerHTML = '<li class="r-empty">No matches in Latvia</li>'; searchResults.classList.add('show'); return; }
  searchResults.innerHTML = items.map((r, i) => {
    const { main, sub } = formatResult(r);
    return `<li data-i="${i}"><div class="r-main">${esc(main)}</div><div class="r-sub">${esc(sub)}</div></li>`;
  }).join('');
  searchResults.classList.add('show');
}
async function geocode(q) {
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=lv&accept-language=en&addressdetails=1&q=${encodeURIComponent(q)}`;
  try { renderResults(await (await fetch(url, { signal: searchAbort.signal })).json()); }
  catch (e) { /* aborted or offline */ }
}
function goToResult(r) {
  if (!r) return;
  const lat = +r.lat, lon = +r.lon, bb = r.boundingbox;
  search.value = formatResult(r).main;
  syncSearchClear();
  hideResults();
  if (bb && bb.length === 4) {
    map.fitBounds([[+bb[2], +bb[0]], [+bb[3], +bb[1]]], { padding: 60, maxZoom: 15, duration: 800 });
  } else {
    map.flyTo({ center: [lon, lat], zoom: 14, duration: 800 });
  }
  map.once('moveend', () => placeSpot({ lng: lon, lat: lat })); // show "can I fly here?" at the address
}

search.addEventListener('input', () => {
  const q = search.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 3) { hideResults(); return; }
  searchTimer = setTimeout(() => geocode(q), 400); // debounce (Nominatim is rate-limited)
});
search.addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && lastResults.length) {
    e.preventDefault();
    selIdx = (selIdx + (e.key === 'ArrowDown' ? 1 : -1) + lastResults.length) % lastResults.length;
    [...searchResults.children].forEach((li, i) => li.classList.toggle('sel', i === selIdx));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    goToResult(lastResults[selIdx >= 0 ? selIdx : 0]);
  } else if (e.key === 'Escape') {
    hideResults();
  }
});
searchResults.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]'); if (!li) return;
  goToResult(lastResults[+li.dataset.i]);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.searchbar')) hideResults(); });

// clear (×) button in the search pill
const searchClear = document.getElementById('searchClear');
function syncSearchClear() { searchClear.classList.toggle('show', search.value.length > 0); }
search.addEventListener('input', syncSearchClear);
searchClear.addEventListener('click', () => { search.value = ''; hideResults(); syncSearchClear(); search.focus(); });

// menu drawer — starts collapsed (see index.html); the ☰ in the search pill
// toggles it, the close button or any map click dismisses it.
const panel = document.getElementById('panel');
const openBtn = document.getElementById('panelOpen');
const closeDrawer = () => panel.classList.add('collapsed');
openBtn.addEventListener('click', (e) => { e.stopPropagation(); panel.classList.toggle('collapsed'); });
document.getElementById('panelToggle').addEventListener('click', closeDrawer);
map.on('click', closeDrawer);       // tap the map…
map.on('dragstart', closeDrawer);   // …or start panning it

// swipe the drawer left to dismiss it (vertical drags still scroll the content)
let panStartX = null, panStartY = null, panDX = 0, panSwiping = false;
panel.addEventListener('pointerdown', (e) => {
  if (panel.classList.contains('collapsed')) return;
  if (e.target.closest('input[type="range"], button, a')) return; // let real controls work
  panStartX = e.clientX; panStartY = e.clientY; panDX = 0; panSwiping = false;
});
panel.addEventListener('pointermove', (e) => {
  if (panStartX == null) return;
  const dx = e.clientX - panStartX, dy = e.clientY - panStartY;
  if (!panSwiping) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;               // wait for a clear direction
    if (Math.abs(dy) >= Math.abs(dx)) { panStartX = null; return; } // vertical → let it scroll
    panSwiping = true;
    panel.style.transition = 'none';
    panel.setPointerCapture(e.pointerId);
  }
  panDX = Math.min(0, dx);                                          // leftward only
  panel.style.transform = `translateX(${panDX}px)`;
});
function endPanelSwipe() {
  if (panStartX == null) return;
  const dismiss = panSwiping && panDX < -60;
  panStartX = null; panSwiping = false; panDX = 0;
  panel.style.transition = '';
  if (dismiss) panel.classList.add('collapsed');
  panel.style.transform = '';                                      // hand back to CSS, animated
}
panel.addEventListener('pointerup', endPanelSwipe);
panel.addEventListener('pointercancel', endPanelSwipe);

// layers card (bottom-left) — toggle the base-map / overlays popover
const layersBtn = document.getElementById('layersBtn');
const layersMenu = document.getElementById('layersMenu');
layersBtn.addEventListener('click', (e) => { e.stopPropagation(); layersMenu.classList.toggle('open'); });
document.addEventListener('click', (e) => { if (!e.target.closest('#layers')) layersMenu.classList.remove('open'); });
map.on('dragstart', () => layersMenu.classList.remove('open')); // panning the map closes the popover

/* ---------- light / dark theme ---------- */
const themeBtn = document.getElementById('themeToggle');
const metaTheme = document.querySelector('meta[name="theme-color"]');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  if (themeBtn) themeBtn.textContent = t === 'dark' ? '☀️ Switch to light' : '🌙 Switch to dark';
  if (metaTheme) metaTheme.setAttribute('content', t === 'dark' ? '#1b1f27' : '#1f6feb');
  try { localStorage.setItem('theme', t); } catch (e) { /* ignore */ }
}
if (themeBtn) {
  themeBtn.addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}
applyTheme(document.documentElement.dataset.theme || 'dark');

/* ---------- install (PWA) ---------- */
// Chromium fires `beforeinstallprompt` when the app is installable; we stash it and
// reveal the button so users who don't know the browser menu can one-tap install.
// iOS Safari has no such event, so there we just show the "Add to Home Screen" steps.
const installBtn = document.getElementById('installBtn');
if (installBtn) {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferredInstall = null;

  if (!standalone) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstall = e;
      installBtn.hidden = false;
    });
    if (isIOS) installBtn.hidden = false; // no prompt API — offer instructions instead

    installBtn.addEventListener('click', async () => {
      if (deferredInstall) {
        deferredInstall.prompt();
        await deferredInstall.userChoice;
        deferredInstall = null;
        installBtn.hidden = true; // prompt is single-use; the browser re-fires it if still installable
      } else if (isIOS) {
        toast('Tap the Share button, then “Add to Home Screen”');
      }
    });

    window.addEventListener('appinstalled', () => { installBtn.hidden = true; deferredInstall = null; });
  }
}
