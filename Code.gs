/**
 * ============================================================
 * REPORT PROBLEM CHEMICAL - BACKEND v1 (SATU FILE)
 * ============================================================
 * Sistem pelaporan masalah material kimia gudang RDI.
 * Referensi material: "List Material chemical Warehouse.xlsx" (tab FM, 23 item).
 * Arsitektur mengikuti pola terbukti dari Monitoring Unloading v2:
 *   - Login multi-user stateless (hash SHA-256, role ADMIN/OPERATOR)
 *   - Anti brute-force (5x salah -> jeda 5 menit via CacheService)
 *   - Token sesi opaque dengan masa berlaku (DestroySession lewat logout)
 *   - Idempotency untuk aksi mutating (requestId dedupe)
 *   - LockService saat menulis (anti race)
 *   - Jejak audit di sheet AuditLog
 *
 * STRUKTUR SPREADSHEET (dibuat/diperbaiki otomatis oleh setupAll()):
 *   Problem Report       - transaksi laporan masalah (tanpa awalan Master)
 *   Master Material      - daftar material kimia (dari file referensi)
 *   Master Problem Type  - kategori masalah
 *   Master Supplier      - pemasok
 *   Master User          - akun login
 *   AuditLog             - jejak aksi
 *   Settings             - konfigurasi (telegram, dsb.)
 *
 * CATATAN:
 *   - Jalankan setupAll() SEKALI setelah paste. Aman dijalankan berulang.
 *   - Akun awal: admin/admin123 (ADMIN), fauzi/fauzi123, risman/risman123
 *     (OPERATOR). SEGERA ganti password setelah deploy!
 *   - Foto laporan disimpan ke Drive folder "Report Problem Chemical - Foto",
 *     dibuat otomatis pada foto pertama; ID folder disimpan di Script Property
 *     RPC_PHOTO_FOLDER_ID.
 */

// ===================== KONFIGURASI =====================

var SHEET_NAMES = {
  REPORTS: 'Problem Report',
  ACTIONS: 'Problem Actions',
  MATERIALS: 'Master Material',
  TYPES: 'Master Problem Type',
  SUPPLIERS: 'Master Supplier',
  USERS: 'Master User',
  SESSIONS: 'Session Store',
  AUDIT: 'AuditLog',
  SETTINGS: 'Settings'
};

var STATUS = {
  BARU: 'Baru',
  DIPROSES: 'Diproses',
  SELESAI: 'Selesai',
  VOID: 'Void'
};

var ROLES = {
  ADMIN: 'ADMIN',
  OPERATOR: 'OPERATOR'
};

var REPORT_HEADERS = [
  'Problem_ID', 'Timestamp', 'Status',
  'Material_Code', 'Material_Name', 'Specification',
  'Supplier', 'Batch_Number', 'Arrival_Date', 'Location',
  'Problem_Category', 'Quantity', 'Unit', 'Description',
  'Photo_URL', 'Photo_URL_Extra', 'Reported_By',
  'Action_Taken', 'Action_PIC', 'Processed_At',
  'Closed_At', 'Closing_Note'
];

var MATERIAL_HEADERS = ['Material_Code', 'Material_Name', 'Specification', 'Material_Group', 'Status'];

// Tahapan penanganan laporan (dari terima sampai selesai, tiap tahap bisa bawa foto bukti).
var ACTION_HEADERS = ['Action_ID', 'Problem_ID', 'Stage_Code', 'Stage_Notes', 'Photo_URL', 'Photo_URL_Extra', 'Action_By', 'Action_At'];

var ACTION_STAGES = [
  { code: 'DITERIMA', label: 'Diterima & dicatat', auto: true },
  { code: 'PENGECEKAN', label: 'Pengecekan / konfirmasi kondisi' },
  { code: 'TINDAK_LANJUT', label: 'Tindak lanjut penanganan' },
  { code: 'DIKEMBALIKAN', label: 'Pengembalian / penggantian barang' },
  { code: 'SELESAI', label: 'Selesai & diverifikasi' }
];

function stageLabel_(code) {
  for (var i = 0; i < ACTION_STAGES.length; i++) {
    if (ACTION_STAGES[i].code === String(code)) return ACTION_STAGES[i].label;
  }
  return String(code);
}

// Seed dari "List Material chemical Warehouse.xlsx" (Referensi - 23 material).
// Material_Group: Rumpun berdasar nama material (Adhesive / UV Coating / Printing Ink).
var MATERIAL_SEED = [
  ['A06020010002', 'PVAc Glue Laminating Adhesive White', 'DS326', 'Adhesive', 'active'],
  ['A06010010001', 'EVA Wrapping Glue Clear', 'M-500', 'Adhesive', 'active'],
  ['A06010020007', 'EVA Edge Banding Glue  Natural Color', 'KS3935', 'Adhesive', 'active'],
  ['A06010030001', 'Glue(Packaging)', 'TB7788', 'Adhesive', 'active'],
  ['A06010040001', 'Glue stick(Packaging)', 'H-698', 'Adhesive', 'active'],
  ['A06010020001', 'EVA Edge Banding Glue  White', 'KS 3935W', 'Adhesive', 'active'],
  ['A06010020006', 'EVA Edge Banding Glue Black', 'KS3935B', 'Adhesive', 'active'],
  ['A06010020004', 'EVA Edge Banding Glue  White(curve)', 'DL6390W', 'Adhesive', 'active'],
  ['A06010020010', 'EVA Edge Banding Glue  Natural Color(curve)', 'P6768/15', 'Adhesive', 'active'],
  ['A05010010001', 'UV Filler IKEA Clear #1', '971-C-312', 'UV Coating', 'active'],
  ['A05020010008', 'UV Primer IKEA Basic White', 'UF9108-9001', 'UV Coating', 'active'],
  ['A05010010004', 'UV Filler IKEA Clear', 'UK9505', 'UV Coating', 'active'],
  ['A05030010013', 'UV Topcoat Clear 10°', 'UM8108-0010T', 'UV Coating', 'active'],
  ['A05030010003', 'UV Topcoat IKEA Basic White 25°', '973-W-517', 'UV Coating', 'active'],
  ['A05030010002', 'UV Topcoat No.11 Black #1', '973-30-576', 'UV Coating', 'active'],
  ['A05020010022', 'UV Primer IKEA Dark Gray23#', 'UF9108-5023T', 'UV Coating', 'active'],
  ['A05030010012', 'UV Topcoat IKEA Basic White 25°', 'UH9108-90012', 'UV Coating', 'active'],
  ['A05040010002', 'UV Topcoat No.11 Black #2', '973-C-834', 'UV Coating', 'active'],
  ['A05020010009', 'UV Primer IKEA No.11 Black', '971-B-455', 'UV Coating', 'active'],
  ['A05040010001', 'Printing Ink No.11 Black', '971-D-6475', 'Printing Ink', 'active'],
  ['A05040010005', 'Printing Ink Additives No.11 Black', '971-C-6474', 'Printing Ink', 'active'],
  ['A05020010002', 'UV Primer IKEA Basic White', '971-W-208', 'UV Coating', 'active'],
  ['A05010010002', 'UV Filler IKEA Clear #2', '971-C-199', 'UV Coating', 'active']
];

var TYPE_SEED = [
  ['Kemasan Rusak / Bocor', 'active'],
  ['Material Tumpah', 'active'],
  ['Kedaluwarsa / Batch Lama', 'active'],
  ['Jumlah Tidak Sesuai Dokumen', 'active'],
  ['Salah Kirim / Salah Label', 'active'],
  ['Mutu Tidak Sesuai', 'active'],
  ['Lainnya', 'active']
];

// Seed dari tab "Flammable" (Form STO WH) - supplier kimia yang tercatat resmi.
var SUPPLIER_SEED = [
  ['Akzo Nobel Coatings(Jiaxing)Co.,Ltd', 'active'],
  ['Sherwin-Williams(Nantong) CO., Ltd', 'active']
];

var USERS_HEADERS = ['Username', 'Password_Hash', 'Nama', 'Role', 'Aktif', 'Must_Change_Password'];
var AUDIT_HEADERS = ['Timestamp', 'User', 'Aksi', 'Ref_ID', 'Detail'];
var SESSION_HEADERS = ['Token_Hash', 'Username', 'Nama', 'Role', 'Created_At', 'Expires_At'];
var SETTINGS_DEFAULTS = [
  ['key', 'value'],
  ['telegram_bot_token', ''],
  ['telegram_admins', '']
];

var UNIT_SUGGESTIONS = ['Drum', 'Pail', 'Kartus', 'Sak', 'Kg', 'Liter', 'Pcs'];

var MAX_PHOTO_BYTES = 2000000; // ~2 MB hasil decode base64

