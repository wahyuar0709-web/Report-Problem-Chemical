/* ============================================================
   sw.js — Report Problem Chemical RDI
   PWA / Service Worker + Stale Cache Handling

   NAIKKAN CACHE_VERSION di SETIAP deploy yang mengubah index.html,
   manifest.json, atau ikon. Ini satu-satunya cara cache lama benar-
   benar dibuang. Selaraskan angka ini dengan APP_VERSION di index.html.
   ============================================================ */
var CACHE_VERSION = 'v1.4.7';
var CACHE_NAME = 'rpc-shell-' + CACHE_VERSION;

// Hanya APP SHELL (asset statis) yang di-cache. JANGAN PERNAH masukkan
// endpoint Apps Script (data laporan, login, dst.) ke sini - itu harus
// selalu fresh dari jaringan, lihat fetch handler di bawah.
var SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // addAll gagal semua kalau satu asset 404 - pakai add satu-satu
      // supaya ikon yang belum ada belum mem-blok instalasi.
      return Promise.all(
        SHELL_ASSETS.map(function (url) {
          return cache.add(url).catch(function () { /* asset opsional, lewati kalau gagal */ });
        })
      );
    })
  );
  // JANGAN self.skipWaiting() otomatis di sini - biarkan index.html yang
  // memutuskan (lewat tombol "Muat ulang") supaya operator yang sedang
  // input data di tengah shift tidak tiba-tiba direload paksa.
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (n) { return n.indexOf('rpc-shell-') === 0 && n !== CACHE_NAME; })
          .map(function (n) { return caches.delete(n); }) // buang SEMUA cache versi lama
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);

  // ATURAN PALING PENTING: apapun yang BUKAN GET, atau BUKAN same-origin
  // (mis. request ke script.google.com / drive.google.com) TIDAK PERNAH
  // ditangani oleh SW ini - data laporan/sesi/foto harus selalu network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) {
    return; // biarkan browser handle seperti biasa (network passthrough)
  }

  // App shell: stale-while-revalidate supaya versi baru ter-deploy tetap
  // terunduh untuk kunjungan berikutnya tanpa memblokir pengguna.
  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(req).then(function (cached) {
        var networkFetch = fetch(req).then(function (res) {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(function () { return cached; });
        return cached || networkFetch;
      });
    })
  );
});
