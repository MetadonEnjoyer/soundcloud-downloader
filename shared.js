// Helpers shared by background.js, engine.html, picker.html and popup.html.
const ILLEGAL_PATH_CHARS = /[\\/:*?"<>|\u0000-\u001f~]+/g;
const NAME_MAX = 150;

const EXTENSION = /(\.[a-z0-9]{1,5})$/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

// Windows rejects reserved characters, trailing dots/spaces and device names (CON, NUL…) in file and folder names.
// Long names are cut before the extension, so "….mp3" never loses its ".mp3".
globalThis.scdlSafePart = (s) => {
  const clean = String(s).replace(ILLEGAL_PATH_CHARS, '_').replace(/^[. ]+|[. ]+$/g, '');
  const ext = clean.match(EXTENSION)?.[1] || '';
  const base = clean.slice(0, clean.length - ext.length).slice(0, NAME_MAX - ext.length).replace(/[. ]+$/, '');
  const name = `${base}${ext}`;
  return WINDOWS_RESERVED.test(name) ? `_${name}` : name;
};

// Tiny key-value store in the extension's IndexedDB: the only place a folder handle can be kept.
const kv = (mode, op) => new Promise((resolve, reject) => {
  const open = indexedDB.open('scdl', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction('kv', mode);
    const req = op(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  };
});
globalThis.scdlKvGet = (key) => kv('readonly', (s) => s.get(key));
globalThis.scdlKvSet = (key, value) => kv('readwrite', (s) => s.put(value, key));
globalThis.scdlKvDel = (key) => kv('readwrite', (s) => s.delete(key));
