// Guarda uma cópia do site no dispositivo para abrir sem internet.
// Estratégia: tenta sempre a versão mais recente da internet; sem rede usa a cópia.
const CACHE = 'freitas-v12';
const FICHEIROS = [
  './', 'index.html', 'style.css', 'app.js', 'equipa.js', 'rh.js', 'config.js', 'manifest.webmanifest',
  'img/logo.png', 'img/logo-128.png', 'img/favicon.png', 'img/apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(FICHEIROS.map((f) => c.add(f).catch(() => null)))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Dados e faturas (Supabase) nunca passam pela cópia.
  if (url.hostname.endsWith('supabase.co')) return;
  const nosso = url.origin === self.location.origin;
  if (!nosso && !['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return;

  e.respondWith((async () => {
    try {
      const resp = await fetch(req);
      if (resp && (resp.ok || resp.type === 'opaque')) {
        const copia = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
      }
      return resp;
    } catch (err) {
      const guardado = await caches.match(req, { ignoreSearch: true });
      if (guardado) return guardado;
      if (req.mode === 'navigate') return caches.match('index.html');
      throw err;
    }
  })());
});

// Notificações (Web Push) enviadas pela Edge Function "notificar"
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { titulo: 'Transportes Freitas', corpo: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Transportes Freitas', {
    body: d.corpo || '', icon: 'img/icon-192.png', badge: 'img/favicon.png', tag: d.tag || undefined,
    renotify: !!d.tag, requireInteraction: !!d.urgente, data: { url: d.url || './' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
    const aberta = janelas.find((w) => 'focus' in w);
    return aberta ? aberta.focus() : self.clients.openWindow(e.notification.data?.url || './');
  }));
});