// ===================== AUTH CORE =====================

function hashHex_(s) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var v = (bytes[i] + 256) % 256;
    hex += (v < 16 ? '0' : '') + v.toString(16);
  }
  return hex;
}

function hashPassword_(password) {
  return hashHex_(String(password));
}

var PWD_ITERATIONS = 1000;

function derivePassword_(password, salt) {
  var h = hashHex_(salt + ':' + hashHex_(password) + ':' + salt);
  for (var i = 0; i < PWD_ITERATIONS; i++) {
    h = hashHex_(h + '.' + salt);
  }
  return 's1$' + h + '$' + salt;
}

function verifyStoredPassword_(stored, password) {
  var s = String(stored || '');
  if (s.indexOf('s1$') === 0) {
    var parts = s.split('$');
    if (parts.length !== 3) return false;
    return derivePassword_(password, parts[2]) === s;
  }
  return hashHex_(password) === s;
}

function upgradeStoredPassword_(username, password) {
  try {
    var row = findUserRowIndex_(String(username).toLowerCase());
    if (row === -1) return;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAMES.USERS);
    if (String(sheet.getRange(row, 2).getValue()).indexOf('s1$') === 0) return;
    sheet.getRange(row, 2).setValue(derivePassword_(password, Utilities.getUuid().replace(/-/g, '')));
    logAudit_(null, 'UPGRADE_HASH', '', String(username));
  } catch (e) { /* upgrade bertahap, tidak pernah menghentikan login */ }
}

/** Baca semua akun dari sheet Master User. */
function readUsers_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.USERS);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, USERS_HEADERS.length).getValues();
  var out = [];
  values.forEach(function (r) {
    var uname = String(r[0] || '').toLowerCase().trim();
    if (!uname) return;
    out.push({
      username: uname,
      hash: String(r[1] || ''),
      nama: String(r[2] || ''),
      role: String(r[3] || '').toUpperCase().trim(),
      aktif: r[4] === true || String(r[4]).toLowerCase() === 'true',
      mustChange: String(r[5] || '').toLowerCase() === 'true' || String(r[5] || '').toLowerCase() === 'y'
    });
  });
  return out;
}

// ---------- Anti brute-force (CacheService, TTL 5 menit) ----------
var FAIL_LIMIT_ = 5;

function failKey_(u) { return 'rpc_fail_' + u; }

function getFailCount_(u) {
  var c = CacheService.getScriptCache().get(failKey_(u));
  return c ? parseInt(c, 10) : 0;
}

function registerFailedAttempt_(u) {
  CacheService.getScriptCache().put(failKey_(u), String(getFailCount_(u) + 1), 300);
}

function clearFailedAttempts_(u) {
  CacheService.getScriptCache().remove(failKey_(u));
}

/**
 * Validasi username+password. Melempar error berprefix "AUTH:" agar front-end
 * tahu harus kembali ke halaman login. Return {username, nama, role}.
 */
function authenticate_(username, password) {
  if (!username || !password) {
    throw new Error('AUTH: Username dan password wajib diisi.');
  }
  var uname = String(username).toLowerCase().trim();
  if (getFailCount_(uname) >= FAIL_LIMIT_) {
    throw new Error('AUTH: Terlalu banyak percobaan gagal. Coba lagi dalam beberapa menit.');
  }
  var users = readUsers_();
  var user = null;
  for (var i = 0; i < users.length; i++) {
    if (users[i].username === uname) { user = users[i]; break; }
  }
  var ok = !!user && user.aktif && verifyStoredPassword_(user.hash, password);
  if (!ok) {
    registerFailedAttempt_(uname);
    logAudit_(null, 'LOGIN_GAGAL', '', uname);
    throw new Error('AUTH: Username atau password salah.');
  }
  clearFailedAttempts_(uname);
  if (String(user.hash).indexOf('s1$') !== 0) {
    upgradeStoredPassword_(user.username, password);
  }
  return {
    username: user.username, nama: user.nama, role: user.role, mustChange: !!user.mustChange
  };
}

// ---------- Session/token (CacheService L1 + tab Session Store L2) ----------
// Cache bisa ter-evict kapan saja oleh quota Apps Script; sheet membuat sesi
// bertahan sampai exp sungguhan. Token disimpan HANYA sebagai hash.
var SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 jam

function sessionCacheKey_(token) { return 'rpc_sess_' + token; }

function sessionRowOf_(tokenHash) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.SESSIONS);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var vals = sheet.getRange(2, 1, lastRow - 1, SESSION_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === tokenHash) {
      return {
        row: i + 2,
        username: String(vals[i][1]),
        nama: String(vals[i][2]),
        role: String(vals[i][3]),
        exp: Number(vals[i][5])
      };
    }
  }
  return null;
}

function deleteSessionRow_(tokenHash) {
  var found = sessionRowOf_(tokenHash);
  if (!found) return;
  try {
    SpreadsheetApp.getActiveSpreadsheet()
      .getSheetByName(SHEET_NAMES.SESSIONS).deleteRow(found.row);
  } catch (e) { /* sheet mungkin tidak ada lagi */ }
}

function sweepSessions_() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.SESSIONS);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var vals = sheet.getRange(2, 1, lastRow - 1, SESSION_HEADERS.length).getValues();
    var now = Date.now();
    for (var i = vals.length - 1; i >= 0; i--) {
      if (Number(vals[i][5]) < now) sheet.deleteRow(i + 2);
    }
  } catch (e) { /* string */ }
}

function createSession_(user) {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var payload = {
    username: user.username,
    nama: user.nama,
    role: user.role,
    mustChange: !!user.mustChange,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000
  };
  var hash = hashHex_(token);
  CacheService.getScriptCache().put(sessionCacheKey_(token), JSON.stringify(payload), SESSION_TTL_SECONDS);
  try {
    SpreadsheetApp.getActiveSpreadsheet()
      .getSheetByName(SHEET_NAMES.SESSIONS)
      .appendRow([hash, user.username, user.nama || user.username, user.role, new Date(), new Date(payload.exp)]);
  } catch (e) { /* tab belum ada - cache tetap bekerja */ }
  return { token: token, expires_in: SESSION_TTL_SECONDS };
}

function validateSession_(token) {
  if (!token) {
    throw new Error('AUTH: Sesi tidak ditemukan. Silakan login kembali.');
  }
  var raw = CacheService.getScriptCache().get(sessionCacheKey_(token));
  if (!raw) {
    var found = sessionRowOf_(hashHex_(token));
    if (!found || !found.exp || found.exp < Date.now()) {
      throw new Error('AUTH: Sesi telah berakhir. Silakan login kembali.');
    }
    raw = JSON.stringify({
      username: found.username, role: found.role,
      nama: found.username, exp: found.exp
    });
    CacheService.getScriptCache().put(sessionCacheKey_(token), raw, SESSION_TTL_SECONDS);
  }
  var sess;
  try {
    sess = JSON.parse(raw);
  } catch (e) {
    CacheService.getScriptCache().remove(sessionCacheKey_(token));
    throw new Error('AUTH: Sesi tidak valid. Silakan login kembali.');
  }
  if (!sess || !sess.username || !sess.exp || sess.exp < Date.now()) {
    CacheService.getScriptCache().remove(sessionCacheKey_(token));
    throw new Error('AUTH: Sesi telah berakhir. Silakan login kembali.');
  }
  return {
    username: sess.username, nama: sess.nama, role: sess.role,
    mustChange: !!sess.mustChange
  };
}

function destroySession_(token) {
  if (!token) return;
  CacheService.getScriptCache().remove(sessionCacheKey_(token));
  deleteSessionRow_(hashHex_(token));
}

function requireAuth_(data) {
  if (!data || !data.token) {
    throw new Error('AUTH: Autentikasi diperlukan (token tidak ada).');
  }
  return validateSession_(data.token);
}

/**
 * Re-validasi user ke sheet Master User sebelum AKSI TULIS.
 * Menutup celah: akun yang sudah dinonaktifkan/role yang sudah diubah tetap
 * membawa payload sesi lama selama TTL token berjalan. Untuk aksi baca,
 * muatan datanya tidak sensitif - cukup validasi pasif.
 */
function refreshLiveUser_(user) {
  var users = readUsers_();
  var fresh = null;
  for (var i = 0; i < users.length; i++) {
    if (users[i].username === user.username) { fresh = users[i]; break; }
  }
  if (!fresh || !fresh.aktif) {
    throw new Error('AUTH: Akun sudah dinonaktifkan. Silakan login kembali.');
  }
  return { username: fresh.username, nama: fresh.nama, role: fresh.role, mustChange: !!fresh.mustChange };
}

