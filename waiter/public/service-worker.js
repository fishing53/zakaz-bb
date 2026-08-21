const CACHE = 'bb-waiter-pwa-v1';
const APP_SHELL = [
  '/waiter/',
  '/waiter/manifest.webmanifest',
  '/waiter/icons/icon-192.png',
  '/waiter/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith('bb-waiter-pwa-') && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/waiter/')));
    return;
  }
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/waiter/')) return;
  event.respondWith(caches.match(event.request).then((cached) => {
    const network = fetch(event.request).then((response) => {
      if (response.ok) void caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    });
    return cached || network;
  }));
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { payload = { body: event.data?.text() ?? '' }; }
  const title = payload.title || 'Brooklyn Bowl';
  const options = {
    body: payload.body || 'Поступил новый вызов',
    icon: '/waiter/icons/icon-192.png',
    badge: '/waiter/icons/icon-192.png',
    tag: payload.tag || `bb-waiter-${Date.now()}`,
    renotify: true,
    requireInteraction: true,
    data: { url: '/waiter/', ...(payload.data || {}) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/waiter/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).pathname.startsWith('/waiter/'));
    if (existing) return existing.focus().then(() => existing.navigate(target));
    return self.clients.openWindow(target);
  }));
});
