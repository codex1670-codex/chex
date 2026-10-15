// CHEX service worker: offline app shell. Never touches API, uploads or websockets.
const CACHE = 'chex-shell-v2';
const SHELL = ['/', '/icon-192.png', '/logo.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|uploads|socket\.io)/.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    // network-first so deploys show up immediately; cached shell when offline
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  // static assets (hashed by Vite): cache-first, fill on miss
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
