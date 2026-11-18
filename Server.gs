/**
 * ID CARD STUDIO — server code.
 *
 * Project files:
 *   Server.gs            — this file (all server logic)
 *   StudioTabs.html      — tab host page served by doGet
 *   StudioTabBridge.html — injected into every studio iframe
 *   CardStudio.html      — Card Studio: every card list, shown as tabs
 *   StudioClient.html    — shared card-studio helpers (photos, mapping, camera, forms)
 *   DesignRuntime.html   — renders and prints card designs
 *   Design.html          — Design Studio
 *   ControlCenter.html   — administrator page
 *
 * Every client-callable (public) function checks access exactly once at entry.
 * Private helpers (trailing underscore) cannot be called from the browser and
 * therefore do not repeat the check.
 */

// ============================================================================
// Constants
// ============================================================================

const ACCESS_ADMIN_PROPERTY_ = 'ID_STUDIO_ADMIN_EMAIL';
const ACCESS_USER_PREFIX_ = 'ID_STUDIO_ALLOWED_';
const ACCESS_USER_LIMIT_ = 1000;
const EMAIL_PATTERN_ = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

const USAGE_PREFIX_ = 'ID_STUDIO_USAGE_V1_';
const USAGE_MAX_KEYS_ = 12; // per user; more lists are counted together as “Other lists”
const USAGE_ACCOUNT_LIMIT_ = 1000;
/**
 * Script Properties hold at most 500 KB in total, shared by the approved-user list
 * and the activity counters. Counters may only grow while the total stays below
 * USAGE_STORAGE_LIMIT_, so there is always room left to add, enable or remove users.
 */
const PROPERTIES_LIMIT_BYTES_ = 500 * 1024;
const USAGE_STORAGE_LIMIT_ = 400 * 1024;

// Card lists (personal: stored in each user's User Properties)
const LISTS_PROPERTY_ = 'CARD_LISTS_V1';
const ACTIVE_LIST_PROPERTY_ = 'CARD_LIST_ACTIVE';
const LIST_LIMIT_ = 20;
const LIST_COLORS_ = {
  blue: ['#185adb', '#1248b5', '#e9eef5'], purple: ['#7141c6', '#58309f', '#ece8f4'],
  teal: ['#0f8b8d', '#0b7173', '#e5f0f0'], orange: ['#d97706', '#b45309', '#fbf1e2'],
  green: ['#1f883d', '#166534', '#e7f3ea'], red: ['#b42318', '#912018', '#fbeceb'],
  slate: ['#475467', '#344054', '#eceff3']
};
/**
 * Users create their own lists; nobody gets ready-made lists. The former Student,
 * Staff and Custom studios survive as lists only where a spreadsheet was connected
 * (their ids keep the settings saved by earlier versions).
 */
const LEGACY_LISTS_ = [
  {id: 'student', name: 'Students', color: 'blue', photoMatch: 'id', noun: 'Student', plural: 'Students', sheetKey: 'ACTIVE_SPREADSHEET_ID'},
  {id: 'staff', name: 'Staff', color: 'purple', photoMatch: 'name', noun: 'Staff Member', plural: 'Staff', sheetKey: 'ACTIVE_STAFF_SPREADSHEET_ID'},
  {id: 'custom', name: 'Custom', color: 'teal', photoMatch: 'name', noun: 'Record', plural: 'Records', sheetKey: 'ACTIVE_CUSTOM_SPREADSHEET_ID'}
];
const LOCK_TIMEOUT_MS_ = 30000;
const UUID_NOTE_ = 'ID Card Studio internal record identity.';
const PHOTO_NOTE_ = 'ID Card Studio photo file ID.';
const UUID_HEADING_ = '_ID_CARD_RECORD_UUID';
const PHOTO_HEADING_ = '_ID_CARD_PHOTO_FILE_ID';

// ============================================================================
// Small shared helpers
// ============================================================================

function withLock_(lock, operation) {
  lock.waitLock(LOCK_TIMEOUT_MS_);
  try {
    return operation();
  } finally {
    lock.releaseLock();
  }
}

function withUserLock_(operation) {
  return withLock_(LockService.getUserLock(), operation);
}

/**
 * Spreadsheet and photo writes use the script lock, which is shared by all
 * users, so two people editing the same roster cannot overwrite each other.
 * Writes are short, so waiting is rare.
 */
function withSheetLock_(operation) {
  return withLock_(LockService.getScriptLock(), operation);
}

function parseJson_(text, fallback) {
  return text ? JSON.parse(text) : fallback;
}

function countWithPrefix_(all, prefix) {
  return Object.keys(all).filter(key => key.indexOf(prefix) === 0).length;
}

/** Zero-based column index → spreadsheet letters (0 → A, 26 → AA). */
function spreadsheetColumnLetter_(index) {
  let value = Number(index) + 1;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + value % 26) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function columnLabel_(index) {
  return 'Column ' + spreadsheetColumnLetter_(index);
}

