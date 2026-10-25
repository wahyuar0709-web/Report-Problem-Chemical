# 🧪 PANDUAN DEPLOY — Report Problem Chemical v1.4.0

Aplikasi pelaporan masalah material kimia gudang RDI (kemasan rusak, tumpah, kadaluarsa, salah kirim, dll).

- **Spreadsheet database** (sudah dibuat, siap pakai):
  <https://docs.google.com/spreadsheets/d/1lc7e_uUKAa1hLHkBhDJ1e5ASp9OHs-lcMHAwxqHISAI/edit>
- **Frontend**: 1 file `index.html` (PWA vanilla JS + service worker + manifest)
- **Backend**: 1 file `Code.gs` (Google Apps Script, dipasang di spreadsheet di atas)
- **File referensi**: `List Material chemical Warehouse.xlsx` → sudah di-seed ke tab `Master Material` (23 material)

---

## ⛔ LANGKAH 0 — ZONA WAKTU (penting untuk ID & jam laporan)

1. Buka spreadsheet → **File > Settings** → Time zone = **GMT+07:00 Jakarta**
2. (Setelah paste kode, di Apps Script) **Project Settings > Time zone** = `Asia/Jakarta`

---

## 1️⃣ PASANG BACKEND

1. Buka spreadsheet di atas > **Extensions > Apps Script**
2. Hapus semua file `.gs` bawaan yang berisi contoh
3. Buat file `Code.gs` → paste seluruh isi file `Code.gs` dari folder ini
4. **Ctrl+S**
5. **(Wajib untuk fitur foto)** Panel kiri bagian **Services** → tombol **+** → pilih **Drive API versi v3** → **Add**. Supaya pemakaian bersama foto via `Drive.Permissions.create` aktif tanpa izin tambahan.
6. Pilih fungsi **`setupAll`** di dropdown atas → klik **Run ▶**
7. Saat diminta izin → **Review permissions → Advanced > Go to ... (unsafe) → Allow**
   *(peringatan normal untuk script milik Anda)*
8. Cek **View > Logs**: harus muncul `Setup selesai...`

Yang dibuat/dipastikan oleh setup (aman dijalankan berulang):

| Tab | Isi |
|---|---|
| `Problem Report` | header 22 kolom, kosong (data transaksi) |
| `Problem Actions` | log tahapan penanganan per laporan + bukti foto tiap tahap (isi otomatis dijalankan) |
| `Master Material` | 23 material dari file referensi (lem EVA/PVAc, UV coating, ink) |
| `Master Problem Type` | 7 kategori default (bisa ditambah lewat Admin) |
| `Master Supplier` | 2 supplier kimia dari data Flammable (Akzo Nobel, Sherwin-Williams) |
| `Master User` | admin/admin123, fauzi/fauzi123, risman/risman123 — **flag WAJIB ganti password aktif utk akun default**; lupa ganti = tak bisa ubah data |
| `Session Store` | sesi aktif (token disimpan sebagai hash, bukan token mentah); baris kadaluarsa dibersihkan otomatis saat login |
| `AuditLog` | jejak aksi |
| `Settings` | placeholder telegram (opsional) |

## 2️⃣ DEPLOY WEB APP

1. **Deploy > New deployment** → ⚙️ **Web app**
2. **Execute as**: **Me** · **Who has access**: **Anyone**
3. **Deploy** → copy URL `/exec`

> 🔄 Setiap kali `Code.gs` diubah: **Deploy > Manage deployments > ✏️ > New version > Deploy** (URL tetap).

## 3️⃣ PASANG FRONTEND

**Prodiksi = GitHub Pages (sudah aktif, HTTPS):**

<https://wahyuar0709-web.github.io/Report-Problem-Chemical/>

Setiap push ke branch `main` repo ini otomatis membangun ulang Pages (±1 menit).

| Opsi | Cara | Cocok untuk |
|---|---|---|
| **GitHub Pages** ✅ | sudah jalan — cukup bagikan URL di atas | **operasi harian, install PWA** |
| File lokal | buka `index.html` lewat Chrome | **dev/test saja** — SW/manifest tidak berjalan di `file://` |
| Netlify Drop | drag-drop ke app.netlify.com/drop | cadangan |

Pasang di HP (Chrome Android): buka URL Pages → menu ⋮ → *Install app / Add to Home screen*.
iOS (Safari): tombol Share → *Add to Home Screen* — instruksinya manual karena iOS tidak mendukung prompt instalasi otomatis.

Pemakaian pertama:
1. Buka aplikasi → klik **URL Web App** → paste URL `/exec` — disimpan di localStorage, cukup sekali
2. Login `admin` / `admin123`
3. **SEGERA GANTI PASSWORD** lewat tab **Akun**

---

## 📱 ALUR HARIAN

```
Operator menemukan masalah material kimia
   → tab [Input Masalah] → pilih material (dropdown rumpun: Adhesive/UV Coating/Printing Ink)
   → isi supplier, batch, lokasi, kategori, jumlah, foto (kamera HP, auto-kompres)
   → Kirim Laporan → ID: RPC-yyyyMMdd-nnn, status BARU
   ↓
[Proses] → status DIPROSES (Action_PIC tercatat)
   ↓
[Tutup] (wajib isi tindakan) → status SELESAI
   (salah input? ADMIN bisa [Edit] saat Baru, atau [Void] dengan alasan)
```

Dashboard: total per status, tren 14 hari, per kategori, per material, unduh CSV.

## ✅ CHECKLIST UJI (sebelum go-live)

| # | Skenario | Hasil diharapkan |
|---|---|---|
| 1 | Login salah 5x | terkunci sementara |
| 2 | Kirim laporan tanpa material/kategori | ditolak |
| 3 | Kirim laporan lengkap dgn foto | Ada di tab Laporan, ID RPC-..., foto bisa dibuka |
| 4 | Klik item → [Proses] | Chip jadi Diproses + ACTION_PIC terisi |
| 5 | [Tutup] tanpa tindakan | ditolak; dengan tindakan → Selesai |
| 6 | OPERATOR klik tab Admin | ditolak "Hanya ADMIN" |
| 7 | Admin void laporan | status Void + alasan tercetak |
| 8 | Matikan WiFi lalu buka tab Input | form tetap aktif; kirim = masuk antrean, terkirim otomatis saat pulih |
| 9 | Bagikan laporan saat off lalu nyalakan WiFi | antrean flush sendiri + toast "Semua laporan antrean terkirim" |
| 10 | Reset password user oleh admin | user yang bersangkutan wajib ganti password saat login berikutnya |
| 9 | Cek tab `AuditLog` | semua aksi terekam |

## ⚠️ CATATAN KEAMANAN

- Password disimpan salted & ter-iterasi (format `s1$hash$salt`, 1000 iterasi SHA-256); akun lama berformat hash polos di-upgrade otomatis saat login pertama setelah backend baru aktif
- Token sesi berumur 4 jam, bertahan disk (tab `Session Store`) — tidak hilang oleh evictasi cache; token tersimpan sebagai SHA-256 hash
- Akun default & hasil reset password oleh admin berbendera wajib-ganti-password sampai user menggantinya sendiri
- Antrean offline tersimpan lokal di HP; kirim ulang aman karena idempotency `requestId`
- Aksi tulis punya proteksi idempotency (retry tidak mencipta laporan kembar)
- URL `/exec` hanya menerima POST (halaman GET hanya membawa info aplikasi)
- Foto admin di-share anyone-with-link karena perlu bisa dibuka lintas user; simpan foto hanya bukti kerja