function requireRole_(user, roles) {
  if (!user || roles.indexOf(user.role) === -1) {
    throw new Error('AKSES: Role "' + (user ? user.role : '?') + '" tidak berhak melakukan aksi ini.');
  }
}

// ===================== IDEMPOTENCY =====================

var MUTATING_ACTIONS = [
  'createProblem', 'startProcess', 'closeProblem', 'voidProblem', 'editProblem',
  'addProblemAction',
  'addSupplier', 'setSupplierAktif', 'addProblemType', 'setProblemTypeAktif',
  'createUser', 'resetPassword', 'setUserAktif', 'changePassword'
];
var IDEMPOTENCY_TTL_SECONDS = 600;

function idemCacheKey_(action, requestId) {
  return 'rpc_idem_' + action + '_' + requestId;
}

function getIdempotentResult_(action, requestId) {
  if (!requestId) return undefined;
  var raw = CacheService.getScriptCache().get(idemCacheKey_(action, requestId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return undefined;
  }
}

function saveIdempotentResult_(action, requestId, result) {
  if (!requestId) return;
  try {
    CacheService.getScriptCache().put(idemCacheKey_(action, requestId), JSON.stringify(result), IDEMPOTENCY_TTL_SECONDS);
  } catch (e) { /* diam-diam */ }
}

// ===================== SETUP (jalankan sekali) =====================

function setupAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  setupReportsSheet_(ss);
  setupActionsSheet_(ss);
  setupMaterialsSheet_(ss);
  setupTypesSheet_(ss);
  setupSuppliersSheet_(ss);
  setupUsersSheet_(ss);
  setupSessionsSheet_(ss);
  setupAuditSheet_(ss);
  setupSettingsSheet_(ss);

  SpreadsheetApp.flush();
  Logger.log('Setup selesai. Sheet: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
}

function setupReportsSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAMES.REPORTS);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAMES.REPORTS);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, REPORT_HEADERS.length).setValues([REPORT_HEADERS]);
    sheet.getRange(1, 1, 1, REPORT_HEADERS.length).setFontWeight('bold');
    Logger.log('Sheet "Problem Report" dibuat baru.');
  }
  return sheet;
}

function setupActionsSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAMES.ACTIONS);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAMES.ACTIONS);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, ACTION_HEADERS.length).setValues([ACTION_HEADERS]);
    sheet.getRange(1, 1, 1, ACTION_HEADERS.length).setFontWeight('bold');
    Logger.log('Sheet "Problem Actions" dibuat.');
  } else if (String(sheet.getRange(1, 1).getValue()) !== 'Action_ID') {
    sheet.getRange(1, 1, 1, ACTION_HEADERS.length).setValues([ACTION_HEADERS]);
    sheet.getRange(1, 1, 1, ACTION_HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

function setupMaterialsSheet_(ss) {
  var fresh = false;
  var sheet = ss.getSheetByName(SHEET_NAMES.MATERIALS);
  if (!sheet) { sheet = ss.insertSheet(SHEET_NAMES.MATERIALS); fresh = true; }
  if (fresh || sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, MATERIAL_HEADERS.length).setValues([MATERIAL_HEADERS]);
    sheet.getRange(1, 1, 1, MATERIAL_HEADERS.length).setFontWeight('bold');
    sheet.getRange(2, 1, MATERIAL_SEED.length, MATERIAL_SEED[0].length).setValues(MATERIAL_SEED);
    Logger.log('Sheet "Master Material" di-seed ' + MATERIAL_SEED.length + ' material (dari file referensi).');
  }
  return sheet;
}

function setupTypesSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAMES.TYPES);
  if (!sheet) { sheet = ss.insertSheet(SHEET_NAMES.TYPES); }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 2).setValues([['Type_Name', 'Status']]);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  }
  if (sheet.getLastRow() === 1 && !sheet.getRange(2, 1, 1, 1).getValue()) {
    sheet.getRange(2, 1, TYPE_SEED.length, 2).setValues(TYPE_SEED);
  }
  return sheet;
}

function setupSuppliersSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAMES.SUPPLIERS);
  if (!sheet) { sheet = ss.insertSheet(SHEET_NAMES.SUPPLIERS); }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 2).setValues([['Supplier', 'Status']]);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  }
  if (sheet.getLastRow() === 1 && !sheet.getRange(2, 1, 1, 1).getValue()) {
    sheet.getRange(2, 1, SUPPLIER_SEED.length, 2).setValues(SUPPLIER_SEED);
    Logger.log('Sheet "Master Supplier" di-seed ' + SUPPLIER_SEED.length + ' supplier.');
  }
  return sheet;
}

function setupUsersSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAMES.USERS);
  if (sheet.getLastRow() === 0) {
    var seed = [
      ['admin', derivePassword_('admin123', Utilities.getUuid().replace(/-/g, '')), 'Administrator', ROLES.ADMIN, true, 'true'],
      ['fauzi', derivePassword_('fauzi123', Utilities.getUuid().replace(/-/g, '')), 'Fauzi', ROLES.OPERATOR, true, 'true'],
      ['risman', derivePassword_('risman123', Utilities.getUuid().replace(/-/g, '')), 'Risman', ROLES.OPERATOR, true, 'true']
    ];
    sheet.getRange(1, 1, 1, USERS_HEADERS.length).setValues([USERS_HEADERS]);
    sheet.getRange(1, 1, 1, USERS_HEADERS.length).setFontWeight('bold');
    sheet.getRange(2, 1, seed.length, seed[0].length).setValues(seed);
    Logger.log('Sheet "Master User" dibuat. AKUN DEFAULT: admin/admin123, fauzi/fauzi123, risman/risman123. SEGERA GANTI PASSWORD (wajib: flag aktif)!');
  } else if (String(sheet.getRange(1, USERS_HEADERS.length).getValue()) !== 'Must_Change_Password') {
    sheet.getRange(1, USERS_HEADERS.length).setValue('Must_Change_Password');
    sheet.getRange(1, USERS_HEADERS.length).setFontWeight('bold');
    Logger.log('Header Master User diupgrade: kolom Must_Change_Password.');
  }
  return sheet;
}

function setupSessionsSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAMES.SESSIONS);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAMES.SESSIONS);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SESSION_HEADERS.length).setValues([SESSION_HEADERS]);
    sheet.getRange(1, 1, 1, SESSION_HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

function setupAuditSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAMES.AUDIT);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAMES.AUDIT);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]);
    sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

function setupSettingsSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAMES.SETTINGS);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, SETTINGS_DEFAULTS.length, 2).setValues(SETTINGS_DEFAULTS);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  }
}

/** Tulis baris audit. Tidak pernah melempar error (logging tidak memutus alur utama). */
function logAudit_(user, aksi, refId, detail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAMES.AUDIT) || setupAuditSheet_(ss);
    sheet.appendRow([
      new Date(),
      user ? (user.nama || user.username || '-') : (aksi === 'LOGIN_GAGAL' ? (detail || '-') : '-'),
      aksi || '',
      refId || '',
      detail || ''
    ]);
  } catch (e) { /* abaikan */ }
}

// ===================== HELPERS BACA MASTER =====================

function getHeaderMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) { map[String(h).trim()] = i + 1; });
  return map;
}

var ACTIVE_TEXTS = ['active', 'aktif', 'true', 'yes', 'ya'];
function isActiveVal_(v) {
  if (v === true) return true;
  return ACTIVE_TEXTS.indexOf(String(v).toLowerCase().trim()) !== -1;
}

function readActiveMaterials_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.MATERIALS);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  // Status dicari lewat HEADER, bukan indeks kolom terakhir -
  // menambah kolom baru di kanan tidak boleh mematikan filter aktif.
  var map = getHeaderMap_(sheet);
  var sCol = map['Status'];
  var lastCol = sheet.getLastColumn();
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values
    .filter(function (r) { return r[0] && (sCol ? isActiveVal_(r[sCol - 1]) : isActiveVal_(r[lastCol - 1])); })
    .map(function (r) {
      return {
        code: String(r[0]),
        name: String(r[1] || ''),
        spec: String(r[2] || ''),
        group: String(r[3] || '')
      };
    });
}

function readActiveTypes_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.TYPES);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  return values
    .filter(function (r) { return r[0] && isActiveVal_(r[1]); })
    .map(function (r) { return String(r[0]); });
}

function readActiveSuppliers_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.SUPPLIERS);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  return values
    .filter(function (r) { return r[0] && isActiveVal_(r[1]); })
    .map(function (r) { return String(r[0]); });
}

