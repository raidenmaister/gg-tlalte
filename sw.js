// ============================================================================
// sw.js — Service worker de GG-TLALTE (app instalable).
//
// - La página (index.html) va siempre primero a la red, con copia de respaldo.
// - JS/CSS/íconos versionados (?v=) se sirven desde caché y se actualizan solos.
// - api.php, el panel de administración y cualquier dato del servidor NUNCA se cachean.
// ============================================================================
const VERSION = '1.0.1';
const CACHE = `gg-tlalte-${VERSION}`;
const PRECACHE = [
  './',
  './index.html',
  './style.css?v=1.0.1',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gg-tlalte-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function neverCache(url) {
  return /api\.php|admin|administracion|version\.json|\/data\/|\/satpool\//.test(url.pathname + url.search);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || neverCache(url)) return;

  // Navegación: red primero (para recibir actualizaciones) y caché si no hay conexión.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Recursos estáticos: caché primero y actualización en segundo plano.
  if (/\.(js|css|png|jpg|svg|webp|ico|json|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok && res.type === 'basic') {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
