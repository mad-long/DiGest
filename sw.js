// Service worker : met l'app en cache pour qu'elle fonctionne hors-ligne
// une fois installée (APK) ou ajoutée à l'écran d'accueil.
// Aucune requête vers un serveur tiers — uniquement les fichiers de cette app.
//
// IMPORTANT : à chaque nouvelle version, change CACHE_NAME ci-dessous
// (même numéro que APP_VERSION dans app.js) pour forcer la mise à jour
// du cache chez les personnes qui ont déjà installé l'app.

const CACHE_NAME = 'digest-cache-v1.0.0';
const FILES_TO_CACHE = [
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache d'abord, réseau en secours (utile seulement au tout premier chargement
// ou si un fichier a été mis à jour côté hébergement)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