function readRecentAudit_(limit) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.AUDIT);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var n = Math.min(lastRow - 1, limit || 100);
  var start = lastRow - n + 1;
  var values = sheet.getRange(start, 1, n, AUDIT_HEADERS.length).getValues();
  var toIso = function (v) {
    if (!v) return '';
    var d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  };
  return values.reverse().map(function (r) {
    return { timestamp: toIso(r[0]), user: r[1], aksi: r[2], ref_id: r[3], detail: r[4] };
  });
}

/** Semua baris master (termasuk nonaktif) untuk kelola lewat tab Admin. */
function readMasterRows_(sheetName, colName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var map = getHeaderMap_(sheet);
  var kCol = map[colName], sCol = map['Status'];
  if (!kCol || !sCol) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  return values.filter(function (r) { return r[kCol - 1]; }).map(function (r) {
    return { name: String(r[kCol - 1]), aktif: isActiveVal_(r[sCol - 1]) };
  });
}

function readAllMasters_() {
  return {
    suppliers: readMasterRows_(SHEET_NAMES.SUPPLIERS, 'Supplier'),
    types: readMasterRows_(SHEET_NAMES.TYPES, 'Type_Name')
  };
}

// ===================== ENTRY POINTS =====================

function doGet() {
  return ContentService.createTextOutput(
    'Report Problem Chemical API. Halaman aplikasi: https://wahyuar0709-web.github.io/Report-Problem-Chemical/');
}

function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) {
      return respondError_('Body request kosong.');
    }
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    var PUBLIC_ACTIONS = ['login', 'logout'];
    var user = PUBLIC_ACTIONS.indexOf(action) === -1 ? requireAuth_(data) : null;

    var isMutating = MUTATING_ACTIONS.indexOf(action) !== -1;
    if (isMutating && user) user = refreshLiveUser_(user);
    if (user && user.mustChange && isMutating && action !== 'changePassword') {
      return respondError_('GANTI_PASSWORD: ganti password dulu lewat tab Akun.');
    }
    var requestId = data.requestId;
    if (isMutating) {
      var replay = getIdempotentResult_(action, requestId);
      if (replay !== undefined) {
        return respondJson_({ ok: true, data: replay, me: user, idempotentReplay: true });
      }
    }

    var result;
    switch (action) {
      // ---- publik ----
      case 'login': result = loginAction_(data); break;
      case 'logout': result = logoutAction_(data); break;

      // ---- baca ----
      case 'bootstrap': result = bootstrapData_(); break;
      case 'list': result = listProblems_(data.date_from, data.date_to, data.status, data.category, data.material, data.q); break;
      case 'listActions':
        result = listProblemActions_(data.problem_id);
        break;
      case 'users':
        requireRole_(user, [ROLES.ADMIN]);
        result = readUserListPublic_();
        break;
      case 'masterAll':
        requireRole_(user, [ROLES.ADMIN]);
        result = readAllMasters_();
        break;
      case 'audit':
        requireRole_(user, [ROLES.ADMIN]);
        result = readRecentAudit_(parseInt(data.limit, 10) || 100);
        break;

      // ---- laporan (OPERATOR + ADMIN) ----
      case 'createProblem':
        requireRole_(user, [ROLES.OPERATOR, ROLES.ADMIN]);
        result = createProblem_(data, user);
        break;
      case 'startProcess':
        requireRole_(user, [ROLES.OPERATOR, ROLES.ADMIN]);
        result = startProcess_(data, user);
        break;
      case 'closeProblem':
        requireRole_(user, [ROLES.OPERATOR, ROLES.ADMIN]);
        result = closeProblem_(data, user);
        break;
      case 'addProblemAction':
        requireRole_(user, [ROLES.OPERATOR, ROLES.ADMIN]);
        result = addProblemAction_(data, user);
        break;

      // ---- ADMIN saja ----
      case 'voidProblem': requireRole_(user, [ROLES.ADMIN]); result = voidProblem_(data, user); break;
      case 'editProblem': requireRole_(user, [ROLES.ADMIN]); result = editProblem_(data, user); break;
      case 'addSupplier': requireRole_(user, [ROLES.ADMIN]); result = addSupplier_(data, user); break;
      case 'setSupplierAktif': requireRole_(user, [ROLES.ADMIN]); result = setSupplierAktif_(data, user); break;
      case 'addProblemType': requireRole_(user, [ROLES.ADMIN]); result = addProblemType_(data, user); break;
      case 'setProblemTypeAktif': requireRole_(user, [ROLES.ADMIN]); result = setProblemTypeAktif_(data, user); break;
      case 'createUser': requireRole_(user, [ROLES.ADMIN]); result = createUser_(data, user); break;
      case 'resetPassword': requireRole_(user, [ROLES.ADMIN]); result = resetPassword_(data, user); break;
      case 'setUserAktif': requireRole_(user, [ROLES.ADMIN]); result = setUserAktif_(data, user); break;

      // ---- semua role ----
      case 'changePassword': result = changePassword_(data, user); break;

      default:
        return respondError_('Action tidak dikenal: ' + action);
    }

    if (isMutating) saveIdempotentResult_(action, requestId, result);

    return respondJson_({ ok: true, data: result, me: user });
  } catch (err) {
    return respondError_(err.message);
  }
}

// ===================== ACTIONS: LOGIN & PASSWORD =====================

function loginAction_(data) {
  var me = authenticate_(data.username, data.password);
  logAudit_(me, 'LOGIN', '', me.role);
  sweepSessions_();
  var session = createSession_(me);
  return {
    nama: me.nama, role: me.role, username: me.username,
    must_change: me.mustChange,
    units: UNIT_SUGGESTIONS,
    token: session.token, expires_in: session.expires_in
  };
}

function logoutAction_(data) {
  destroySession_(data && data.token);
  return { ok: true };
}

function changePassword_(data, me) {
  requireFields_(data, ['old_password', 'new_password']);
  if (String(data.new_password).length < 6) {
    throw new Error('Password baru minimal 6 karakter.');
  }
  var uname = me.username.toLowerCase();
  var users = readUsers_();
  var found = null;
  for (var i = 0; i < users.length; i++) {
    if (users[i].username === uname) { found = users[i]; found._row = i + 2; break; }
  }
  if (!found) throw new Error('AUTH: Akun tidak ditemukan.');
  if (!verifyStoredPassword_(found.hash, data.old_password)) {
    throw new Error('Password lama salah.');
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.USERS);
  sheet.getRange(found._row, 2).setValue(
    derivePassword_(data.new_password, Utilities.getUuid().replace(/-/g, '')));
  if (found.mustChange) sheet.getRange(found._row, 6).setValue('false');
  try {
    if (data.token && data.token !== undefined) {
      var cache = CacheService.getScriptCache();
      var raw = cache.get(sessionCacheKey_(data.token));
      if (raw) {
        var sess = JSON.parse(raw);
        sess.mustChange = false;
        cache.put(sessionCacheKey_(data.token), JSON.stringify(sess), SESSION_TTL_SECONDS);
      }
    }
  } catch (e) { /* pembaruan sesi non-kritis */ }
  logAudit_(me, 'GANTI_PASSWORD', '', uname);
  return { ok: true };
}

// ===================== MANAJEMEN USER (ADMIN) =====================

/** Daftar user untuk tampilan admin (tanpa hash). */
function readUserListPublic_() {
  return readUsers_().map(function (u) {
    return { username: u.username, nama: u.nama, role: u.role, aktif: u.aktif };
  });
}

function findUserRowIndex_(uname) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.USERS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var vals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).toLowerCase().trim() === uname) return i + 2;
  }
  return -1;
}

function createUser_(data, byUser) {
  requireFields_(data, ['username', 'password', 'nama', 'role']);
  var uname = String(data.username).toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,20}$/.test(uname)) {
    throw new Error('Username 3-20 karakter, hanya huruf kecil/angka/titik/garis.');
  }
  var roleUp = String(data.role).toUpperCase();
  var validRoles = Object.keys(ROLES).map(function (k) { return ROLES[k]; });
  if (validRoles.indexOf(roleUp) === -1) {
    throw new Error('Role harus salah satu dari: ADMIN, OPERATOR.');
  }
  if (String(data.password).length < 6) {
    throw new Error('Password minimal 6 karakter.');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Cek duplikat DI DALAM lock (anti race dua klik cepat / request paralel).
    if (findUserRowIndex_(uname) !== -1) {
      throw new Error('Username "' + uname + '" sudah dipakai.');
    }
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.USERS);
    sheet.appendRow([uname, derivePassword_(data.password, Utilities.getUuid().replace(/-/g, '')), String(data.nama).trim(), roleUp, true, 'false']);
    logAudit_(byUser, 'USER_BUAT', '', uname + ' (' + roleUp + ')');
    return { username: uname, nama: String(data.nama).trim(), role: roleUp, aktif: true };
  } finally {
    lock.releaseLock();
  }
}

