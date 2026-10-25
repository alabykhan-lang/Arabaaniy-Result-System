/* Arrabaaniy result portal — app shell cache.
   The portal is one HTML file, so keeping it (and the images it uses) on the phone
   is enough for the app to open with no network. Data comes from the roster cache
   and the mark outbox in the page itself. */
var CACHE = 'arq-shell-v2';
var SHELL = ['./portal_core.html', './school-logo.png', './proprietor-signature.png',
             './signature-placeholder.png', './manifest.webmanifest'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;      // Supabase and the AI API stay live
  if (url.pathname.indexOf('/api/') === 0) return;

  var isPage = req.mode === 'navigate' || /portal_core\.html$/.test(url.pathname);
  if (isPage) {
    // Network first, so a teacher always gets the newest build; the cached copy is the fallback.
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put('./portal_core.html', copy); });
          return res;
        })
        .catch(function () {
          return caches.match('./portal_core.html').then(function (hit) { return hit || caches.match(req); });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      });
    })
  );
});
