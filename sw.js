const CACHE_NAME = 'wrist-v2';
const urlsToCache = [
  './',
  './index.html',
  './main.js',
  './engine.js',
  './scheduler.js',
  './store.js',
  './ranking.js',
  './utils.js',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://unpkg.com/pinyin-pro@3.19.6/dist/index.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});