function resetPassword_(data, byUser) {
  requireFields_(data, ['username', 'new_password']);
  if (String(data.new_password).length < 6) {
    throw new Error('Password baru minimal 6 karakter.');
  }
  var uname = String(data.username).toLowerCase().trim();
  var rowIndex = findUserRowIndex_(uname);
  if (rowIndex === -1) throw new Error('User "' + uname + '" tidak ditemukan.');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.USERS);
    sheet.getRange(rowIndex, 2).setValue(
      derivePassword_(data.new_password, Utilities.getUuid().replace(/-/g, '')));
    sheet.getRange(rowIndex, 6).setValue('true');
    clearFailedAttempts_(uname);
    logAudit_(byUser, 'USER_RESET_PASSWORD', '', uname);
    return { username: uname, ok: true };
  } finally {
    lock.releaseLock();
  }
}

function setUserAktif_(data, byUser) {
  requireFields_(data, ['username']);
  if (data.aktif === undefined) throw new Error('Field wajib belum diisi: aktif');
  var uname = String(data.username).toLowerCase().trim();
  if (uname === byUser.username) {
    throw new Error('Tidak bisa menonaktifkan akun sendiri.');
  }
  var target = readUsers_().filter(function (u) { return u.username === uname; })[0];
  if (!target) throw new Error('User "' + uname + '" tidak ditemukan.');

  var jadiAktif = (data.aktif === true || data.aktif === 'true');
  if (!jadiAktif && target.role === ROLES.ADMIN) {
    var adminAktif = readUsers_().filter(function (u) {
      return u.role === ROLES.ADMIN && u.aktif;
    }).length;
    if (adminAktif <= 1) throw new Error('Minimal harus ada 1 ADMIN aktif.');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowIndex = findUserRowIndex_(uname);
    if (rowIndex === -1) throw new Error('User "' + uname + '" tidak ditemukan.');
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.USERS);
    sheet.getRange(rowIndex, 5).setValue(jadiAktif);
    logAudit_(byUser, jadiAktif ? 'USER_AKTIFKAN' : 'USER_NONAKTIFKAN', '', uname);
    return { username: uname, aktif: jadiAktif };
  } finally {
    lock.releaseLock();
  }
}

// ===================== HELPERS I/O DINAMIS =====================

function getReportsSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.REPORTS);
}

function buildRow_(sheet, fields) {
  var map = getHeaderMap_(sheet);
  var lastCol = sheet.getLastColumn();
  var row = new Array(lastCol);
  for (var i = 0; i < lastCol; i++) row[i] = '';
  Object.keys(fields).forEach(function (h) {
    if (map[h]) row[map[h] - 1] = fields[h];
  });
  return row;
}

function rowToObj_(headerMap, rowArray) {
  var obj = {};
  Object.keys(headerMap).forEach(function (h) { obj[h] = rowArray[headerMap[h] - 1]; });
  return obj;
}

function findRowIndexById_(sheet, id) {
  var map = getHeaderMap_(sheet);
  var idCol = map['Problem_ID'];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var values = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === id) return i + 2;
  }
  return -1;
}

function writeObjBack_(sheet, rowRange, map, obj) {
  // GUARD anti kerusakan senyap: sheet yang memakai aplikasi ini harus
  // TANPA formula. Kalau ada formula (mis. kolom Cek yang ditambah manual),
  // tulis-balik nilai akan menggantinya angka statis tanpa error apa pun -
  // hentikan saja dan buat admin sadar, daripada merusak data diam-diam.
  var fml = rowRange.getFormulas()[0];
  for (var fi = 0; fi < fml.length; fi++) {
    if (fml[fi]) {
      throw new Error('SHEET: Ada formula di kolom ' + (fi + 1) +
        ' - kosongkan/hapus formula sebelum lewat aplikasi.');
    }
  }
  var auditMeta = obj._meta_audit || null;
  delete obj._meta_audit;
  var newRow = rowRange.getValues()[0].slice();
  Object.keys(obj).forEach(function (h) {
    if (map[h]) newRow[map[h] - 1] = obj[h];
  });
  rowRange.setValues([newRow]);
  if (auditMeta) {
    logAudit_(auditMeta.by, auditMeta.aksi, obj['Problem_ID'] || '', auditMeta.detail || '');
  }
}

// ===================== GENERATOR ID =====================

function generateProblemId(dateObj) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var tz = Session.getScriptTimeZone();
    var dateStr = Utilities.formatDate(dateObj || new Date(), tz, 'yyyyMMdd');
    var prefix = 'RPC-' + dateStr + '-';

    var sheet = getReportsSheet_();
    var map = getHeaderMap_(sheet);
    var idCol = map['Problem_ID'];
    var lastRow = sheet.getLastRow();

    var maxSeq = 0;
    if (lastRow > 1) {
      var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
      ids.forEach(function (r) {
        var id = r[0];
        if (typeof id === 'string' && id.indexOf(prefix) === 0) {
          var seq = parseInt(id.substring(prefix.length), 10);
          if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
        }
      });
    }
    return prefix + ('000' + (maxSeq + 1)).slice(-3);
  } finally {
    lock.releaseLock();
  }
}

function generateActionId(dateObj) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var tz = Session.getScriptTimeZone();
    var dateStr = Utilities.formatDate(dateObj || new Date(), tz, 'yyyyMMdd');
    var prefix = 'PCA-' + dateStr + '-';

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.ACTIONS);
    if (!sheet) return prefix + '001';
    var lastRow = sheet.getLastRow();
    var maxSeq = 0;
    if (lastRow > 1) {
      var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      ids.forEach(function (r) {
        var id = typeof r[0] === 'string' ? r[0] : '';
        if (id.indexOf(prefix) === 0) {
          var seq = parseInt(id.substring(prefix.length), 10);
          if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
        }
      });
    }
    return prefix + ('000' + (maxSeq + 1)).slice(-3);
  } finally {
    lock.releaseLock();
  }
}

// ===================== VALIDASI MASTER =====================

function findMaterial_(code) {
  var needle = String(code || '').toLowerCase().trim();
  var all = readActiveMaterials_();
  for (var i = 0; i < all.length; i++) {
    if (all[i].code.toLowerCase() === needle) return all[i];
  }
  return null;
}

// ===================== TAHAPAN PENANGANAN (Problem Actions) =====================

function getActionsSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.ACTIONS);
}

function appendActionRow_(problemId, stageCode, notes, photoUrl, byUser) {
  var sheet = getActionsSheet_();
  if (!sheet) {
    try {
      sheet = setupActionsSheet_(SpreadsheetApp.getActiveSpreadsheet());
    } catch (eSetup) {
      return null;
    }
  }
  var now = new Date();
  var fields = {};
  fields['Action_ID'] = generateActionId(now);
  fields['Problem_ID'] = String(problemId);
  fields['Stage_Code'] = String(stageCode);
  fields['Stage_Notes'] = String(notes || '').trim();
  fields['Photo_URL'] = photoUrl || '';
  fields['Photo_URL_Extra'] = '';
  fields['Action_By'] = byUser && byUser.nama ? byUser.nama : '';
  fields['Action_At'] = now;
  sheet.appendRow(buildRow_(sheet, fields));
  return {
    action_id: fields['Action_ID'], problem_id: fields['Problem_ID'],
    stage_code: fields['Stage_Code'], stage_label: stageLabel_(stageCode),
    notes: fields['Stage_Notes'], photo_url: fields['Photo_URL'],
    action_by: fields['Action_By'], action_at: now
  };
}

function listProblemActions_(problemId) {
  if (!problemId) throw new Error('problem_id wajib diisi.');
  var sheet = getActionsSheet_();
  if (!sheet || sheet.getLastRow() < 2) return [];
  var map = getHeaderMap_(sheet);
  var lastCol = sheet.getLastColumn();
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  var out = [];
  rows.forEach(function (r) {
    var obj = rowToObj_(map, r);
    if (String(obj['Problem_ID']) !== String(problemId)) return;
    var extras = String(obj['Photo_URL_Extra'] || '').split(' | ').filter(function (u) { return u; });
    out.push({
      action_id: String(obj['Action_ID'] || ''),
      problem_id: String(obj['Problem_ID'] || ''),
      stage_code: String(obj['Stage_Code'] || ''),
      stage_label: stageLabel_(obj['Stage_Code']),
      notes: String(obj['Stage_Notes'] || ''),
      photo_url: String(obj['Photo_URL'] || ''),
      photo_url_extra: extras.join(' | '),
      action_by: String(obj['Action_By'] || ''),
      action_at: obj['Action_At']
    });
  });
  out.sort(function (a, b) {
    return new Date(a.action_at).getTime() - new Date(b.action_at).getTime();
  });
  return out;
}

