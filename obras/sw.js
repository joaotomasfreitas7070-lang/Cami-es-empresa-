// Casas das Obras — guarda o site no telemóvel e recebe os avisos (Web Push).
const CACHE = 'casas-v1';
const FICHEIROS = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'img/icon-192.png', 'img/apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(FICHEIROS.map((f) => c.add(f).catch(() => null)))));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('casas-') && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return;           // dados e fotos: sempre da internet
  const nosso = url.origin === self.location.origin;
  if (!nosso && !['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return;
  e.respondWith((async () => {
    try {
      const resp = await fetch(req);
      if (resp && (resp.ok || resp.type === 'opaque')) { const c = resp.clone(); caches.open(CACHE).then((k) => k.put(req, c)).catch(() => {}); }
      return resp;
    } catch (err) {
      const g = await caches.match(req, { ignoreSearch: true });
      if (g) return g;
      if (req.mode === 'navigate') return caches.match('index.html');
      throw err;
    }
  })());
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { titulo: 'Casas das Obras', corpo: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Casas das Obras', {
    body: d.corpo || '', icon: 'img/icon-192.png', badge: 'img/icon-192.png', tag: d.tag || undefined,
    renotify: !!d.tag, requireInteraction: !!d.urgente, data: { url: d.url || './' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((js) => {
    const j = js.find((w) => 'focus' in w);
    if (j) { j.navigate?.(url); return j.focus(); }
    return self.clients.openWindow(url);
  }));
});
