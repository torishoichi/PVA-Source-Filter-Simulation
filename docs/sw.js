/**
 * Source-Filter Voice Studio — Service Worker
 * Cache-first for the app shell so the app loads offline once visited.
 */
const VERSION = 'v1.18.0';
const CACHE = `sf-voice-studio-${VERSION}`;
const SHELL = [
    './',
    './index.html',
    './main.js',
    './style.css',
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
    // Stale-while-revalidate for the app shell, cache-first for everything else
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