function normalizeStudentId_(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/** Prevent user-entered text from being interpreted as a formula. */
function literalCell_(value) {
  const text = String(value == null ? '' : value);
  return text.startsWith('=') ? "'" + text : text;
}

function extractSheetId_(urlOrId) {
  if (!urlOrId) return null;
  const match = String(urlOrId).match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : String(urlOrId).trim();
}

function extractFolderId_(urlOrId) {
  if (!urlOrId) return null;
  const match = String(urlOrId).match(/folders\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : String(urlOrId).trim();
}

function driveFileBaseName_(file) {
  return file.getName().replace(/\.[^.]+$/, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ============================================================================
// Access control (registry lives in Script Properties)
// ============================================================================

function accessEmail_(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN_.test(email)) {
    throw new Error('Enter a valid Google account email address.');
  }
  return email;
}

function accessIdentity_() {
  const active = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  const effective = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!active || active !== effective) {
    throw new Error('Sign in with your Google account. This app must execute as the user accessing it.');
  }
  return accessEmail_(active);
}

function accessAdmin_(properties) {
  const value = (properties || PropertiesService.getScriptProperties()).getProperty(ACCESS_ADMIN_PROPERTY_);
  if (!value) {
    throw new Error('Access control is not configured. The project owner must set ID_STUDIO_ADMIN_EMAIL in Script Properties.');
  }
  return accessEmail_(value);
}

function accessKey_(email) {
  return ACCESS_USER_PREFIX_ + encodeURIComponent(email);
}

function assertAppAccess_() {
  const email = accessIdentity_();
  const properties = PropertiesService.getScriptProperties();
  const isAdmin = email === accessAdmin_(properties);
  if (!isAdmin && properties.getProperty(accessKey_(email)) !== 'enabled') {
    throw new Error('Access denied. Contact the application administrator to request access for your Google account.');
  }
  return {email: email, isAdmin: isAdmin};
}

function assertAdminAccess_() {
  const email = accessIdentity_();
  if (email !== accessAdmin_()) throw new Error('Administrator access is required.');
  return email;
}

/** Re-authorize inside the lock so a transferred administrator cannot run queued writes. */
function accessAdminWrite_(operation) {
  return withLock_(LockService.getScriptLock(), () => {
    const administrator = assertAdminAccess_();
    return operation(PropertiesService.getScriptProperties(), administrator);
  });
}

/** @param {Object} all Script Properties map. */
function accessUsers_(all, administrator) {
  return Object.keys(all)
    .filter(key => key.indexOf(ACCESS_USER_PREFIX_) === 0)
    .map(key => {
      try {
        return {email: accessEmail_(decodeURIComponent(key.slice(ACCESS_USER_PREFIX_.length))), enabled: all[key] === 'enabled'};
      } catch (error) {
        return null;
      }
    })
    .filter(user => user && user.email !== administrator)
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Adds missing accounts. Never re-enables an existing disabled account. */
function adminImportUsers(emails) {
  assertAdminAccess_();
  if (!Array.isArray(emails) || !emails.length || emails.length > 500) {
    throw new Error('Provide between 1 and 500 email addresses per import.');
  }
  const unique = Array.from(new Set(emails.map(accessEmail_)));
  return accessAdminWrite_((properties, administrator) => {
    const all = properties.getProperties();
    const additions = unique.filter(email => email !== administrator && !Object.prototype.hasOwnProperty.call(all, accessKey_(email)));
    if (countWithPrefix_(all, ACCESS_USER_PREFIX_) + additions.length > ACCESS_USER_LIMIT_) {
      throw new Error('The approved-user limit is 1,000. Remove unused accounts before adding more.');
    }
    if (additions.length) {
      const changes = {};
      additions.forEach(email => { changes[accessKey_(email)] = 'enabled'; });
      properties.setProperties(changes, false);
    }
    return {added: additions.length, unchanged: unique.length - additions.length};
  });
}

/**
 * One write for many accounts. action: enable | disable | remove | clearUsage.
 * The administrator's access is never changed, but their own activity can be cleared.
 * Enabling a removed account restores it.
 */
function adminBulkAccess(emails, action) {
  assertAdminAccess_();
  if (['enable', 'disable', 'remove', 'clearUsage'].indexOf(action) < 0) throw new Error('Unknown action.');
  if (!Array.isArray(emails) || !emails.length || emails.length > 1000) throw new Error('Select between 1 and 1,000 accounts.');
  const targets = Array.from(new Set(emails.map(accessEmail_)));
  return accessAdminWrite_((properties, administrator) => {
    const all = properties.getProperties();
    const list = action === 'clearUsage' ? targets : targets.filter(email => email !== administrator);
    const changes = {};
    let changed = 0;
    if (action === 'enable') {
      const additions = list.filter(email => !Object.prototype.hasOwnProperty.call(all, accessKey_(email)));
      if (countWithPrefix_(all, ACCESS_USER_PREFIX_) + additions.length > ACCESS_USER_LIMIT_) {
        throw new Error('The approved-user limit is 1,000. Remove unused accounts first.');
      }
      list.forEach(email => {
        if (all[accessKey_(email)] !== 'enabled') { changes[accessKey_(email)] = 'enabled'; changed++; }
      });
    } else if (action === 'disable') {
      list.forEach(email => {
        if (all[accessKey_(email)] === 'enabled') { changes[accessKey_(email)] = 'disabled'; changed++; }
      });
    } else {
      const prefix = action === 'remove' ? null : USAGE_PREFIX_;
      list.forEach(email => {
        const key = prefix ? prefix + encodeURIComponent(email) : accessKey_(email);
        if (Object.prototype.hasOwnProperty.call(all, key)) { properties.deleteProperty(key); changed++; }
      });
    }
    if (Object.keys(changes).length) properties.setProperties(changes, false);
    return {changed: changed, skipped: targets.length - changed};
  });
}

function adminTransferAccess(newEmail, confirmationEmail) {
  assertAdminAccess_();
  const target = accessEmail_(newEmail);
  if (target !== accessEmail_(confirmationEmail)) throw new Error('Both administrator email addresses must match.');
  return accessAdminWrite_((properties, administrator) => {
    if (target === administrator) throw new Error('That account is already the administrator.');
    const all = properties.getProperties();
    const formerAdminListed = Object.prototype.hasOwnProperty.call(all, accessKey_(administrator));
    if (!formerAdminListed && countWithPrefix_(all, ACCESS_USER_PREFIX_) >= ACCESS_USER_LIMIT_) {
      throw new Error('Remove an unused account before transferring administrator access.');
    }
    const changes = {};
    changes[ACCESS_ADMIN_PROPERTY_] = target;
    changes[accessKey_(administrator)] = 'enabled'; // former admin becomes a regular user
    properties.setProperties(changes, false);
    return {success: true};
  });
}

/** A denied request never renders page templates or account data. */
function accessDeniedPage_() {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access unavailable</title></head>' +
    '<body style="font:16px Arial,sans-serif;background:#eef2f7;color:#243247;padding:32px">' +
    '<main style="max-width:540px;margin:8vh auto;padding:28px;background:white;border:1px solid #cbd5e1;border-radius:12px">' +
    '<h1 style="font-size:24px">Access unavailable</h1>' +
    '<p>Sign in with an approved Google account. If you need access, contact the application administrator.</p>' +
    '<p>The project owner can also check the administrator setting and deployment configuration.</p>' +
    '</main></body></html>'
  ).setTitle('Access unavailable');
}

// ============================================================================
// Usage reports (aggregate counters only — never record data, IDs or photos)
// ============================================================================

function usageEmpty_() {
  return {first: null, last: null, by: {}};
}

/** Approximate stored size (bytes) of a set of properties. */
function propertiesSize_(all) {
  return Object.keys(all).reduce((total, key) => total + key.length + String(all[key]).length, 0);
}

/**
 * Compact form used for saving: {f: first, l: last, b: {key: [opens, photos, prints, name]}}
 * with times as seconds since 1970. About a third of the earlier size.
 */
function usageWrite_(row) {
  const seconds = iso => iso ? Math.floor(Date.parse(iso) / 1000) : 0;
  const b = {};
  Object.keys(row.by).forEach(key => {
    const bucket = row.by[key];
    b[key] = [bucket.open, bucket.photo, bucket.print, String(bucket.name || key).slice(0, 40)];
  });
  return JSON.stringify({f: seconds(row.first), l: seconds(row.last), b: b});
}

const USAGE_LEGACY_KEYS_ = [['student', 'Students'], ['staff', 'Staff'], ['custom', 'Custom'], ['design', 'Design Studio']];

/** Reads a usage row in any format saved by this or earlier versions. */
function usageRead_(raw) {
  const row = usageEmpty_();
  if (!raw) return row;
  const data = JSON.parse(raw);
  ['first', 'last'].forEach(key => {
    if (typeof data[key] === 'string' && Number.isFinite(Date.parse(data[key]))) row[key] = data[key];
  });
  [['f', 'first'], ['l', 'last']].forEach(([short, key]) => {
    if (Number.isSafeInteger(data[short]) && data[short] > 0) row[key] = new Date(data[short] * 1000).toISOString();
  });
  const add = (key, name, field, count) => {
    if (!/^[a-z0-9_-]{1,40}$/.test(key) || !Number.isSafeInteger(count) || count <= 0) return;
    const bucket = row.by[key] || (row.by[key] = {name: String(name || key).slice(0, 60), open: 0, photo: 0, print: 0});
    bucket[field] += count;
  };
  ['open', 'photo', 'print'].forEach(field => {
    if (Array.isArray(data[field])) data[field].forEach((count, i) => { if (USAGE_LEGACY_KEYS_[i]) add(USAGE_LEGACY_KEYS_[i][0], USAGE_LEGACY_KEYS_[i][1], field, count); });
  });
  if (data.by && typeof data.by === 'object') {
    Object.keys(data.by).forEach(key => {
      const bucket = data.by[key] || {};
      ['open', 'photo', 'print'].forEach(field => add(key, bucket.name, field, bucket[field]));
    });
  }
  if (data.b && typeof data.b === 'object') {
    Object.keys(data.b).forEach(key => {
      const item = Array.isArray(data.b[key]) ? data.b[key] : [];
      ['open', 'photo', 'print'].forEach((field, i) => add(key, item[3], field, item[i]));
    });
  }
  return row;
}

/**
 * Best effort: reporting must never break a card or photo operation.
 * key: a card list id or 'design'; name: its label in the report (no record data).
 */
function usageRecord_(event, key, name) {
  const valid = event === 'visit' ||
    (['open', 'photo', 'print'].indexOf(event) >= 0 && /^[a-z0-9_-]{1,40}$/.test(String(key || '')) && !(event !== 'open' && key === 'design'));
  if (!valid) return false;

  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    const access = assertAppAccess_();
    locked = lock.tryLock(1000);
    if (!locked) return false;
    assertAppAccess_(); // access may have changed while waiting
    const properties = PropertiesService.getScriptProperties();
    const all = properties.getProperties();
    const propertyKey = USAGE_PREFIX_ + encodeURIComponent(access.email);
    if (!all[propertyKey] && countWithPrefix_(all, USAGE_PREFIX_) >= USAGE_ACCOUNT_LIMIT_) return false;
    const row = usageRead_(all[propertyKey]);
    const now = new Date().toISOString();
    row.first = row.first || now;
    row.last = now;
    if (event !== 'visit') {
      let bucketKey = key;
      if (!row.by[bucketKey] && Object.keys(row.by).length >= USAGE_MAX_KEYS_) {
        bucketKey = 'other';
        name = 'Other lists';
      }
      const bucket = row.by[bucketKey] || (row.by[bucketKey] = {name: '', open: 0, photo: 0, print: 0});
      bucket.name = String(name || bucketKey).slice(0, 60);
      bucket[event] += 1;
    }
    const value = usageWrite_(row);
    // Checked before every write: counters never take the space the user list needs.
    const growth = propertyKey.length + value.length - (all[propertyKey] ? propertyKey.length + all[propertyKey].length : 0);
    if (growth > 0 && propertiesSize_(all) + growth > USAGE_STORAGE_LIMIT_) return false;
    properties.setProperty(propertyKey, value);
    return true;
  } catch (error) {
    return false; // never log payloads; they may contain upstream data
  } finally {
    if (locked) {
      try { lock.releaseLock(); } catch (error) { /* ignore */ }
    }
  }
}

function recordStudioPrintRequest(listId) {
  assertAppAccess_();
  const list = cardList_(listId);
  return {recorded: usageRecord_('print', list.id, list.name)};
}

function adminGetUsageReport() {
  const administrator = assertAdminAccess_();
  const all = PropertiesService.getScriptProperties().getProperties();
  const emails = new Set([administrator]);
  accessUsers_(all, administrator).forEach(user => emails.add(user.email));
  Object.keys(all).filter(key => key.startsWith(USAGE_PREFIX_)).forEach(key => {
    try { emails.add(accessEmail_(decodeURIComponent(key.slice(USAGE_PREFIX_.length)))); } catch (error) { /* skip malformed */ }
  });

  let unreadable = 0;
  const rows = Array.from(emails).map(email => {
    let usage;
    try {
      usage = usageRead_(all[USAGE_PREFIX_ + encodeURIComponent(email)]);
    } catch (error) {
      usage = usageEmpty_();
      unreadable += 1;
    }
    const status = all[accessKey_(email)];
    const access = email === administrator ? 'Administrator' : status === 'enabled' ? 'Enabled' : status === 'disabled' ? 'Disabled' : 'Removed';
    const lists = Object.keys(usage.by).map(key => Object.assign({key: key}, usage.by[key]))
      .sort((a, b) => (a.key === 'design') - (b.key === 'design') || a.name.localeCompare(b.name));
    const total = field => lists.reduce((sum, item) => sum + item[field], 0);
    return {
      email: email, access: access, first: usage.first, last: usage.last,
      totals: {openings: total('open'), photos: total('photo'), prints: total('print')},
      lists: lists
    };
  });
  rows.sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')) || a.email.localeCompare(b.email));
  const usageBytes = Object.keys(all).filter(key => key.startsWith(USAGE_PREFIX_)).reduce((n, key) => n + key.length + all[key].length, 0);
  const totalBytes = propertiesSize_(all);
  return {
    storage: {
      totalBytes: totalBytes, usageBytes: usageBytes, otherBytes: totalBytes - usageBytes,
      limitBytes: PROPERTIES_LIMIT_BYTES_, usageLimitBytes: USAGE_STORAGE_LIMIT_,
      usageFull: totalBytes >= USAGE_STORAGE_LIMIT_ - 2048
    },
    generatedAt: new Date().toISOString(),
    rows: rows,
    unreadable: unreadable,
    trackedAccounts: rows.filter(row => row.first).length,
    accountLimit: USAGE_ACCOUNT_LIMIT_
  };
}

// ============================================================================
// Per-user data-source configuration (User Properties)
// ============================================================================

/** Each signed-in user (campus) has its own spreadsheet/folder settings. */
function userProperties_() {
  return PropertiesService.getUserProperties();
}

/**
 * This user's card lists (may be empty: Card Studio then offers “New List”).
 * The first time, only former studios that had a spreadsheet connected become lists.
 */
function cardLists_() {
  const p = userProperties_();
  const legacy = id => LEGACY_LISTS_.find(item => item.id === id);
  const connected = item => Boolean(p.getProperty(item.sheetKey));
  try {
    const saved = JSON.parse(p.getProperty(LISTS_PROPERTY_) || 'null');
    if (Array.isArray(saved)) {
      // Ready-made lists from earlier versions that were never connected or renamed are removed.
      const cleaned = saved.filter(list => {
        const original = legacy(list.id);
        return !original || connected(original) || list.name !== original.name;
      });
      if (cleaned.length !== saved.length) p.setProperty(LISTS_PROPERTY_, JSON.stringify(cleaned));
      return cleaned;
    }
  } catch (error) { /* rebuild below */ }
  const lists = LEGACY_LISTS_.filter(connected).map(item => {
    const list = Object.assign({}, item);
    delete list.sheetKey;
    return list;
  });
  p.setProperty(LISTS_PROPERTY_, JSON.stringify(lists));
  return lists;
}

function cardList_(id) {
  const list = cardLists_().find(item => item.id === id);
  if (!list) throw new Error('This card list no longer exists. Choose another list.');
  return list;
}

/** Spreadsheet/folder property names. The original lists keep their original names. */
function studioKeys_(type) {
  const list = cardList_(type);
  const prefix = list.id === 'student' ? 'ACTIVE_'
    : list.id === 'staff' || list.id === 'custom' ? 'ACTIVE_' + list.id.toUpperCase() + '_'
    : 'LIST_' + list.id.toUpperCase() + '_';
  return {sheet: prefix + 'SPREADSHEET_ID', folder: prefix + 'PHOTO_FOLDER_ID'};
}

function cleanListSettings_(settings, current) {
  settings = settings || {};
  const name = String(settings.name === undefined ? current.name : settings.name).trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) throw new Error('Enter a list name of 1 to 40 characters.');
  const color = settings.color === undefined ? current.color : String(settings.color);
  if (!LIST_COLORS_[color]) throw new Error('Choose one of the list colors.');
  const photoMatch = settings.photoMatch === undefined ? current.photoMatch : String(settings.photoMatch);
  if (['id', 'name'].indexOf(photoMatch) < 0) throw new Error('Choose how photos are matched.');
  return {name: name, color: color, photoMatch: photoMatch};
}

