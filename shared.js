// Helpers shared by background.js, engine.html, picker.html and popup.html.
const ILLEGAL_PATH_CHARS = /[\\/:*?"<>|\u0000-\u001f~]+/g;
const NAME_MAX = 150;

// Windows rejects reserved characters and trailing dots/spaces in file and folder names.
globalThis.scdlSafePart = (s) => String(s).replace(ILLEGAL_PATH_CHARS, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, NAME_MAX);

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
