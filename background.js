importScripts('shared.js');

const ENGINE = 'engine.html';
let creatingEngine;

const ensureEngine = async () => {
  if (await chrome.offscreen.hasDocument()) return;
  creatingEngine ||= chrome.offscreen.createDocument({ url: ENGINE, reasons: ['BLOBS'], justification: 'Сборка mp3-файлов для скачивания' })
    .finally(() => { creatingEngine = null; });
  await creatingEngine;
};

const waitForDownload = (id) => new Promise((resolve) => {
  const onChanged = (d) => {
    if (d.id !== id || !d.state) return;
    if (d.state.current === 'in_progress') return;
    chrome.downloads.onChanged.removeListener(onChanged);
    resolve(d.state.current === 'complete' ? {} : { error: d.error?.current || 'загрузка прервана' });
  };
  chrome.downloads.onChanged.addListener(onChanged);
});

// Chrome drops the `filename` given to downloads.download() when another extension listens to
// onDeterminingFilename (download managers, antiviruses), leaving a blob-UUID name and no folder.
// Re-suggesting our own name here wins that race for our downloads only.
const pendingNames = new Map(); // blob url -> "Folder/Artist - Title.mp3"
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = pendingNames.get(item.url);
  if (!filename) return; // not ours: leave it to Chrome and other extensions
  pendingNames.delete(item.url);
  suggest({ filename, conflictAction: 'uniquify' });
});

// Fallback when no folder is picked in settings: Chrome's own Downloads folder.
const saveFile = async ({ url, path }) => {
  const filename = path.map(scdlSafePart).filter((p) => p && p !== '..').join('/');
  pendingNames.set(url, filename);
  try {
    return await waitForDownload(await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }));
  } catch (e) {
    return { error: e.message };
  } finally {
    pendingNames.delete(url);
  }
};

// Runs inside the soundcloud.com tab so the write goes out with the site's own origin and login.
function pageCreatePlaylist(title, ids, clientId) {
  const token = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/)?.[1];
  if (!token) return { error: 'войдите в аккаунт SoundCloud' };
  return fetch(`https://api-v2.soundcloud.com/playlists?client_id=${clientId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `OAuth ${token}` },
    body: JSON.stringify({ playlist: { title, sharing: 'private', tracks: ids } }),
  }).then(async (r) => (r.ok ? { url: (await r.json()).permalink_url } : { error: `HTTP ${r.status}` }))
    .catch((e) => ({ error: e.message }));
}

const createPlaylist = async ({ tabId, title, ids, clientId }) => {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageCreatePlaylist, args: [title, ids, clientId] });
    return result;
  } catch (e) {
    return { error: `вкладка SoundCloud закрыта (${e.message})` };
  }
};

const getToken = async () => (await chrome.cookies.get({ url: 'https://soundcloud.com', name: 'oauth_token' }))?.value;

const listPlaylists = async () => {
  await ensureEngine();
  return chrome.runtime.sendMessage({ to: 'engine', type: 'listPlaylists', token: await getToken() });
};

const startJob = async (job, tabId) => {
  const cookie = { value: await getToken() };
  const full = { ...job, id: job.id || crypto.randomUUID(), fromButton: Boolean(job.id), tabId, token: cookie?.value };
  await ensureEngine();
  chrome.runtime.sendMessage({ to: 'engine', type: 'run', job: full }).catch(() => {}); // engine never replies
  return { id: full.id };
};

const toTab = (job, msg) => job.tabId && chrome.tabs.sendMessage(job.tabId, { ...msg, id: job.id, fromButton: job.fromButton }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.to !== 'bg') return false;
  const handlers = {
    job: () => startJob(msg.job, sender.tab?.id ?? msg.tabId),
    save: () => saveFile(msg),
    listPlaylists,
    createPlaylist: () => createPlaylist(msg),
    // The menu reads `status` from session storage to show what is downloading right now.
    progress: async () => {
      chrome.action.setBadgeText({ text: msg.text.split(' ')[0].slice(0, 5) });
      chrome.storage.session.set({ status: { text: msg.text, title: msg.title || '', kind: msg.kind } });
      toTab(msg.job, { type: 'scdl-progress', text: msg.text });
    },
    // Pause / resume / stop from the menu: the engine does the work, the menu reads `paused` from status.
    control: async () => {
      await ensureEngine();
      chrome.runtime.sendMessage({ to: 'engine', type: 'control', action: msg.action }).catch(() => {});
      const { status } = await chrome.storage.session.get('status');
      if (msg.action === 'stop') {
        chrome.action.setBadgeText({ text: '' });
        await chrome.storage.session.remove('status');
      } else if (status) {
        chrome.action.setBadgeText({ text: msg.action === 'pause' ? 'II' : status.text.split(' ')[0].slice(0, 5) });
        await chrome.storage.session.set({ status: { ...status, paused: msg.action === 'pause' } });
      }
    },
    done: async () => {
      chrome.action.setBadgeText({ text: '' });
      chrome.storage.session.remove('status');
      toTab(msg.job, { type: 'scdl-done', error: msg.error, message: msg.message });
    },
  };
  handlers[msg.type]?.().then(sendResponse, (e) => sendResponse({ error: e.message }));
  return true;
});

chrome.action.setBadgeBackgroundColor({ color: '#f50' });