function listSummaries_(lists) {
  const p = userProperties_();
  return lists.map(list => ({
    id: list.id, name: list.name, color: list.color, photoMatch: list.photoMatch,
    accent: (LIST_COLORS_[list.color] || LIST_COLORS_.blue)[0],
    configured: Boolean(p.getProperty(studioKeys_(list.id).sheet))
  }));
}

function createCardList(settings) {
  assertAppAccess_();
  return withUserLock_(() => {
    const lists = cardLists_();
    if (lists.length >= LIST_LIMIT_) throw new Error('You can have up to ' + LIST_LIMIT_ + ' lists. Remove one you no longer use first.');
    const clean = cleanListSettings_(settings, {name: '', color: 'blue', photoMatch: 'name'});
    if (lists.some(list => list.name.toLowerCase() === clean.name.toLowerCase())) throw new Error('You already have a list called “' + clean.name + '”.');
    const list = Object.assign({id: 'l' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toLowerCase(), noun: 'Person', plural: 'People'}, clean);
    lists.push(list);
    userProperties_().setProperty(LISTS_PROPERTY_, JSON.stringify(lists));
    return {id: list.id};
  });
}

function updateCardList(id, settings) {
  assertAppAccess_();
  return withUserLock_(() => {
    const lists = cardLists_();
    const list = lists.find(item => item.id === id);
    if (!list) throw new Error('This card list no longer exists.');
    const clean = cleanListSettings_(settings, list);
    if (lists.some(item => item.id !== id && item.name.toLowerCase() === clean.name.toLowerCase())) throw new Error('You already have a list called “' + clean.name + '”.');
    Object.assign(list, clean);
    userProperties_().setProperty(LISTS_PROPERTY_, JSON.stringify(lists));
    return {id: id};
  });
}

