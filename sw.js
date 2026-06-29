/* Service worker — makes the map usable offline in the field.
 *
 * App code (HTML/JS/CSS, same-origin) is NETWORK-FIRST: you always get the
 * latest deploy when online, and the cached copy only when offline. (Cache-first
 * here would pin stale code after an update — deliberately avoided.)
 *  - zone data: stale-while-revalidate (instant + refreshes when online)
 *  - map tiles + pinned CDN libs: cache-first (viewed areas work offline)
 *  - weather: never cached (always a live reading)
 *
 * Bump VERSION on any caching-strategy change to purge old caches.
 */
const VERSION = 'v5';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;
const TILES = `tiles-${VERSION}`;

const SHELL_ASSETS = [
  './', './index.html', './app.js', './style.css',
  './manifest.webmanifest', './icon-192.png', './icon-512.png',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (url.pathname.endsWith('.geojson') || url.pathname.endsWith('.geojson.gz') || url.pathname.endsWith('meta.json')) {
    e.respondWith(networkFirst(e.request, DATA)); // zones + A3 data: always fresh online, cached for offline
  } else if (url.hostname.includes('open-meteo')) {
    return; // live weather only
  } else if (url.host.includes('unpkg.com')) {
    e.respondWith(cacheFirst(e.request, SHELL)); // version-pinned, immutable
  } else if (/arcgisonline|cartocdn|\/tile/.test(url.host + url.pathname)) {
    e.respondWith(cacheFirst(e.request, TILES));
  } else if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(e.request, SHELL)); // app code: always fresh online
  }
});

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return hit || Response.error();
  }
}

async function networkFirst(req, name) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || net;
}
