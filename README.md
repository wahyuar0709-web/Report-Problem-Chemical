# Report Problem Chemical (RDI)

Sistem pelaporan masalah material kimia gudang — PWA vanilla JS + Google Apps Script + Google Sheets.

**Derivat pola** dari Monitoring Unloading v2 (auth token, idempotency, audit log) agar mudah dirawat oleh tim yang sama.

## Struktur

| File | Peran |
|---|---|
| `index.html` | UI satu file: login, Laporan, Input Masalah, Dashboard, Admin, Akun |
| `Code.gs` | backend Apps Script: auth, CRUD laporan, master, foto Drive, audit |
| `manifest.json`, `sw.js`, `icons/` | PWA |
| `PANDUAN-DEPLOY.md` | langkah pasang lengkap |

## Spreadsheet database

Dibuat otomatis dan di-seed dari file referensi `List Material chemical Warehouse.xlsx`:

<https://docs.google.com/spreadsheets/d/1lc7e_uUKAa1hLHkBhDJ1e5ASp9OHs-lcMHAwxqHISAI/edit>

Tab:

- `Problem Report` — transaksi (22 kolom, ID `RPC-yyyyMMdd-nnn`)
- `Master Material` — 23 material kimia (rumpun Adhesive / UV Coating / Printing Ink)
- `Master Problem Type` — 7 kategori masalah
- `Master Supplier` — 2 supplier dari referensi
- `Master Batch` — register batch Level lot (hasil migrasi data lama)
- `Master User` — akun login (hash SHA-256)
- `AuditLog`, `Settings`

## Migrasi data lama (2026-10-25)

Data manual **`Report Problem Chemical.xlsx`** (sheet `Report` + `List Material`, folder Drive
`Chemical`) dimigrasi penuh via `tools/gsheets-audit/migrasi-data-lama-rpc.mjs`:

- 4 laporan → `Problem Report` dengan ID retroaktif (tanggal = tgl aksi pertama):
  `RPC-20260809-001/002`, `RPC-20260901-001`, `RPC-20261012-001`.
  Report No.4 asli berisi 2 batch dalam 1 laporan — digabung di kolom `Batch_Number` (dipisah `;`).
- Kategori `Sudah Kedaluwarsa` → `Kedaluwarsa / Batch Lama`; kategori kosong (No.4) → `Lainnya`
  (bisa diubah lewat Edit karena status masih Baru-an/terbuka di sheet).
- Status akhir lama: *Return to supplier* → `Selesai`; *digunakan produksi / menunggu QTR* → `Diproses`.
- Action 1–3 lama dirangkai bertanggal ke `Action_Taken`; `Reported_By`/`Action_PIC` = `Migrasi`.
- 9 foto tertanam diekstrak, diunggah ke folder foto Drive, ditandai `MIGRASI-No…-…jpg/png`,
  semua di-share anyone-with-link. Foto utama → `Photo_URL`; sisanya → kolom
  **`Photo_URL_Extra` (V)** dipisah ` | `.
- Link `File` lama (COA PDF `UH9108-90012SE…`) dicatat di `Description` laporan No.3.
- 33 baris register batch → tab `Master Batch`; tiap laporan migrasi log `MIGRASI` di `AuditLog`.
- Kolom V tidak disentuh backend (map-driven), aman untuk CREATE baru (dibiarkan kosong).

**Temuan mutu data asli (dipertahankan apa adanya, perlu koreksi manual bila yakin):**

- Tanggal lama format campur ISO vs `DD/MM/YYYY`; ada yang tertukar arah saat Excel
  mem-parsing `DD/MM` sebagai `MM/DD` (contoh: No.3 aksi-1 tertulis 2026-01-09 padahal teksnya
  "1 September 2026" — dipakai 2026-09-01).
- `Master Batch` `KBA6059075 20260306` (A05040010001): exp `2026-02-09` < mfg `2026-06-03` —
  hampir pasti salah ketik asli; suffix lot menandai mfg 6 Maret 2026. 4 baris batch lain
  memang tanpa tanggal mfg/exp di file aslinya.

## Status alur

`Baru` → `Diproses` → `Selesai` (ADMIN juga dapat: Edit saat Baru, Void dengan alasan)

## Foto bukti

Dikompres di HP (maks 1280px, JPEG 0.72) → dikirim base64 → disimpan ke folder Drive
`Report Problem Chemical - Foto` (dibuat otomatis; ID folder di Script Property `RPC_PHOTO_FOLDER_ID`).

## Akun awal

`admin/admin123`, `fauzi/fauzi123`, `risman/risman123` — **WAJIB ganti password setelah deploy.**

## Tips maintenance

- Naikkan `CACHE_VERSION` di `sw.js` (samakan dengan `APP_VERSION` di `index.html`) setiap deploy frontend.
- Jalankan `setupAll()` ulang bila struktur tab pernah diutak-atik manual — hanya mengisi yang hilang.
- Edit laporan hanya ADMIN & hanya saat status Baru; kolom kosong tidak bisa "dibersihkan" lewat edit (nilai kosong dibuang di pengirim) — untuk itu gunakan Void.
- Supplier/tipe yang dinonaktifkan bisa diaktifkan ulang dari tab Admin (tombol Aktifkan).
- Aksi tulis di-recek ke sheet `Master User` setiap eksekusi: akun yang dinonaktifkan langsung gagal tanpa menunggu sesi mati.
- Foto admin disimpan anyone-with-link READ (butuh dibuka lintas user) — jangan tempel foto sensitif non-produksi.