/** Removes a list and its connections. The spreadsheet, photos and designs are not touched. */
function deleteCardList(id) {
  assertAppAccess_();
  return withUserLock_(() => {
    const p = userProperties_();
    const lists = cardLists_();
    if (!lists.some(item => item.id === id)) throw new Error('This card list no longer exists.');
    const keys = studioKeys_(id);
    const sheetId = p.getProperty(keys.sheet);
    if (sheetId) p.deleteProperty(worksheetKey_(id, sheetId));
    p.deleteProperty(keys.sheet);
    p.deleteProperty(keys.folder);
    const remaining = lists.filter(item => item.id !== id);
    p.setProperty(LISTS_PROPERTY_, JSON.stringify(remaining));
    if (p.getProperty(ACTIVE_LIST_PROPERTY_) === id) p.deleteProperty(ACTIVE_LIST_PROPERTY_);
    return {next: remaining.length ? remaining[0].id : ''};
  });
}

/**
 * Everything Card Studio needs to show one list, in a single request:
 * the tabs, colors, browser-storage scope, setup state, and the records.
 * activate = false is used to load a list in advance (it does not become “last used”).
 */
function cardListData_(listId, activate) {
  const p = userProperties_();
  const lists = cardLists_();
  const list = lists.find(item => item.id === listId) ||
    (activate ? lists.find(item => item.id === p.getProperty(ACTIVE_LIST_PROPERTY_)) || lists[0] : null) || null;
  const data = {
    list: '', lists: listSummaries_(lists), records: null, headers: [], error: '',
    scope: 'idstudio_v2_nolist_', configuration: {hasSpreadsheet: false, hasPhotoFolder: false},
    page: Object.assign(cardPage_({name: 'No list yet', color: 'blue', photoMatch: 'name'}), {subtitle: 'Create a list to get started.'})
  };
  if (!list) return data;
  if (activate) p.setProperty(ACTIVE_LIST_PROPERTY_, list.id);
  data.list = list.id;
  data.page = cardPage_(list);
  data.scope = clientStorageScope_(list.id);
  data.configuration = studioConfiguration_(list.id);
  if (data.configuration.hasSpreadsheet) {
    try {
      const payload = studioRecordsPayload_(list.id);
      data.records = payload.records;
      data.headers = payload.headers;
    } catch (error) {
      data.error = error.message || String(error);
    }
  }
  return data;
}

function getCardListData(listId, activate) {
  assertAppAccess_();
  return cardListData_(String(listId || ''), activate !== false);
}

/**
 * Sent after a list is shown (separately, so switching never waits for it):
 * remembers it as the user's last list and counts the open for the usage report.
 */
function recordListOpen(listId) {
  assertAppAccess_();
  const list = cardList_(listId);
  userProperties_().setProperty(ACTIVE_LIST_PROPERTY_, list.id);
  return {recorded: usageRecord_('open', list.id, list.name)};
}

