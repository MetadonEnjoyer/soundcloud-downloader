const $ = (id) => document.getElementById(id);
const RESERVED_ROOT = /^(you|discover|search|charts|pages|stations|upload|settings|messages|notifications|feed|people|tags|jobs|imprint|terms-of-use)$/;
const SC_URL = /^https:\/\/(m\.)?soundcloud\.com\//;
const PICKER_SIZE = { width: 400, height: 320 };
const KIND_LABEL = {
  url: 'Скачивается',
  artistTracks: 'Скачиваются песни исполнителя',
  likes: 'Скачивается «Нравится»',
  artistPlaylist: 'Собираю плейлист исполнителя',
  likesPlaylist: 'Собираю плейлист из лайков',
  merge: 'Объединяю плейлисты',
};

// Progress text from the engine: "3/12 45%" (track 3 of 12, 45% of it), "45%", or a plain step like "лайков 200".
const percentOf = (text) => {
  const many = text.match(/^(\d+)\/(\d+)(?:\s+(\d+)%)?/);
  if (many) return ((Number(many[1]) - 1 + Number(many[3] || 0) / 100) / Number(many[2])) * 100;
  const one = text.match(/^(\d+)%/);
  return one ? Number(one[1]) : null;
};

// Slides in while something downloads and out when it finishes; the last text stays while it slides out.
const renderNow = (now) => {
  $('now').classList.toggle('is-visible', Boolean(now));
  if (!now) return;
  $('now-kind').textContent = now.paused ? 'На паузе' : KIND_LABEL[now.kind] || 'Скачивается';
  $('now-pause').textContent = now.paused ? 'Продолжить' : 'Пауза';
  $('now-pause').dataset.action = now.paused ? 'resume' : 'pause';
  $('now-title').textContent = now.title || '';
  $('now-text').textContent = now.text;
  const pct = percentOf(now.text);
  $('now-fill').style.width = `${pct ?? 100}%`;
  $('now-fill').classList.toggle('indeterminate', pct === null);
};

const status = (text, isError = false) => {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
};

// Checklist of the user's own and liked playlists for merging.
const loadPlaylists = async () => {
  const box = $('playlists');
  const note = (text) => box.replaceChildren(Object.assign(document.createElement('p'), { className: 'note', textContent: text }));
  const r = await chrome.runtime.sendMessage({ to: 'bg', type: 'listPlaylists' });
  if (r?.error) return note(r.error);
  if (!r?.list?.length) return note('Плейлистов не найдено.');
  box.replaceChildren(...r.list.map((p) => {
    const row = document.createElement('label');
    row.className = 'pl-item';
    const box2 = Object.assign(document.createElement('input'), { type: 'checkbox', value: p.url });
    const title = Object.assign(document.createElement('span'), { className: 'pl-title', textContent: p.title });
    const meta = Object.assign(document.createElement('span'), { className: 'pl-meta', textContent: `${p.count ?? '?'}${p.mine ? '' : ' · ♥'}` });
    row.append(box2, title, meta);
    return row;
  }));
};

const init = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onSite = SC_URL.test(tab?.url || '');
  if (!onSite) {
    $('off-site').hidden = false;
    document.querySelectorAll('[data-job]').forEach((b) => { b.disabled = true; });
  } else {
    const first = new URL(tab.url).pathname.replace(/^\/n(?=\/)/, '').split('/').filter(Boolean)[0]; // new site: /n/user/...
    if (first && !RESERVED_ROOT.test(first)) $('artist').value = `https://soundcloud.com/${first}`;
    loadPlaylists().catch((e) => status(e.message, true));
  }

  const control = (action) => chrome.runtime.sendMessage({ to: 'bg', type: 'control', action });
  $('now-pause').addEventListener('click', () => control($('now-pause').dataset.action || 'pause'));
  $('now-stop').addEventListener('click', () => control('stop'));

  const { status: now } = await chrome.storage.session.get('status');
  renderNow(now);
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.status) renderNow(changes.status.newValue);
  });

  const jobFor = {
    artistTracks: () => ({ url: $('artist').value.trim() }),
    artistPlaylist: () => ({ url: $('artist').value.trim() }),
    likes: () => ({}),
    likesPlaylist: () => ({}),
    merge: () => ({ urls: [...$('playlists').querySelectorAll('input:checked')].map((c) => c.value), title: $('merge-title').value.trim() }),
  };

  document.querySelectorAll('[data-job]').forEach((btn) => btn.addEventListener('click', async () => {
    const kind = btn.dataset.job;
    const job = { kind, ...jobFor[kind]() };
    if ('url' in job && !SC_URL.test(job.url)) return status('Вставьте ссылку на исполнителя SoundCloud.', true);
    if (kind === 'merge' && job.urls.length < 2) return status('Отметьте минимум два плейлиста.', true);
    const r = await chrome.runtime.sendMessage({ to: 'bg', type: 'job', job, tabId: tab.id });
    if (r?.error) return status(r.error, true);
    status('Запущено. Прогресс виден на значке, итог появится на странице.');
  }));

  const { folderName } = await chrome.storage.local.get('folderName');
  $('folder-name').textContent = folderName || 'Загрузки';

  // ⚙ swaps the menu for the settings panel inside this same popup.
  $('open-settings').addEventListener('click', () => {
    const open = $('settings').hidden;
    $('settings').hidden = !open;
    $('menu').hidden = open;
    $('open-settings').setAttribute('aria-expanded', String(open));
    status('');
  });
  // The system folder dialog closes a toolbar popup the moment it opens, taking the dialog with it,
  // so it is shown from a small window of its own that closes itself after the choice.
  $('choose-folder').addEventListener('click', () => {
    chrome.windows.create({ url: 'picker.html', type: 'popup', ...PICKER_SIZE });
    window.close();
  });
};

init().catch((e) => status(e.message, true));