function addProblemAction_(data, byUser) {
  requireFields_(data, ['problem_id', 'stage_code']);
  var stage = String(data.stage_code).trim().toUpperCase();
  var valid = false;
  for (var i = 0; i < ACTION_STAGES.length; i++) {
    if (ACTION_STAGES[i].code === stage && !ACTION_STAGES[i].auto) valid = true;
  }
  if (!valid) {
    throw new Error('TAHAPAN: Kode tahapan tidak dikenal / bukan tahapan manual: "' + stage + '".');
  }

  var sheet = getReportsSheet_();
  var rowIndex = findRowIndexById_(sheet, data.problem_id);
  if (rowIndex === -1) throw new Error('Problem_ID tidak ditemukan: ' + data.problem_id);
  var map = getHeaderMap_(sheet);
  var obj = rowToObj_(map, sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0]);
  var st = String(obj['Status'] || '');
  if (st === STATUS.VOID) {
    throw new Error('TRANSISI: Laporan berstatus Void - tidak bisa ditambah tahapan.');
  }
  if (st === STATUS.SELESAI) {
    throw new Error('TRANSISI: Laporan sudah Selesai - tidak bisa ditambah tahapan baru.');
  }

  if (stage === 'SELESAI') {
    updateProblem_(data.problem_id, [STATUS.BARU, STATUS.DIPROSES], function (o) {
      var now = new Date();
      o['Status'] = STATUS.SELESAI;
      o['Closing_Note'] = String(data.notes || '').trim();
      if (!o['Action_PIC']) o['Action_PIC'] = byUser.nama;
      if (!o['Processed_At']) o['Processed_At'] = now;
      o['Closed_At'] = now;
      o._meta_audit = { by: byUser, aksi: 'TAHAPAN_SELESAI', detail: String(data.notes || '').trim() };
    });
  }

  var photoUrl = '';
  if (data.photo_b64) {
    var tz = Session.getScriptTimeZone();
    var stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd-HHmmss');
    photoUrl = savePhoto_(data.photo_b64, stamp + '_' + String(data.problem_id) + '_' + stage + '.jpg');
  }

  var out = appendActionRow_(data.problem_id, stage, data.notes, photoUrl, byUser);
  logAudit_(byUser, 'TAHAPAN_BARU', data.problem_id, stage + (photoUrl ? ' (foto)' : ''));
  return out;
}

function appendSelesaiRowIfMissing_(problemId, byUser, notes) {
  try {
    var sheet = getActionsSheet_();
    var hasSelesai = false;
    if (sheet && sheet.getLastRow() >= 2) {
      var cols = sheet.getRange(2, 2, sheet.getLastRow() - 1, 2).getValues();
      cols.forEach(function (r) {
        if (String(r[0]) === String(problemId) && String(r[1]) === 'SELESAI') hasSelesai = true;
      });
    }
    if (!hasSelesai) appendActionRow_(problemId, 'SELESAI', notes || 'Penutupan laporan', '', byUser);
  } catch (e) { /* timeline best-effort - penutupan tidak boleh gagal karenanya */ }
}

function assertActiveType_(name) {
  var aktif = readActiveTypes_();
  if (aktif.indexOf(String(name).trim()) === -1) {
    throw new Error('Kategori masalah "' + name + '" tidak ditemukan atau tidak aktif. Pilih dari daftar.');
  }
}

function normalizeDateVal_(v) {
  // Terima 'yyyy-MM-dd' string; return Date atau null.
  // Round-trip check menolak rollover (mis. '2024-13-32' yang biasanya lolos
  // dan tersimpan sebagai tanggal berbeda tanpa error).
  if (!v) return null;
  if (v instanceof Date) return v;
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 ||
        d.getDate() !== Number(m[3])) return null;
    return d;
  }
  var d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}

// ===================== FOTO (DRIVE) =====================

var DRIVE_FOLDER_PROP = 'RPC_PHOTO_FOLDER_ID';

function getOrCreatePhotoFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty(DRIVE_FOLDER_PROP);
  if (folderId) {
    try {
      var f = DriveApp.getFolderById(folderId);
      return f;
    } catch (e) { /* folder hilang -> buat baru */ }
  }
  var it = DriveApp.getFoldersByName('Report Problem Chemical - Foto');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('Report Problem Chemical - Foto');
  props.setProperty(DRIVE_FOLDER_PROP, folder.getId());
  return folder;
}

/**
 * Simpan foto base64 ke Drive. Return URL view.
 * Foto dibuat SEBELUM baris laporan ditulis - jika UPLOAD gagal, laporan tidak dibuat.
 * Gagal SHARE (public link) TIDAK membatalkan laporan: file tetap tersimpan,
 * kejadian dicatat ke AuditLog (FOTO_SHARE_GAGAL), share bisa diperbaiki belakangan.
 */
function savePhoto_(b64, fileName) {
  var raw = String(b64 || '');
  // boleh dikirim dengan/m tanpa data-url prefix
  var m = raw.match(/^data:image\/(\w+);base64,(.*)$/);
  var mime = 'image/jpeg';
  if (m) { raw = m[2]; mime = 'image/' + m[1]; }
  // Guard murah (panjang string) SEBELUM decode yang mahal:
  // 4/3 = rasio base64, +4 toleransi padding; melewati ini = pasti oversize.
  var maxB64 = Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 4;
  if (raw.length > maxB64) {
    throw new Error('FOTO: Ukuran foto terlalu besar (maksimal ' + Math.round(MAX_PHOTO_BYTES / 1000) + ' KB).');
  }
  var bytes = Utilities.base64Decode(raw);
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw new Error('FOTO: Ukuran foto terlalu besar (maksimal ' + Math.round(MAX_PHOTO_BYTES / 1000) + ' KB).');
  }
  var blob = Utilities.newBlob(bytes, mime, fileName);
  var folder = getOrCreatePhotoFolder_();
  var file = folder.createFile(blob);
  Utilities.sleep(300); // beri waktu Drive "mendaftarkan" file sebelum share (kasus null-arg yang sudah terbukti)
  var errPecahan = [];
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.READ);
  } catch (e1) {
    errPecahan.push('setSharing: ' + (e1 && e1.message ? e1.message : String(e1)));
    // Fallback 1: Drive API v3 (Advanced Service - WAJIB ditambahkan di editor: Services > + > Drive API v3).
    // Scope "drive" SUDAH ada dari izin DriveApp, jadi tidak butuh izin baru.
    var shareOk = false;
    try {
      Drive.Permissions.create(
        { role: 'reader', type: 'anyone', allowFileDiscovery: false },
        file.getId(),
        { supportsAllDrives: true }
      );
      shareOk = true;
    } catch (eDrive) {
      errPecahan.push('DriveAPI: ' + (eDrive && eDrive.message ? eDrive.message : String(eDrive)));
      // Fallback 2: REST via UrlFetchApp (butuh scope script.external_request yang diberi saat izin).
      try {
        var resp = UrlFetchApp.fetch(
          'https://www.googleapis.com/drive/v3/files/' + file.getId() + '/permissions?supportsAllDrives=true',
          {
            method: 'post',
            contentType: 'application/json',
            headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
            payload: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false })
          });
        if (resp.getResponseCode() < 300) shareOk = true; else errPecahan.push('REST: HTTP ' + resp.getResponseCode());
      } catch (e2) { errPecahan.push('REST: ' + (e2 && e2.message ? e2.message : String(e2))); }
    }
    if (!shareOk && errPecahan.length) {
      // Non-fatal: laporan tetap dibuat, file tetap ada di folder foto.
      logAudit_(null, 'FOTO_SHARE_GAGAL', file.getId(), errPecahan.join(' || ').slice(0, 400));
    }
  }
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

// ===================== CREATE / UPDATE LAPORAN =====================

/**
 * OPERATOR/ADMIN buat laporan masalah baru.
 * Wajib: material_code, problem_category. Opsional: supplier, batch,
 * arrival_date (yyyy-MM-dd), lokasi, quantity, unit, description, photo (base64).
 */