/** JSON that is safe inside a <script> block of a template. */
function jsonForScript_(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Text and colors for the Cards page of one list. */
function cardPage_(list) {
  const color = LIST_COLORS_[list.color] || LIST_COLORS_.blue;
  return {
    title: list.name,
    subtitle: 'Find people, manage records and photos, and print cards with your selected design.',
    noun: list.noun || 'Person', plural: list.plural || 'People',
    accent: color[0], accentDark: color[1], tint: color[2],
    color: list.color, photoMatch: list.photoMatch,
    photoHint: list.photoMatch === 'id'
      ? 'Unlinked photos are matched by ID number, for example 12345.jpg.'
      : 'Unlinked photos are matched by full name, for example Alex Smith.jpg.'
  };
}

function worksheetKey_(type, spreadsheetId) {
  return 'worksheet_' + type + '_' + spreadsheetId;
}

function schemaKey_(spreadsheetId, sheetId) {
  return 'schema_v2_' + spreadsheetId + '_' + sheetId;
}

/** Browser-storage namespace id for this Google account (created once). */
function browserScopeAccount_(p) {
  let account = p.getProperty('BROWSER_SCOPE_ID');
  if (account) return account;
  return withUserLock_(() => {
    account = p.getProperty('BROWSER_SCOPE_ID');
    if (!account) {
      account = Utilities.getUuid();
      p.setProperty('BROWSER_SCOPE_ID', account);
    }
    return account;
  });
}

/**
 * localStorage key prefix. Changing source, worksheet, folder or column layout
 * changes the prefix, so stale browser mappings are never reused.
 * The format is unchanged from earlier versions so saved browser data survives.
 */
function scopeString_(account, source) {
  return 'idstudio_v2_' + account + '_' + Utilities.base64EncodeWebSafe(source) + '_';
}

function clientStorageScope_(type) {
  const p = userProperties_();
  const account = browserScopeAccount_(p);
  const keys = studioKeys_(type);
  const id = p.getProperty(keys.sheet) || 'unconnected';
  const selectionText = p.getProperty(worksheetKey_(type, id));
  let source = type + '_' + id + '_' + (selectionText || 'default') + '_' + (p.getProperty(keys.folder) || '');
  if (id !== 'unconnected') {
    const selection = parseJson_(selectionText, {});
    const schema = selection.sheetId === undefined ? null : parseJson_(p.getProperty(schemaKey_(id, selection.sheetId)), null);
    if (schema && schema.layoutRevision) source += '_' + schema.layoutRevision;
  }
  return scopeString_(account, source);
}

function clientStorageScopeForContext_(c) {
  const account = browserScopeAccount_(c.p);
  const selection = JSON.stringify({sheetId: c.sheet.getSheetId(), header: c.header});
  let source = c.type + '_' + c.id + '_' + selection + '_' + (c.p.getProperty(c.keys.folder) || '');
  if (c.schema && c.schema.layoutRevision) source += '_' + c.schema.layoutRevision;
  return scopeString_(account, source);
}

function buildContext_(type, p, keys, id, book, sheet, header) {
  const key = schemaKey_(id, sheet.getSheetId());
  return {
    type: type, p: p, keys: keys, id: id, book: book, sheet: sheet,
    schemaKey: key,
    schema: parseJson_(p.getProperty(key), null),
    header: header,
    start: header ? 2 : 1
  };
}

/** Context for the committed (saved) data source. */
function studioContext_(type) {
  const p = userProperties_();
  const keys = studioKeys_(type);
  const id = p.getProperty(keys.sheet);
  if (!id) throw new Error('Connect a spreadsheet in Data Sources first.');
  const book = SpreadsheetApp.openById(id);
  const selection = parseJson_(p.getProperty(worksheetKey_(type, id)), {});
  const sheet = selection.sheetId === undefined
    ? book.getSheets()[0]
    : book.getSheets().find(s => s.getSheetId() === Number(selection.sheetId));
  if (!sheet) throw new Error('The selected worksheet was removed. Choose a worksheet again.');
  return buildContext_(type, p, keys, id, book, sheet, !!selection.header);
}

/** Context for previewing a source in Design Mapping without committing it. */
function designMappingContext_(type, spreadsheetUrl, sheetId, header) {
  const p = userProperties_();
  const keys = studioKeys_(type);
  const id = spreadsheetUrl ? extractSheetId_(spreadsheetUrl) : p.getProperty(keys.sheet);
  if (!id) throw new Error('Enter a spreadsheet URL in Data Sources first.');
  const book = SpreadsheetApp.openById(id);
  const selection = parseJson_(p.getProperty(worksheetKey_(type, id)), {});
  const explicitSheet = sheetId !== undefined && sheetId !== null && sheetId !== '';
  const selectedId = explicitSheet ? Number(sheetId) : selection.sheetId;
  const sheet = book.getSheets().find(s => s.getSheetId() === Number(selectedId)) || (explicitSheet ? null : book.getSheets()[0]);
  if (!sheet) throw new Error('Worksheet not found. Select an available worksheet in Design Mapping.');
  return buildContext_(type, p, keys, id, book, sheet, typeof header === 'boolean' ? header : !!selection.header);
}

function studioConfiguration_(type) {
  const p = userProperties_();
  const keys = studioKeys_(type);
  return {hasSpreadsheet: Boolean(p.getProperty(keys.sheet)), hasPhotoFolder: Boolean(p.getProperty(keys.folder))};
}


function getConfiguredResourceUrl(cardType, resourceType) {
  assertAppAccess_();
  const type = String(cardType || '');
  const resource = String(resourceType || '').toLowerCase();
  if (['spreadsheet', 'folder'].indexOf(resource) < 0) {
    throw new Error('Unsupported card type or resource type.');
  }
  const keys = studioKeys_(type);
  const savedId = userProperties_().getProperty(resource === 'spreadsheet' ? keys.sheet : keys.folder);
  if (!savedId) {
    throw new Error(resource === 'spreadsheet'
      ? 'No spreadsheet is connected. Open Data Sources and connect a spreadsheet URL or ID.'
      : 'No photo folder is connected. Open Data Sources and connect a Google Drive folder URL or ID.');
  }
  return resource === 'spreadsheet'
    ? 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(savedId) + '/edit#gid=' + studioContext_(type).sheet.getSheetId()
    : 'https://drive.google.com/drive/folders/' + encodeURIComponent(savedId);
}

function connectStudioPhotoFolder_(type, url) {
  const folderId = extractFolderId_(url);
  if (!folderId) throw new Error('Enter a photo folder URL or ID.');
  DriveApp.getFolderById(folderId).getName(); // verifies access
  const p = userProperties_();
  browserScopeAccount_(p); // initialise before taking the lock (locks are not re-entrant)
  const keys = studioKeys_(type);
  return withSheetLock_(() => {
    if (p.getProperty(keys.folder) !== folderId && p.getProperty(keys.sheet)) {
      // Links into the old folder are no longer valid.
      const c = studioContext_(type);
      if (c.schema && c.sheet.getLastRow() >= c.start) {
        c.sheet.getRange(c.start, c.schema.photoCol + 1, c.sheet.getLastRow() - c.start + 1, 1).clearContent();
      }
    }
    p.setProperty(keys.folder, folderId);
    // Name-based legacy photos are linked lazily by the next manifest/mapping/edit.
    return {success: true, scope: clientStorageScope_(type)};
  });
}

function setStudioPhotoFolder(type, url) {
  assertAppAccess_();
  return connectStudioPhotoFolder_(type, url);
}

// ============================================================================
// Column inspection and Design Mapping
// ============================================================================

/** Recognises only columns this app marked. Never guesses from user headings. */
function inspectStudioColumns_(c) {
  const width = Math.max(1, c.sheet.getLastColumn());
  const height = Math.max(1, c.sheet.getLastRow());
  const range = c.sheet.getRange(1, 1, height, width);
  const values = range.getDisplayValues();
  const formulas = range.getFormulas();
  const notes = c.sheet.getRange(1, 1, 1, width).getNotes()[0];
  const uuid = [];
  const photo = [];
  const data = [];
  for (let index = 0; index < width; index++) {
    const heading = values[0][index];
    const note = notes[index] || '';
    if (heading === UUID_HEADING_ || note.startsWith(UUID_NOTE_)) uuid.push(index);
    else if (heading === PHOTO_HEADING_ || note.startsWith(PHOTO_NOTE_)) photo.push(index);
    else data.push(index);
  }
  // Trailing empty columns (from older fixed-width layouts) are not data.
  const isEmptyColumn = col => !notes[col] && !values.some((row, i) => String(row[col] || '').trim() || formulas[i][col]);
  while (data.length && isEmptyColumn(data[data.length - 1])) data.pop();
  if (!data.length) data.push(0);

  const internal = uuid.concat(photo).sort((a, b) => a - b);
  const remap = {};
  data.forEach(index => { remap[index] = index - internal.filter(col => col < index).length; });
  return {
    values: values, uuid: uuid, photo: photo, internal: internal, data: data, remap: remap,
    dataWidth: Math.max(1, ...data.map(index => remap[index] + 1))
  };
}

function layoutToken_(c, layout) {
  return JSON.stringify({sheet: c.sheet.getSheetId(), columns: layout.data, internal: layout.internal, header: c.header});
}

function designMappingInfo_(c) {
  const layout = inspectStudioColumns_(c);
  const sampleRow = layout.values[c.start - 1] || [];
  return {
    spreadsheetId: c.id,
    sheetId: c.sheet.getSheetId(),
    header: c.header,
    scope: clientStorageScopeForContext_(c),
    worksheets: c.book.getSheets().map(sheet => ({id: sheet.getSheetId(), name: sheet.getName()})),
    columns: layout.data.map(index => ({
      index: index,
      label: columnLabel_(index) + (c.header && layout.values[0][index] ? ' — ' + layout.values[0][index] : ''),
      sample: String(sampleRow[index] || '')
    })),
    layoutToken: layoutToken_(c, layout),
    schemaReady: !!c.schema
  };
}

function getDesignMappingInfo(type, spreadsheetUrl, sheetId, header) {
  assertAppAccess_();
  return designMappingInfo_(designMappingContext_(type, spreadsheetUrl, sheetId, header));
}

/**
 * Moves app-owned UUID/photo columns to the end of the data columns, merges
 * duplicates, and keeps every user cell and existing photo link.
 */
function repairStudioColumns_(c, layout, regenerate) {
  const preferred = (columns, key) => {
    const current = c.schema && c.schema[key];
    return columns.includes(current) ? [current].concat(columns.filter(index => index !== current)) : columns;
  };
  const uuidColumns = preferred(layout.uuid, 'uuidCol');
  const photoColumns = preferred(layout.photo, 'photoCol');
  const seen = new Set();
  const metadata = layout.values.map((row, index) => {
    if (c.header && index === 0) return [UUID_HEADING_, PHOTO_HEADING_];
    if (!layout.data.some(col => String(row[col] || '').trim())) return ['', ''];
    const photos = Array.from(new Set(photoColumns.map(col => row[col]).filter(Boolean)));
    if (photos.length > 1) {
      throw new Error('Conflicting photo links in row ' + (index + 1) + '. Keep the correct link in the internal photo columns, then save Design Mapping again.');
    }
    let uuid = uuidColumns.map(col => row[col]).find(value => value && value !== UUID_HEADING_);
    if (regenerate || !uuid || seen.has(uuid)) uuid = Utilities.getUuid();
    seen.add(uuid);
    return [uuid, photos[0] === PHOTO_HEADING_ ? '' : photos[0] || ''];
  });

  const canonical = layout.uuid.length === 1 && layout.photo.length === 1 &&
    layout.uuid[0] === layout.dataWidth && layout.photo[0] === layout.dataWidth + 1;
  if (!canonical) {
    // Only app-marked columns are removed; reverse order keeps indexes valid.
    layout.internal.slice().reverse().forEach(index => c.sheet.deleteColumns(index + 1, 1));
  }
  const required = layout.dataWidth + 2;
  if (c.sheet.getMaxColumns() < required) c.sheet.insertColumnsAfter(c.sheet.getMaxColumns(), required - c.sheet.getMaxColumns());
  c.sheet.getRange(1, layout.dataWidth + 1, metadata.length, 2).setNumberFormat('@').setValues(metadata);
  c.sheet.getRange(1, layout.dataWidth + 1).setNote(UUID_NOTE_ + ' Keep this column with its row when sorting.');
  c.sheet.getRange(1, layout.dataWidth + 2).setNote(PHOTO_NOTE_ + ' Do not edit.');
  c.sheet.hideColumns(layout.dataWidth + 1, 2);

  const moved = layout.data.some(col => layout.remap[col] !== col);
  return {
    dataWidth: layout.dataWidth,
    uuidCol: layout.dataWidth,
    photoCol: layout.dataWidth + 1,
    layoutRevision: regenerate || moved ? Utilities.getUuid() : (c.schema && c.schema.layoutRevision) || ''
  };
}

const MAPPING_ROLES_ = {
  firstName: 'firstName', lastName: 'lastName', fullName: 'fullName', class: 'grade',
  idNumber: 'idNumber', title: 'title', barcodeNumber: 'barcodeNumber', transportation: 'transport',
  section: 'section', homeroom: 'homeroom'
};

function saveDesignMapping(type, settings) {
  assertAppAccess_();
  if (!settings || !Array.isArray(settings.fields)) throw new Error('Invalid design mapping.');
  browserScopeAccount_(userProperties_()); // before the lock (not re-entrant)
  return withSheetLock_(() => {
    const c = designMappingContext_(type, settings.spreadsheetUrl, settings.sheetId, settings.header);
    const layout = inspectStudioColumns_(c);
    if (settings.layoutToken && settings.layoutToken !== layoutToken_(c, layout)) {
      throw new Error('Worksheet columns changed. Reopen Design Mapping to review the current columns.');
    }

    const core = {};
    const fields = settings.fields.map(field => {
      const index = Number(field.columnIndex);
      if (!Number.isInteger(index) || !layout.data.includes(index)) throw new Error('Choose an existing data column for each mapped element.');
      const role = MAPPING_ROLES_[field.type];
      if (role && core[role] === undefined) core[role] = index;
      return {id: String(field.id || ''), type: field.type, columnIndex: layout.remap[index]};
    });
    if (c.schema) {
      Object.keys(c.schema.core || {}).forEach(role => {
        if (core[role] === undefined && layout.data.includes(c.schema.core[role])) core[role] = c.schema.core[role];
      });
    }

    // Resolve name-based photos before a layout change can alter identity.
    if (c.schema && layout.uuid.includes(c.schema.uuidCol) && layout.photo.includes(c.schema.photoCol)) {
      try { migrateLegacyPhotos_(c); } catch (error) { Logger.log(error.message); }
      layout.values = inspectStudioColumns_(c).values;
    }

    const schema = repairStudioColumns_(c, layout, false);
    schema.core = {};
    Object.keys(core).forEach(role => { schema.core[role] = layout.remap[core[role]]; });
    schema.writable = Array.from(new Set(fields.map(field => field.columnIndex)));
    c.schema = schema;
    c.p.setProperties({
      [c.schemaKey]: JSON.stringify(schema),
      [worksheetKey_(type, c.id)]: JSON.stringify({sheetId: c.sheet.getSheetId(), header: c.header}),
      [c.keys.sheet]: c.id
    });
    SpreadsheetApp.flush();
    // Retriable; failure must not undo a saved setup.
    try { migrateLegacyPhotos_(c); } catch (error) { Logger.log(error.message); }
    return {success: true, scope: clientStorageScopeForContext_(c), fields: fields};
  });
}

function resetStudioRecordCodes(type) {
  assertAppAccess_();
  const p = userProperties_();
  browserScopeAccount_(p);
  return withSheetLock_(() => {
    if (!p.getProperty(studioKeys_(type).sheet)) return {success: true};
    const c = studioContext_(type);
    const layout = inspectStudioColumns_(c);
    if (!c.schema && !layout.internal.length) return {success: true};
    const oldCore = (c.schema && c.schema.core) || {};
    const schema = repairStudioColumns_(c, layout, true);
    schema.core = {};
    Object.keys(oldCore).forEach(role => {
      if (layout.data.includes(oldCore[role])) schema.core[role] = layout.remap[oldCore[role]];
    });
    schema.writable = [];
    c.p.setProperty(c.schemaKey, JSON.stringify(schema));
    return {success: true};
  });
}

// ============================================================================
// Records: validation, identity, reading and writing
// ============================================================================

function assertStudioSchema_(c) {
  const schema = c.schema;
  if (!schema || schema.photoCol >= c.sheet.getMaxColumns()) throw new Error('Record columns changed. Open Design Mapping and save to repair them.');
  const notes = c.sheet.getRange(1, schema.uuidCol + 1, 1, 2).getNotes()[0];
  if (!String(notes[0]).startsWith(UUID_NOTE_) || !String(notes[1]).startsWith(PHOTO_NOTE_)) {
    throw new Error('Record columns moved or were removed. Open Design Mapping and save to repair them.');
  }
}

function dataRowCount_(c) {
  return Math.max(0, c.sheet.getLastRow() - c.start + 1);
}

function readRows_(c, width) {
  const n = dataRowCount_(c);
  return n ? c.sheet.getRange(c.start, 1, n, width).getDisplayValues() : [];
}

function rowHasData_(row, dataWidth) {
  return row.slice(0, dataWidth).some(v => String(v).trim());
}

/** Throws when newId is already used by another row (blank IDs are ignored). */
function assertUniqueId_(c, index, excludeRow, newId) {
  const key = normalizeStudentId_(newId);
  if (!Number.isInteger(index) || !key) return;
  const clash = readRows_(c, index + 1).findIndex((row, i) => i + c.start !== excludeRow && normalizeStudentId_(row[index]) === key);
  if (clash >= 0) throw new Error('ID ' + newId + ' is already used in spreadsheet row ' + (clash + c.start) + '.');
}

/** True when a row is missing its internal ID or shares one with another row (a copied row). */
function recordIdsNeedRepair_(rows, s) {
  const seen = new Set();
  return rows.some(row => {
    if (!rowHasData_(row, s.dataWidth)) return false;
    const id = row[s.uuidCol];
    if (!id || seen.has(id)) return true;
    seen.add(id);
    return false;
  });
}

/**
 * Gives every non-empty row its own internal ID. A row copied from another
 * row gets a new ID, and the copied photo link is cleared because the photo
 * belongs to the original. Caller holds the sheet lock.
 */
function ensureRecordIds_(c) {
  assertStudioSchema_(c);
  const s = c.schema;
  const seen = new Set();
  readRows_(c, s.photoCol + 1).forEach((row, i) => {
    if (!rowHasData_(row, s.dataWidth)) return;
    const id = row[s.uuidCol];
    if (id && !seen.has(id)) {
      seen.add(id);
      return;
    }
    const fresh = Utilities.getUuid();
    seen.add(fresh);
    c.sheet.getRange(c.start + i, s.uuidCol + 1).setValue(fresh);
    if (row[s.photoCol]) c.sheet.getRange(c.start + i, s.photoCol + 1).clearContent();
  });
}

function recordHeaders_(c) {
  const width = c.schema.dataWidth;
  const first = c.header ? c.sheet.getRange(1, 1, 1, width).getDisplayValues()[0] : [];
  return Array.from({length: width}, (_, i) => columnLabel_(i) + (c.header && first[i] ? ' — ' + first[i] : ''));
}

function readStudioRecords_(type) {
  return loadStudioRecords_(type).records;
}

/** Opens the spreadsheet once and returns {records, headers}. */
function loadStudioRecords_(type) {
  const c = studioContext_(type);
  const s = c.schema;
  if (!s) return {records: [], headers: []};
  assertStudioSchema_(c);
  let rows = readRows_(c, s.photoCol + 1);
  // Only lock when something must be written (new or copied rows).
  if (recordIdsNeedRepair_(rows, s)) {
    withSheetLock_(() => ensureRecordIds_(c));
    rows = readRows_(c, s.photoCol + 1);
  }
  const idIndex = s.core.idNumber;
  const idCounts = Object.create(null);
  if (Number.isInteger(idIndex)) {
    rows.forEach(row => {
      const id = normalizeStudentId_(row[idIndex]);
      if (id && rowHasData_(row, s.dataWidth)) idCounts[id] = (idCounts[id] || 0) + 1;
    });
  }
  const records = [];
  rows.forEach((row, i) => {
    if (!rowHasData_(row, s.dataWidth)) return;
    const record = {
      recordKey: row[s.uuidCol],
      _photoFileId: row[s.photoCol] || '',
      _sheetRow: i + c.start,
      _row: row.slice(0, s.dataWidth)
    };
    Object.keys(s.core).forEach(key => { record[key] = String(row[s.core[key]] || '').trim(); });
    // Duplicates are shown in the studio instead of blocking it.
    if (Number.isInteger(idIndex) && idCounts[normalizeStudentId_(row[idIndex])] > 1) record._duplicateId = true;
    records.push(record);
  });
  return {records: records, headers: recordHeaders_(c)};
}

/** Records plus the column titles, sent once per list (not copied into every record). */
function studioRecordsPayload_(type) {
  return loadStudioRecords_(type);
}

function studioResult_(type, key) {
  return Object.assign({success: true, savedKey: key}, studioRecordsPayload_(type));
}

function changeStudioRecord_(type, record, originalKey, remove) {
  let savedKey = '';
  withSheetLock_(() => {
    const c = studioContext_(type);
    const s = c.schema;
    if (!s) throw new Error('Save your worksheet and column mapping before editing records.');
    if (remove && !originalKey) throw new Error('Select a record to delete.');
    ensureRecordIds_(c);
    if (originalKey) migrateLegacyPhotos_(c);

    const rows = readRows_(c, s.photoCol + 1);
    let matches = [];
    if (originalKey) {
      rows.forEach((r, i) => { if (r[s.uuidCol] === originalKey) matches.push(i); });
      if (matches.length !== 1) throw new Error('The record changed or no longer exists. Use Refresh Data in ⚙ Settings, then try again.');
    }
    const old = matches.length ? rows[matches[0]] : null;
    const rowNumber = old ? matches[0] + c.start : Math.max(c.start, c.sheet.getLastRow() + 1);

    if (remove) {
      // Trash only an explicitly linked photo that no other row uses.
      const photoId = old[s.photoCol];
      if (photoId && rows.filter(r => r[s.photoCol] === photoId).length === 1) {
        checkedStudioPhotoFile_(type, photoId).setTrashed(true);
      }
      c.sheet.deleteRow(rowNumber);
    } else {
      const values = record && record.columnValues;
      if (!values || typeof values !== 'object') throw new Error('Use the mapped record form.');
      const draft = old ? old.slice() : new Array(s.photoCol + 1).fill('');
      const changes = [];
      Object.keys(values).forEach(key => {
        const index = Number(key);
        if (!Number.isInteger(index) || !s.writable.includes(index)) throw new Error('Column mapping changed. Reopen the record form.');
        const value = String(values[key] == null ? '' : values[key]);
        if (value.length > 50000) throw new Error('A field is too long.');
        draft[index] = value;
        changes.push({index: index, value: value});
      });
      if (!rowHasData_(draft, s.dataWidth)) throw new Error('Enter record data first.');
      // Only a new or changed ID is checked, so other fields of an already-duplicated record can still be fixed.
      const idIndex = s.core.idNumber;
      if (Number.isInteger(idIndex) && (!old || normalizeStudentId_(old[idIndex]) !== normalizeStudentId_(draft[idIndex]))) {
        assertUniqueId_(c, idIndex, old ? rowNumber : null, draft[idIndex]);
      }

      if (old) {
        changes.forEach(change => {
          c.sheet.getRange(rowNumber, change.index + 1).setNumberFormat('@').setValue(literalCell_(change.value));
        });
      } else {
        draft[s.uuidCol] = Utilities.getUuid();
        c.sheet.getRange(rowNumber, 1, 1, draft.length).setNumberFormat('@').setValues([draft.map(literalCell_)]);
      }
      savedKey = draft[s.uuidCol];
    }
    SpreadsheetApp.flush();
  });
  return studioResult_(type, savedKey);
}

// ============================================================================
// Photos
// ============================================================================

/** Optional friendly filename; identity is the UUID + Drive file ID. */
/** byId: the list matches unlinked photos by ID number (else by full name). */
const photoMatchById_ = type => cardList_(type).photoMatch === 'id';

function legacyPhotoName_(byId, record) {
  const first = String(record.firstName || '').trim();
  const last = String(record.lastName || '').trim();
  const name = first && last ? first + ' ' + last : record.fullName || first || last;
  return String(byId ? record.idNumber || '' : name || '').trim().replace(/\s+/g, ' ');
}

/** Links unique legacy filenames to rows. Never renames or deletes files. Caller holds the lock. */
function migrateLegacyPhotos_(c) {
  const s = c.schema;
  const folderId = c.p.getProperty(c.keys.folder);
  if (!folderId || !dataRowCount_(c)) return;
  const rows = readRows_(c, s.photoCol + 1);
  const byId = photoMatchById_(c.type);
  const counts = Object.create(null);
  const names = rows.map(r => {
    const value = k => s.core[k] === undefined ? '' : String(r[s.core[k]] || '').trim();
    const name = legacyPhotoName_(byId, {
      idNumber: value('idNumber'), fullName: value('fullName'), firstName: value('firstName'), lastName: value('lastName')
    }).toLowerCase();
    if (name) counts[name] = (counts[name] || 0) + 1;
    return name;
  });
  if (!rows.some((r, i) => names[i] && !r[s.photoCol])) return;

  const byName = Object.create(null);
  const files = DriveApp.getFolderById(folderId).getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (!/^image\//.test(file.getMimeType())) continue;
    const name = driveFileBaseName_(file);
    (byName[name] = byName[name] || []).push(file.getId());
  }
  rows.forEach((r, i) => {
    const name = names[i];
    const matches = byName[name] || [];
    if (name && !r[s.photoCol] && counts[name] === 1 && matches.length === 1) {
      c.sheet.getRange(c.start + i, s.photoCol + 1).setValue(matches[0]);
    }
  });
}

/** The file must live in this user's connected folder and not be trashed. */
function checkedStudioPhotoFile_(type, fileId) {
  const folderId = userProperties_().getProperty(studioKeys_(type).folder);
  if (!folderId) throw new Error('Connect a photo folder first.');
  const file = DriveApp.getFileById(fileId);
  const parents = file.getParents();
  let found = false;
  while (parents.hasNext() && !found) found = parents.next().getId() === folderId;
  if (!found || file.isTrashed()) throw new Error('Photo is unavailable in the connected folder.');
  return file;
}

function findRecord_(records, key) {
  return records.find(r => r.recordKey === String(key));
}

function studioPhotoManifest_(type, keys) {
  const folderId = userProperties_().getProperty(studioKeys_(type).folder);
  if (!folderId) throw new Error('Connect a photo folder first.');
  const records = readStudioRecords_(type);
  let files;
  try {
    files = DriveApp.getFolderById(folderId).getFiles();
  } catch (error) {
    throw new Error('The connected photo folder is unavailable. Reconnect the Photo Folder in Data Sources using a folder accessible to your signed-in Google account.');
  }
  const byName = Object.create(null);
  const byId = Object.create(null);
  const counts = Object.create(null);
  const matchById = photoMatchById_(type);
  records.forEach(r => {
    const name = legacyPhotoName_(matchById, r).toLowerCase();
    counts[name] = (counts[name] || 0) + 1;
  });
  while (files.hasNext()) {
    const file = files.next();
    if (!/^image\//.test(file.getMimeType())) continue;
    const entry = {fileId: file.getId(), updated: file.getLastUpdated().getTime()};
    const name = driveFileBaseName_(file);
    byId[entry.fileId] = entry;
    (byName[name] = byName[name] || []).push(entry);
  }
  return (keys || []).map(key => {
    const record = findRecord_(records, key);
    if (!record) return {key: key, status: 'failed', error: 'Record not found'};
    let entry = record._photoFileId ? byId[record._photoFileId] : null;
    if (!entry) {
      const name = legacyPhotoName_(matchById, record).toLowerCase();
      const matches = byName[name] || [];
      if (matches.length > 1 || (matches.length && counts[name] > 1)) {
        return {key: key, status: 'failed', error: 'Ambiguous full name or duplicate photo. Take a photo for this record.'};
      }
      entry = matches[0];
      if (entry && records.some(other => other.recordKey !== record.recordKey && other._photoFileId === entry.fileId)) {
        return {key: key, status: 'failed', error: 'This photo is linked to another record. Take a photo for this record.'};
      }
    }
    return entry ? {key: key, status: 'ready', fileId: entry.fileId, updated: entry.updated} : {key: key, status: 'missing'};
  });
}

function getStudioPhotoManifest(type, keys) {
  assertAppAccess_();
  return studioPhotoManifest_(type, keys);
}

const FULL_PHOTO_MAX_BYTES_ = 10 * 1024 * 1024;

/**
 * full = false: Drive thumbnail, small and fast, for on-screen cards.
 * full = true:  the original file, for printing and the large card view
 *               (the browser shrinks very large photos before using them).
 */
function studioPhotoFile_(type, fileId, full) {
  const file = checkedStudioPhotoFile_(type, fileId);
  if (full && file.getSize() <= FULL_PHOTO_MAX_BYTES_) {
    const original = file.getBlob();
    return 'data:' + original.getContentType() + ';base64,' + Utilities.base64Encode(original.getBytes());
  }
  const cache = CacheService.getUserCache();
  const key = 'photo-v2-' + fileId + '-' + file.getLastUpdated().getTime();
  const cached = cache.get(key);
  if (cached) return cached;
  let blob = null;
  try { blob = file.getThumbnail(); } catch (error) { /* fall back to full file */ }
  if (!blob) blob = file.getBlob();
  const data = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
  if (data.length < 90000) cache.put(key, data, 21600); // CacheService value limit is 100 KB
  return data;
}

function getStudioPhotoFile(type, fileId, full) {
  assertAppAccess_();
  return studioPhotoFile_(type, fileId, full === true);
}

function saveStudioPhoto_(type, dataUrl, key) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 14000000 || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
    throw new Error('Invalid photo. Capture a JPEG or PNG image again.');
  }
  const records = readStudioRecords_(type);
  const record = findRecord_(records, key);
  if (!record) throw new Error('Select a current record first.');

  const result = withSheetLock_(() => {
    const c = studioContext_(type);
    const s = c.schema;
    const folderId = c.p.getProperty(c.keys.folder);
    if (!folderId) throw new Error('Connect a photo folder first.');
    // Re-find by UUID under the lock; a sort or edit cannot redirect the save.
    const offset = readRows_(c, s.uuidCol + 1).findIndex(r => r[s.uuidCol] === record.recordKey);
    if (offset < 0) throw new Error('Record was removed.');
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
    const name = (legacyPhotoName_(photoMatchById_(type), record) || record.recordKey).replace(/[\\/\x00-\x1f]/g, '_') + (mime === 'image/png' ? '.png' : '.jpg');
    const file = DriveApp.getFolderById(folderId).createFile(Utilities.newBlob(Utilities.base64Decode(dataUrl.split(',')[1]), mime, name));
    try {
      c.sheet.getRange(c.start + offset, s.photoCol + 1).setValue(file.getId());
      SpreadsheetApp.flush();
    } catch (error) {
      file.setTrashed(true);
      throw error;
    }
    const previous = record._photoFileId;
    if (previous && previous !== file.getId() && !records.some(r => r.recordKey !== record.recordKey && r._photoFileId === previous)) {
      try { checkedStudioPhotoFile_(type, previous).setTrashed(true); } catch (error) { Logger.log('Old photo retained: ' + error.message); }
    }
    return {success: true, fileName: name, fileId: file.getId()};
  });
  usageRecord_('photo', type, cardList_(type).name);
  return result;
}

