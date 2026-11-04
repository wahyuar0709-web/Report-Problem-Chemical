/* ============================================================
   sw.js — Report Problem Chemical RDI
   PWA / Service Worker + Stale Cache Handling

   NAIKKAN CACHE_VERSION di SETIAP deploy yang mengubah index.html,
   manifest.json, atau ikon. Ini satu-satunya cara cache lama benar-
   benar dibuang. Selaraskan angka ini dengan APP_VERSION di index.html.
   ============================================================ */
var CACHE_VERSION = 'v1.4.12';
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

// Tambahkan pengurutan di header tabel laporan tanpa mengubah struktur data/API.
function enhanceReportTable(response) {
  if (!response || !response.ok) return Promise.resolve(response);
  var contentType = response.headers.get('content-type') || '';
  if (contentType.indexOf('text/html') === -1) return Promise.resolve(response);
  var headers = new Headers(response.headers);
  headers.delete('content-length');
  var sortScript = `<script>
(function(){
  function sortTable(table){
    if(table.dataset.sortReady) return;
    table.dataset.sortReady='1';
    Array.prototype.forEach.call(table.querySelectorAll('thead th'),function(th,index){
      th.tabIndex=0;
      th.title='Klik untuk mengurutkan';
      th.style.cursor='pointer';
      var indicator=document.createElement('span');
      indicator.setAttribute('aria-hidden','true');
      th.appendChild(document.createTextNode(' '));
      th.appendChild(indicator);
      function sort(){
        var body=table.tBodies[0];
        if(!body) return;
        var direction=th.dataset.sortDirection==='asc'?'desc':'asc';
        Array.prototype.forEach.call(table.querySelectorAll('thead th'),function(header){
          delete header.dataset.sortDirection;
          header.removeAttribute('aria-sort');
          var mark=header.querySelector('span[aria-hidden="true"]');
          if(mark) mark.textContent='';
        });
        th.dataset.sortDirection=direction;
        th.setAttribute('aria-sort',direction==='asc'?'ascending':'descending');
        indicator.textContent=direction==='asc'?'▲':'▼';
        var rows=Array.prototype.slice.call(body.rows);
        rows.sort(function(a,b){
          var av=(a.cells[index]?a.cells[index].textContent:'').trim();
          var bv=(b.cells[index]?b.cells[index].textContent:'').trim();
          var cmp=av.localeCompare(bv,undefined,{numeric:true,sensitivity:'base'});
          return direction==='asc'?cmp:-cmp;
        });
        rows.forEach(function(row){ body.appendChild(row); });
      }
      th.addEventListener('click',sort);
      th.addEventListener('keydown',function(event){
        if(event.key==='Enter'||event.key===' '){ event.preventDefault(); sort(); }
      });
    });
  }
  function init(){
    document.querySelectorAll('#lapTbl,#dashTbl').forEach(sortTable);
  }
  init();
  new MutationObserver(init).observe(document.body,{childList:true,subtree:true});
})();
</script>`;
  return response.clone().text().then(function (html) {
    if (html.indexOf('</body>') === -1) return response;
    return new Response(html.replace('</body>', sortScript + '</body>'), {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  });
}

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
        var path = url.pathname;
        var isHtml = path.endsWith('/') || path.endsWith('/index.html');
        var source = cached || networkFetch;
        return isHtml ? source.then(enhanceReportTable) : source;
      });
    })
  );
});
