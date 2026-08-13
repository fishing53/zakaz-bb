const CACHE = 'brooklyn-kiosk-v57';
const UI_IMAGES = ['./images/home-mascot.png', './images/waiter-character.png', './images/inactivity-character.png', './images/stop-list-stamp.png', './images/sauce-fallback.webp'];
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', ...UI_IMAGES];

self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('message', (event) => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put('./index.html', response.clone()));
      return response;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && (requestUrl.origin === self.location.origin || requestUrl.hostname === 'static.tildacdn.com')) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