function saveStudioPhoto(type, dataUrl, key) {
  assertAppAccess_();
  return saveStudioPhoto_(type, dataUrl, key);
}

// ============================================================================
// Public record API (thin adapters used by the studio pages)
// ============================================================================

function getConfiguredSpreadsheetHeaders(type) {
  assertAppAccess_();
  const c = studioContext_(type);
  return c.schema ? recordHeaders_(c) : designMappingInfo_(c).columns.map(col => col.label);
}

/** {records, headers} */
function getStudioRecords(type) {
  assertAppAccess_();
  return studioRecordsPayload_(type);
}

function addStudioRecord(type, record) {
  assertAppAccess_();
  return changeStudioRecord_(type, record, null, false);
}

function updateStudioRecord(type, record, key) {
  assertAppAccess_();
  if (!key) throw new Error('Select a record first.');
  return changeStudioRecord_(type, record, String(key), false);
}

function deleteStudioRecord(type, key) {
  assertAppAccess_();
  return changeStudioRecord_(type, null, String(key || ''), true);
}

// ============================================================================
// Web app entry, tab host and templates
// ============================================================================

const STUDIO_TEMPLATES_ = {cards: 'CardStudio', design: 'Design', 'control-center': 'ControlCenter'};
const STUDIO_INCLUDES_ = ['DesignRuntime', 'StudioClient'];