function createProblem_(data, byUser) {
  requireFields_(data, ['material_code', 'problem_category']);

  var material = findMaterial_(data.material_code);
  if (!material) {
    throw new Error('MATERIAL: Kode "' + data.material_code + '" tidak ditemukan / tidak aktif di Master Material.');
  }
  assertActiveType_(data.problem_category);

  var qty = null;
  if (data.quantity !== undefined && data.quantity !== '' && data.quantity !== null) {
    qty = Number(data.quantity);
    if (isNaN(qty) || qty <= 0) throw new Error('Quantity harus angka lebih besar dari 0 (bila diisi).');
  }
  var arrival = normalizeDateVal_(data.arrival_date);

  // Foto di-upload DULU: kalau Drive gagal, tidak ada baris setengah jadi.
  var photoUrl = '';
  if (data.photo_b64) {
    var tz = Session.getScriptTimeZone();
    var stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd-HHmmss');
    photoUrl = savePhoto_(data.photo_b64, stamp + '_' + String(data.material_code) + '.jpg');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getReportsSheet_();
    var now = new Date();
    var id = generateProblemId(now);

    var fields = {};
    fields['Problem_ID'] = id;
    fields['Timestamp'] = now;
    fields['Status'] = STATUS.BARU;
    fields['Material_Code'] = material.code;
    fields['Material_Name'] = material.name;
    fields['Specification'] = material.spec;
    fields['Supplier'] = data.supplier || '';
    fields['Batch_Number'] = data.batch_number || data.batch || '';  // data.batch = kompatibel versi awal klien
    fields['Arrival_Date'] = arrival || '';
    fields['Location'] = data.lokasi || data.location || '';  // frontend kirim lokasi; location = kompatibel versi awal klien
    fields['Problem_Category'] = String(data.problem_category).trim();
    fields['Quantity'] = qty === null ? '' : qty;
    fields['Unit'] = data.unit || '';
    fields['Description'] = data.description || '';
    fields['Photo_URL'] = photoUrl;
    fields['Reported_By'] = byUser.nama;

    sheet.appendRow(buildRow_(sheet, fields));
    logAudit_(byUser, 'LAPOR_BARU', id, material.name + ' | ' + data.problem_category + (qty !== null ? ' | ' + qty + ' ' + (data.unit || '') : ''));
    try {
      appendActionRow_(id, 'DITERIMA', 'Laporan dibuat oleh ' + (byUser.nama || byUser.username), '', byUser);
    } catch (eTahap) { /* timeline best-effort */ }
    return { problem_id: id, status: STATUS.BARU };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Update satu baris laporan dengan pemeriksaan status sumber + locking.
 * @param {string} id
 * @param {string[]} allowedFrom - daftar status yang boleh
 * @param {function} mutateFn - function(obj) memodifikasi in-place
 */
function updateProblem_(id, allowedFrom, mutateFn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getReportsSheet_();
    var rowIndex = findRowIndexById_(sheet, id);
    if (rowIndex === -1) {
      throw new Error('Problem_ID tidak ditemukan: ' + id);
    }
    var lastCol = sheet.getLastColumn();
    var rowRange = sheet.getRange(rowIndex, 1, 1, lastCol);
    var rowArray = rowRange.getValues()[0];
    var map = getHeaderMap_(sheet);
    var obj = rowToObj_(map, rowArray);

    var st = String(obj['Status'] || '');
    if (allowedFrom.indexOf(st) === -1) {
      throw new Error('TRANSISI: Laporan berstatus "' + st + '" tidak bisa diubah (harus: ' + allowedFrom.join(' / ') + ').');
    }

    mutateFn(obj);

    writeObjBack_(sheet, rowRange, map, obj);
    return { problem_id: obj['Problem_ID'], status: obj['Status'] };
  } finally {
    lock.releaseLock();
  }
}

function startProcess_(data, byUser) {
  requireFields_(data, ['problem_id']);
  var out = null;
  updateProblem_(data.problem_id, [STATUS.BARU], function (obj) {
    var now = new Date();
    obj['Status'] = STATUS.DIPROSES;
    obj['Processed_At'] = now;
    obj['Action_PIC'] = byUser.nama;
    obj._meta_audit = { by: byUser, aksi: 'MULAI_PROSES' };
    out = { problem_id: obj['Problem_ID'], status: obj['Status'], action_pic: byUser.nama };
  });
  return out;
}

function closeProblem_(data, byUser) {
  requireFields_(data, ['problem_id', 'action_taken']);
  var out = null;
  updateProblem_(data.problem_id, [STATUS.BARU, STATUS.DIPROSES], function (obj) {
    var now = new Date();
    obj['Status'] = STATUS.SELESAI;
    obj['Action_Taken'] = String(data.action_taken).trim();
    if (!obj['Action_PIC']) obj['Action_PIC'] = byUser.nama;
    if (!obj['Processed_At']) obj['Processed_At'] = now;
    obj['Closed_At'] = now;
    if (data.closing_note) obj['Closing_Note'] = String(data.closing_note).trim();
    obj._meta_audit = { by: byUser, aksi: 'TUTUP', detail: obj['Action_Taken'] + ' | ' + (obj['Material_Code'] || '') };
    out = { problem_id: obj['Problem_ID'], status: obj['Status'] };
  });
  try {
    appendSelesaiRowIfMissing_(data.problem_id, byUser, null);
  } catch (e) { /* timeline best-effort */ }
  return out;
}

function voidProblem_(data, byUser) {
  requireFields_(data, ['problem_id', 'alasan']);
  var out = null;
  updateProblem_(data.problem_id, [STATUS.BARU, STATUS.DIPROSES], function (obj) {
    var now = new Date();
    obj['Status'] = STATUS.VOID;
    obj['Closed_At'] = now;
    obj['Closing_Note'] = 'VOID oleh ' + byUser.nama + ': ' + String(data.alasan).trim();
    obj._meta_audit = { by: byUser, aksi: 'VOID', detail: String(data.alasan).trim() };
    out = { problem_id: obj['Problem_ID'], status: obj['Status'] };
  });
  return out;
}

/**
 * Koreksi oleh ADMIN, hanya selama masih Baru.
 * Field opsional: material_code, supplier, batch_number, arrival_date, lokasi,
 * problem_category, quantity, unit, description.
 */
function editProblem_(data, byUser) {
  requireFields_(data, ['problem_id']);
  var out = null;
  updateProblem_(data.problem_id, [STATUS.BARU], function (obj) {
    var changes = [];

    if (data.material_code && data.material_code !== obj['Material_Code']) {
      var m = findMaterial_(data.material_code);
      if (!m) throw new Error('MATERIAL: Kode "' + data.material_code + '" tidak ditemukan / tidak aktif.');
      obj['Material_Code'] = m.code;
      obj['Material_Name'] = m.name;
      obj['Specification'] = m.spec;
      changes.push('Material -> ' + m.code);
    }
    if (data.supplier !== undefined && data.supplier !== '' && data.supplier !== obj['Supplier']) {
      obj['Supplier'] = data.supplier;
      changes.push('Supplier: ' + obj['Supplier'] + ' -> ' + data.supplier);
    }
    if (data.batch_number !== undefined && data.batch_number !== '' && data.batch_number !== obj['Batch_Number']) {
      changes.push('Batch: ' + obj['Batch_Number'] + ' -> ' + data.batch_number);
      obj['Batch_Number'] = data.batch_number;
    }
    if (data.arrival_date !== undefined && data.arrival_date !== '') {
      var d = normalizeDateVal_(data.arrival_date);
      if (d && String(obj['Arrival_Date']) !== String(d)) {
        obj['Arrival_Date'] = d;
        changes.push('Tgl kedatangan -> ' + Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'));
      }
    }
    if (data.lokasi !== undefined && data.lokasi !== '' && data.lokasi !== obj['Location']) {
      changes.push('Lokasi: ' + obj['Location'] + ' -> ' + data.lokasi);
      obj['Location'] = data.lokasi;
    }
    if (data.problem_category !== undefined && data.problem_category !== '' && data.problem_category !== obj['Problem_Category']) {
      assertActiveType_(data.problem_category);
      changes.push('Kategori: ' + obj['Problem_Category'] + ' -> ' + data.problem_category);
      obj['Problem_Category'] = String(data.problem_category).trim();
    }
    if (data.quantity !== undefined && data.quantity !== null && data.quantity !== '') {
      var q = Number(data.quantity);
      if (isNaN(q) || q <= 0) throw new Error('Quantity harus angka lebih besar dari 0.');
      if (q !== Number(obj['Quantity'])) {
        changes.push('Qty: ' + obj['Quantity'] + ' -> ' + q);
        obj['Quantity'] = q;
      }
    }
    if (data.unit !== undefined && data.unit !== '' && data.unit !== obj['Unit']) {
      changes.push('Unit -> ' + data.unit);
      obj['Unit'] = data.unit;
    }
    if (data.description) {
      obj['Description'] = String(data.description).trim();
      changes.push('Deskripsi diperbarui');
    }
    if (changes.length === 0) throw new Error('Nilai baru sama dengan nilai lama.');
    obj._meta_audit = { by: byUser, aksi: 'EDIT', detail: changes.join('; ') };
    out = { problem_id: obj['Problem_ID'], changed: changes };
  });
  return out;
}

// ===================== MASTER: SUPPLIER & TIPE (ADMIN) =====================

function addSupplier_(data, byUser) {
  requireFields_(data, ['supplier']);
  var name = String(data.supplier).trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.SUPPLIERS);
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var existing = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]).toLowerCase(); });
      if (existing.indexOf(name.toLowerCase()) !== -1) {
        throw new Error('Supplier "' + name + '" sudah ada.');
      }
    }
    sheet.appendRow([name, 'active']);
    logAudit_(byUser, 'SUPPLIER_TAMBAH', '', name);
    return { supplier: name, aktif: true };
  } finally {
    lock.releaseLock();
  }
}

