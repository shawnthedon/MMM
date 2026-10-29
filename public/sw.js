/* MMM service worker — offline shell + stale-while-revalidate assets */
// Invalidate the pre-isolation shell: offline navigation must not reuse a cached document
// without the COOP/COEP headers from before the deployment.
// v4 also purges the pre-rename (SwarmOS-era) caches, whose shell could have been built against
// authenticated API responses under different cache keys.
const CACHE = 'mmm-v4';
// Historical prefix from before this app was renamed. Kept only so existing installs do not carry
// a stale shell forever; nothing new is ever written under it.
const LEGACY_PREFIX = 'swarmos-';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/favicon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE && (k.startsWith('mmm-') || k.startsWith(LEGACY_PREFIX))).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache or serve authenticated gateway responses, including when the gateway is
  // reverse-proxied through this origin. Request.cache does not constrain CacheStorage.
  if (req.cache === 'no-store' || req.headers.has('authorization') || url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  // The experimental standalone page is not the PWA shell. Never overwrite the offline
  // index cache with it, or return the app shell as the spike when it is offline.
  if (req.mode === 'navigate' && !['/', '/index.html'].includes(url.pathname)) return;

  // Only known static paths are eligible; all other routes may be dynamic.
  if (req.mode !== 'navigate' && !url.pathname.startsWith('/assets/') &&
      !url.pathname.startsWith('/icons/') && url.pathname !== '/manifest.webmanifest') return;

  // Navigations: network-first with cache fallback (app shell)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && !/no-store|private/i.test(res.headers.get('cache-control') || '')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.open(CACHE).then(async (c) => (await c.match('./index.html')) || c.match('./')))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok && !/no-store|private/i.test(res.headers.get('cache-control') || '')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