/** Old links (?studio=student|staff|custom) open Card Studio on that list. */
function studioTabRoute_(parameters) {
  const screen = String(parameters.screen || '').trim().toLowerCase();
  const studio = String(parameters.studio || parameters.page || parameters.mode || '').trim().toLowerCase();
  if (studio === 'control-center' || screen === 'control-center') return {tab: 'control-center', list: ''};
  if (studio === 'design' || screen === 'card-designer-v3' || screen === 'design-studio') return {tab: 'design', list: ''};
  const legacy = {'student-studio': 'student', 'staff-studio': 'staff', 'custom-studio': 'custom'}[screen] || studio;
  return {tab: 'cards', list: /^[a-z0-9]{1,40}$/.test(String(parameters.list || legacy)) ? String(parameters.list || legacy) : ''};
}

function doGet(e) {
  const route = studioTabRoute_((e && e.parameter) || {});
  let access;
  try {
    access = assertAppAccess_();
    if (route.tab === 'control-center' && !access.isAdmin) throw new Error('Administrator access is required.');
  } catch (error) {
    return accessDeniedPage_();
  }
  const template = HtmlService.createTemplateFromFile('StudioTabs');
  template.isAdministrator = access.isAdmin;
  template.initialTab = route.tab;
  template.initialList = route.list;
  usageRecord_('visit', 'landing');
  // ALLOWALL permits embedding (e.g. Google Sites). Use DEFAULT if you never embed the app.
  return template.evaluate()
    .setTitle('ID Card Studio')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Renders a tab for the authenticated tab host. For 'cards', listId picks the list (else the last one used). */
function getStudioTabHtml(studio, listId) {
  const access = assertAppAccess_();
  if (typeof studio !== 'string' || !Object.prototype.hasOwnProperty.call(STUDIO_TEMPLATES_, studio)) throw new Error('Unknown studio.');
  if (studio === 'control-center' && !access.isAdmin) throw new Error('Administrator access is required.');
  const template = HtmlService.createTemplateFromFile(STUDIO_TEMPLATES_[studio]);
  template.isAdministrator = access.isAdmin;
  template.studioType = studio;
  let data = null;
  if (studio === 'cards') {
    // The page arrives with its list and records already inside: no extra requests to start.
    data = cardListData_(listId, true);
    template.initialData = data;
    template.page = data.page;
  }
  const bridge = HtmlService.createHtmlOutputFromFile('StudioTabBridge').getContent();
  const html = template.evaluate().getContent().replace(/<head\b[^>]*>/i, head => head + '\n' + bridge);
  if (studio === 'design') usageRecord_('open', 'design', 'Design Studio');
  return {studio: studio, list: data ? data.list : '', html: html};
}

function getStudioTabsAccess() {
  return {isAdministrator: assertAppAccess_().isAdmin};
}

/** Called from template scriptlets: <?!= include('DesignRuntime') ?> */
function include(fileName) {
  assertAppAccess_();
  if (STUDIO_INCLUDES_.indexOf(fileName) < 0) throw new Error('Unsupported include.');
  return HtmlService.createHtmlOutputFromFile(fileName).getContent();
}