function toggleRowAktif_(sheetName, colName, sheet, data, byUser, aksi, keyName) {
  requireFields_(data, [keyName]);
  if (data.aktif === undefined) throw new Error('Field wajib belum diisi: aktif');
  var key = String(data[keyName]).trim();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('Belum ada data di sheet ' + sheetName + '.');
  var map = getHeaderMap_(sheet);
  var kCol = map[colName], sCol = map['Status'];
  var jadiAktif = (data.aktif === true || data.aktif === 'true');
  var lastCol = sheet.getLastColumn();
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][kCol - 1]).toLowerCase().trim() === key.toLowerCase()) {
      sheet.getRange(i + 2, sCol).setValue(jadiAktif ? 'active' : 'inactive');
      logAudit_(byUser, aksi, '', key + ' -> ' + (jadiAktif ? 'aktif' : 'nonaktif'));
      return { key: key, aktif: jadiAktif };
    }
  }
  throw new Error('"' + key + '" tidak ditemukan di ' + sheetName + '.');
}

function setSupplierAktif_(data, byUser) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.SUPPLIERS);
  return toggleRowAktif_('Master Supplier', 'Supplier', sheet, data, byUser, 'SUPPLIER_TOGGLE', 'supplier');
}

function addProblemType_(data, byUser) {
  requireFields_(data, ['type_name']);
  var name = String(data.type_name).trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.TYPES);
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var existing = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]).toLowerCase(); });
      if (existing.indexOf(name.toLowerCase()) !== -1) {
        throw new Error('Tipe "' + name + '" sudah ada.');
      }
    }
    sheet.appendRow([name, 'active']);
    logAudit_(byUser, 'TIPE_TAMBAH', '', name);
    return { type_name: name, aktif: true };
  } finally {
    lock.releaseLock();
  }
}

function setProblemTypeAktif_(data, byUser) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.TYPES);
  return toggleRowAktif_('Master Problem Type', 'Type_Name', sheet, data, byUser, 'TIPE_TOGGLE', 'type_name');
}

// ===================== READ: LIST LAPORAN =====================

function toIsoSafe_(v) {
  if (!v) return '';
  var d = (v instanceof Date) ? v : new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

function toMsSafe_(v) {
  if (!v) return 0;
  var d = (v instanceof Date) ? v : new Date(v);
  var t = d.getTime();
  return isNaN(t) ? 0 : t;
}

function mapReportRow_(headerMap, r) {
  var o = rowToObj_(headerMap, r);
  return {
    problem_id: o['Problem_ID'],
    timestamp: toIsoSafe_(o['Timestamp']),
    status: o['Status'],
    material_code: o['Material_Code'],
    material_name: o['Material_Name'],
    specification: o['Specification'],
    supplier: o['Supplier'],
    batch_number: o['Batch_Number'],
    arrival_date: toIsoSafe_(o['Arrival_Date']),
    lokasi: o['Location'],
    problem_category: o['Problem_Category'],
    quantity: (o['Quantity'] === '' || o['Quantity'] === undefined) ? null : Number(o['Quantity']),
    unit: o['Unit'],
    description: o['Description'],
    photo_url: o['Photo_URL'],
    photo_url_extra: o['Photo_URL_Extra'],
    reported_by: o['Reported_By'],
    action_taken: o['Action_Taken'],
    action_pic: o['Action_PIC'],
    processed_at: toIsoSafe_(o['Processed_At']),
    closed_at: toIsoSafe_(o['Closed_At']),
    closing_note: o['Closing_Note']
  };
}

/** List laporan. Filter opsional: date_from/date_to (yyyy-MM-dd vs Timestamp),
 *  status (exact), category (exact), material (substring code/name), q (pencarian umum). */
function listProblems_(dateFrom, dateTo, status, category, material, q) {
  var sheet = getReportsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var lastCol = sheet.getLastColumn();
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var headerMap = getHeaderMap_(sheet);
  var tz = Session.getScriptTimeZone();

  var rows = values.map(function (r) {
    return mapReportRow_(headerMap, r);
  }).filter(function (r) { return !!r.problem_id; });

  if (dateFrom) {
    var from = toMsSafe_(normalizeDateVal_(dateFrom));
    rows = rows.filter(function (r) { return (toMsSafe_(r.timestamp) || 0) >= from; });
  }
  if (dateTo) {
    var toD = normalizeDateVal_(dateTo);
    if (toD) {
      var until = toD.getTime() + 86399000; // akhir hari
      rows = rows.filter(function (r) { return (toMsSafe_(r.timestamp) || 0) <= until; });
    }
  }
  if (status) {
    rows = rows.filter(function (r) { return r.status === status; });
  }
  if (category) {
    rows = rows.filter(function (r) { return r.problem_category === category; });
  }
  if (material) {
    var needle = String(material).toLowerCase();
    rows = rows.filter(function (r) {
      return String(r.material_code || '').toLowerCase().indexOf(needle) !== -1 ||
             String(r.material_name || '').toLowerCase().indexOf(needle) !== -1;
    });
  }
  if (q) {
    var s = String(q).toLowerCase();
    rows = rows.filter(function (r) {
      return [r.problem_id, r.material_code, r.material_name, r.supplier, r.batch_number, r.description, r.reported_by]
        .some(function (f) { return String(f || '').toLowerCase().indexOf(s) !== -1; });
    });
  }
  return rows;
}

/** Payload referensi untuk front-end (dropdown + ringkasan terbuka). */
function bootstrapData_() {
  var materials = readActiveMaterials_();
  var types = readActiveTypes_();
  var suppliers = readActiveSuppliers_();

  var openCount = { Baru: 0, Diproses: 0 };
  var sheet = getReportsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var map = getHeaderMap_(sheet);
    var stIdx = map['Status'] - 1;
    var idIdx = map['Problem_ID'] - 1;
    var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      if (!r[idIdx]) continue;
      var st = r[stIdx];
      if (st === STATUS.BARU || st === STATUS.DIPROSES) openCount[st]++;
    }
  }

  return {
    materials: materials,
    problem_types: types,
    suppliers: suppliers,
    units: UNIT_SUGGESTIONS,
    open_count: openCount
  };
}

// ===================== HELPERS VALIDASI & RESPONSE =====================

function requireFields_(data, fields) {
  var missing = fields.filter(function (f) {
    return data[f] === undefined || data[f] === null || data[f] === '';
  });
  if (missing.length > 0) {
    throw new Error('Field wajib belum diisi: ' + missing.join(', '));
  }
}

function respondJson_(obj) {
  obj.server_time = new Date().toISOString();
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function respondError_(message) {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===================== DIAGNOSTIK =====================

/** Jalankan dari editor (dropdown → Run → View > Logs).
 *  Tujuan: memastikan tidak ada definisi global ganda / file .gs sisa paste.
 *  Harus menampilkan STATUS lengkap 4 status: Baru, Diproses, Selesai, Void. */
function cekKonstanta() {
  Logger.log('STATUS = ' + JSON.stringify(STATUS));
  Logger.log('ROLES  = ' + JSON.stringify(ROLES));
  Logger.log('SHEET_NAMES = ' + JSON.stringify(SHEET_NAMES));
  var daftar = [];
  [STATUS.BARU, STATUS.DIPROSES, STATUS.SELESAI, STATUS.VOID].forEach(function (s) {
    daftar.push(s === undefined ? 'UNDEFINED!' : s);
  });
  Logger.log('urutan: ' + daftar.join(' | '));
  Logger.log('UrlFetchApp tersedia? ' + (typeof UrlFetchApp !== 'undefined'));
}

/** Lihat isi konfigurasi master. Jalankan manual, cek View > Logs. */
function debugMaster_() {
  Logger.log('Materials: ' + JSON.stringify(readActiveMaterials_()));
  Logger.log('Types: ' + JSON.stringify(readActiveTypes_()));
  Logger.log('Suppliers: ' + JSON.stringify(readActiveSuppliers_()));
  var props = PropertiesService.getScriptProperties();
  Logger.log('PhotoFolder: ' + props.getProperty(DRIVE_FOLDER_PROP));
}
