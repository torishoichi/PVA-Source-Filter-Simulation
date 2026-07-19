/**
 * Source-Filter Voice Studio — Service Worker
 * Same-origin: network-first (fresh deploys arrive immediately; cache is the
 * offline fallback). Cross-origin (CDN): stale-while-revalidate.
 * Bump VERSION on release to purge old caches.
 */
const VERSION = 'v1.47.0';
const CACHE = `sf-voice-studio-${VERSION}`;
const SHELL = [
    './',
    './index.html',
    './mobile.html',
    './main.js',
    './dsp-core.js',
    './style.css',
    './mobile.css',
    './recordings-db.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const sameOrigin = new URL(req.url).origin === self.location.origin;

    if (sameOrigin) {
        // Network-first with conditional revalidation (cheap 304s), cache fallback.
        // Guarantees the app shell never serves a stale or version-skewed mix.
        e.respondWith(
            fetch(new Request(req, { cache: 'no-cache' })).then(res => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
                }
                return res;
            }).catch(() => caches.match(req))
        );
        return;
    }

    // Cross-origin (CDN libs): stale-while-revalidate
    e.respondWith(
        caches.match(req).then(cached => {
            const fetchPromise = fetch(req).then(res => {
                if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
                }
                return res;
            }).catch(() => cached);
            return cached || fetchPromise;
        })
    );
});
