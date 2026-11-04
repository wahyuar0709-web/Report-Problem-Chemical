/* ============================================================
   sw.js — Report Problem Chemical RDI
   PWA / Service Worker + Stale Cache Handling

   NAIKKAN CACHE_VERSION di SETIAP deploy yang mengubah index.html,
   manifest.json, atau ikon. Ini satu-satunya cara cache lama benar-
   benar dibuang. Selaraskan angka ini dengan APP_VERSION di index.html.
   ============================================================ */
var CACHE_VERSION = 'v1.4.13';
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
      return Promise.all(SHELL_ASSETS.map(function (url) {
        return cache.add(url).catch(function () { /* asset opsional */ });
      }));
    })
  );
  // Update tetap menunggu konfirmasi pengguna melalui tombol "Muat ulang".
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names
        .filter(function (name) { return name.indexOf('rpc-shell-') === 0 && name !== CACHE_NAME; })
        .map(function (name) { return caches.delete(name); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Tambahkan Material_Code dan fitur sortir pada tabel laporan, tanpa
// mengubah struktur data maupun endpoint Apps Script.
function enhanceReportPage(response) {
  if (!response || !response.ok || !(response.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
    return Promise.resolve(response);
  }
  var headers = new Headers(response.headers);
  headers.delete('content-length');
  return response.clone().text().then(function (html) {
    var enhancement = `<script>
(function(){
  function headerLabel(th){ return (th.textContent||'').replace(/[▲▼]/g,'').trim(); }
  function addMaterialCode(table){
    if(table.querySelector('th[data-sort-key="material_code"]')) return;
    var head=table.tHead;
    if(!head||!head.rows.length) return;
    var headers=head.rows[0].cells;
    var materialIndex=-1;
    for(var i=0;i<headers.length;i++){
      if(headerLabel(headers[i])==='Material'){ materialIndex=i; break; }
    }
    if(materialIndex<0) return;
    var th=document.createElement('th');
    th.textContent='Material_Code';
    th.dataset.sortKey='material_code';
    head.rows[0].insertBefore(th,headers[materialIndex+1]||null);
    if(!table.tBodies.length) return;
    Array.prototype.forEach.call(table.tBodies[0].rows,function(row){
      var cell=row.insertCell(materialIndex+1);
      var id=row.getAttribute('data-id');
      var reports=window.S&&Array.isArray(window.S.list)?window.S.list:[];
      for(var j=0;j<reports.length;j++){
        if(String(reports[j].problem_id)===String(id)){
          cell.textContent=reports[j].material_code||'';
          break;
        }
      }
    });
  }
  function enableSort(table){
    if(!table.tHead||!table.tHead.rows.length) return;
    Array.prototype.forEach.call(table.tHead.rows[0].cells,function(th,index){
      if(th.dataset.sortReady) return;
      th.dataset.sortReady='1';
      th.tabIndex=0;
      th.title='Klik untuk mengurutkan';
      th.style.cursor='pointer';
      var mark=document.createElement('span');
      mark.setAttribute('aria-hidden','true');
      th.appendChild(document.createTextNode(' '));
      th.appendChild(mark);
      function sort(){
        var body=table.tBodies[0];
        if(!body) return;
        var direction=th.dataset.sortDirection==='asc'?'desc':'asc';
        Array.prototype.forEach.call(table.tHead.rows[0].cells,function(other){
          delete other.dataset.sortDirection;
          other.removeAttribute('aria-sort');
          var icon=other.querySelector('span[aria-hidden="true"]');
          if(icon) icon.textContent='';
        });
        th.dataset.sortDirection=direction;
        th.setAttribute('aria-sort',direction==='asc'?'ascending':'descending');
        mark.textContent=direction==='asc'?'▲':'▼';
        var rows=Array.prototype.slice.call(body.rows);
        rows.sort(function(a,b){
          var av=(a.cells[index]?a.cells[index].textContent:'').trim();
          var bv=(b.cells[index]?b.cells[index].textContent:'').trim();
          var compare=av.localeCompare(bv,undefined,{numeric:true,sensitivity:'base'});
          return direction==='asc'?compare:-compare;
        });
        rows.forEach(function(row){ body.appendChild(row); });
      }
      th.addEventListener('click',sort);
      th.addEventListener('keydown',function(event){
        if(event.key==='Enter'||event.key===' '){ event.preventDefault(); sort(); }
      });
    });
  }
  function enhance(){
    ['lapTbl','dashTbl'].forEach(function(id){
      var table=document.getElementById(id);
      if(table){ addMaterialCode(table); enableSort(table); }
    });
  }
  // Hapus autofill/query lama yang membuat laporan otomatis mencari "admin".
  function clearStaleSearch(){
    var search=document.getElementById('lfQ');
    if(search){
      search.setAttribute('autocomplete','off');
      if(search.value.trim().toLowerCase()==='admin') search.value='';
    }
  }
  clearStaleSearch();
  document.addEventListener('DOMContentLoaded',clearStaleSearch);
  document.addEventListener('click',function(event){
    var tab=event.target.closest&&event.target.closest('#tabsBar button[data-tab="lapor"]');
    if(tab) clearStaleSearch();
  },true);
  enhance();
  if(document.body){ new MutationObserver(enhance).observe(document.body,{childList:true,subtree:true}); }
})();
</script>`;
    var updated=html.replace(/<input([^>]*\bid="lfQ"[^>]*)>/i,function(input){
      return input.indexOf('autocomplete=')===-1?input.replace(/>$/,' autocomplete="off">'):input;
    });
    updated=updated.replace('</body>',enhancement+'</body>');
    return new Response(updated,{status:response.status,statusText:response.statusText,headers:headers});
  });
}

self.addEventListener('fetch', function (event) {
  var req=event.request;
  var url=new URL(req.url);
  // Apps Script dan request non-GET selalu langsung ke jaringan.
  if(req.method!=='GET'||url.origin!==self.location.origin) return;
  event.respondWith(caches.open(CACHE_NAME).then(function(cache){
    return cache.match(req).then(function(cached){
      var network=fetch(req).then(function(response){
        if(response&&response.ok) cache.put(req,response.clone());
        return response;
      }).catch(function(){ return cached; });
      var isHtml=url.pathname.endsWith('/')||url.pathname.endsWith('/index.html');
      var source=cached||network;
      return isHtml?source.then(enhanceReportPage):source;
    });
  }));
});
