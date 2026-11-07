// Offscreen document: talks to the SoundCloud API, builds tagged MP3s and hands blob URLs to background.js to save.
const API = 'https://api-v2.soundcloud.com';
const MP3_KBPS = 256;
const ENCODE_BLOCK = 1152 * 200; // samples per encoder call; yield between blocks
const IDS_PER_REQUEST = 50;
const PAGE_SIZE = 200;
const PLAYLIST_MAX = 500; // SoundCloud's playlist size limit

const DOWNLOAD_SHARE = 0.6; // when a track is re-encoded, downloading fills 60% of its bar and encoding the rest

let clientId;
let token; // OAuth token of the current job (jobs run one at a time)

// Pause / stop. "Stop" bumps stopGen: the running job and every queued one see a stale generation and end.
class Stopped extends Error {}
let stopGen = 0;
let currentGen = 0;
let pause = null; // { promise, resume } while paused
let abortCtl = new AbortController(); // aborts in-flight requests on stop

const gate = async () => {
  if (currentGen !== stopGen) throw new Stopped();
  while (pause) await pause.promise;
  if (currentGen !== stopGen) throw new Stopped();
};
const isStop = (e) => e instanceof Stopped;

const control = (action) => {
  if (action === 'pause' && !pause) {
    let resume;
    pause = { promise: new Promise((r) => { resume = r; }), resume: () => resume() };
  }
  if (action === 'resume' || action === 'stop') {
    pause?.resume();
    pause = null;
  }
  if (action === 'stop') {
    stopGen++;
    abortCtl.abort();
    abortCtl = new AbortController();
  }
};

const toBg = (msg) => chrome.runtime.sendMessage({ to: 'bg', ...msg });

const fetchOk = async (url, headers) => {
  let r;
  try {
    r = await fetch(url, { headers, signal: abortCtl.signal });
  } catch (e) {
    if (currentGen !== stopGen) throw new Stopped();
    throw e;
  }
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}: ${url.split('?')[0]}`), { status: r.status });
  return r;
};

const getClientId = async () => {
  if (clientId) return clientId;
  const html = await (await fetchOk('https://soundcloud.com/')).text();
  for (const [, src] of [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].reverse()) {
    try {
      const m = (await (await fetch(src)).text()).match(/client_id\s*:\s*"(\w+)"/);
      if (m) return (clientId = m[1]);
    } catch { /* next script */ }
  }
  throw new Error('Не нашёл client_id SoundCloud.');
};

const api = async (pathOrUrl) => {
  const call = async () => {
    const u = new URL(pathOrUrl, API);
    u.searchParams.set('client_id', await getClientId());
    return (await fetchOk(u.href, token ? { Authorization: `OAuth ${token}` } : undefined)).json();
  };
  try {
    return await call();
  } catch (e) {
    if (e.status !== 401 || !clientId) throw e;
    clientId = null; // client_id rotated: scrape a fresh one once
    return call();
  }
};

const resolve = (url) => api(`/resolve?url=${encodeURIComponent(url)}`);

const paged = async (path, progress, label) => {
  const out = [];
  for (let url = path; url;) {
    await gate();
    const page = await api(url);
    out.push(...page.collection);
    progress(`${label} ${out.length}`);
    url = page.next_href;
  }
  return out;
};

// Playlists and likes may return bare {id} stubs; fetch full objects and keep the original order.
const completeTracks = async (list) => {
  const full = new Map(list.filter((t) => t.media).map((t) => [t.id, t]));
  const missing = list.filter((t) => !t.media).map((t) => t.id);
  for (let i = 0; i < missing.length; i += IDS_PER_REQUEST) {
    (await api(`/tracks?ids=${missing.slice(i, i + IDS_PER_REQUEST).join(',')}`)).forEach((t) => full.set(t.id, t));
  }
  return list.map((t) => full.get(t.id)).filter(Boolean);
};

const userFromUrl = async (url) => {
  const u = await resolve(url);
  if (u.kind !== 'user') throw new Error('Это не страница исполнителя.');
  return u;
};
const artistTracks = async (user, progress) => completeTracks(await paged(`/users/${user.id}/tracks?limit=${PAGE_SIZE}&linked_partitioning=1`, progress, 'треков'));
const likedTracks = async (progress) => {
  if (!token) throw new Error('Войдите в аккаунт SoundCloud.');
  const me = await api('/me');
  const likes = await paged(`/users/${me.id}/track_likes?limit=${PAGE_SIZE}&linked_partitioning=1`, progress, 'лайков');
  return completeTracks(likes.map((l) => l.track).filter(Boolean));
};

const isMp3 = (t) => t.format.mime_type.startsWith('audio/mpeg');
// Plain (non-DRM) streams, best first: mp3 file, mp3 HLS, then aac / opus that get re-encoded to mp3.
const rank = (t) => (t.format.protocol === 'progressive' ? 0 : 1) + (isMp3(t) ? 0 : t.format.mime_type.startsWith('audio/mp4') ? 2 : 4);

const fetchStream = async (t, track, progress) => {
  const u = new URL(t.url);
  if (track.track_authorization) u.searchParams.set('track_authorization', track.track_authorization);
  const { url } = await api(u.href);
  if (t.format.protocol === 'progressive') return new Uint8Array(await (await fetchOk(url)).arrayBuffer());
  const playlist = await (await fetchOk(url)).text();
  const init = playlist.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
  const segments = playlist.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const urls = init ? [init, ...segments] : segments;
  const parts = [];
  for (const [i, seg] of urls.entries()) {
    await gate();
    progress(i / urls.length);
    parts.push(await (await fetchOk(new URL(seg, url).href)).arrayBuffer());
  }
  return new Uint8Array(await new Blob(parts).arrayBuffer());
};

// shortcut: re-encoding aac→mp3 is lossy-to-lossy; only used when SoundCloud has no mp3 stream for the track.
const toMp3 = async (bytes, progress) => {
  if (!globalThis.lamejs) throw new Error('Нет файла lame.min.js в папке расширения, перекодировать в mp3 нечем.');
  const audio = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes.buffer);
  const toInt16 = (f) => Int16Array.from(f, (x) => Math.max(-1, Math.min(1, x)) * 0x7fff);
  const left = toInt16(audio.getChannelData(0));
  const right = audio.numberOfChannels > 1 ? toInt16(audio.getChannelData(1)) : left;
  const encoder = new lamejs.Mp3Encoder(2, 44100, MP3_KBPS);
  const out = [];
  for (let i = 0; i < left.length; i += ENCODE_BLOCK) {
    await gate();
    progress(i / left.length);
    out.push(encoder.encodeBuffer(left.subarray(i, i + ENCODE_BLOCK), right.subarray(i, i + ENCODE_BLOCK)));
    await new Promise((r) => setTimeout(r));
  }
  out.push(encoder.flush());
  return new Uint8Array(await new Blob(out).arrayBuffer());
};

const fetchCover = async (track) => {
  const art = track.artwork_url || track.user?.avatar_url;
  if (!art) return null;
  const r = await fetchOk(art.replace('-large', '-t500x500'));
  return { mime: r.headers.get('content-type') || 'image/jpeg', data: new Uint8Array(await r.arrayBuffer()) };
};

const buildMp3 = async (track, progress, extra = {}) => {
  if (track.policy === 'SNIP') throw new Error('только по подписке Go+ (доступно лишь превью)');
  const candidates = (track.media?.transcodings || [])
    .filter((t) => ['progressive', 'hls'].includes(t.format.protocol)) // encrypted (DRM) streams are skipped
    .sort((a, b) => rank(a) - rank(b));
  if (!candidates.length) throw new Error('защищён DRM');

  // SoundCloud retired some stream types (they 404), so fall through to the next one.
  // One bar per track: download (and, if needed, mp3 encoding after it) report fractions of the same 0–100%.
  const pct = (f) => progress(`${Math.round(f * 100)}%`);
  let mp3; let lastError;
  for (const t of candidates) {
    try {
      const share = isMp3(t) ? 1 : DOWNLOAD_SHARE;
      const bytes = await fetchStream(t, track, (f) => pct(f * share));
      mp3 = isMp3(t) ? bytes : await toMp3(bytes, (f) => pct(share + f * (1 - share)));
      break;
    } catch (e) {
      if (isStop(e)) throw e;
      lastError = e;
    }
  }
  if (!mp3) throw lastError;

  const meta = track.publisher_metadata || {};
  const { artist, title } = scdlTrackMeta(track.title, meta.artist || track.user?.username || 'unknown');
  const tag = scdlId3({
    title,
    artist,
    album: meta.album_title || extra.album,
    track: extra.trackNo,
    year: (track.release_date || track.display_date || track.created_at || '').slice(0, 4),
    genre: track.genre,
    publisher: meta.publisher || track.label_name,
    isrc: meta.isrc,
    comment: track.description,
    url: track.permalink_url,
    cover: await fetchCover(track).catch(() => null), // a missing cover shouldn't cost the whole download
  });
  return { blob: new Blob([tag, mp3], { type: 'audio/mpeg' }), name: `${artist} - ${title}` };
};

let folderWarning = null; // set once per job when the picked folder can't be used

// Next free "name (2).mp3" style name, like the browser's own download uniquify.
const freeName = async (dir, name) => {
  const dot = name.lastIndexOf('.');
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
    try { await dir.getFileHandle(candidate); } catch { return candidate; }
  }
};

// Writes into the folder picked in settings; false when none is picked or access was not kept.
const saveToPickedFolder = async (blob, path) => {
  const root = await scdlKvGet('root');
  if (!root) return false;
  if (await root.queryPermission({ mode: 'readwrite' }) !== 'granted') {
    folderWarning = `Нет доступа к папке «${root.name}», файлы сохранены в «Загрузки». Откройте настройки расширения и разрешите доступ снова.`;
    return false;
  }
  let dir = root;
  for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(scdlSafePart(part), { create: true });
  const writable = await (await dir.getFileHandle(await freeName(dir, scdlSafePart(path.at(-1))), { create: true })).createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
};

const save = async (blob, path) => {
  if (await saveToPickedFolder(blob, path)) return;
  const url = URL.createObjectURL(blob);
  try {
    const r = await toBg({ type: 'save', url, path });
    if (r?.error) throw new Error(r.error);
  } finally {
    URL.revokeObjectURL(url);
  }
};

const downloadMany = async (folder, tracks, progress, { numbered = false, album } = {}) => {
  if (!tracks.length) throw new Error('Треков не найдено.');
  const pad = String(tracks.length).length;
  const failed = [];
  for (const [i, track] of tracks.entries()) {
    await gate();
    try {
      const { blob, name } = await buildMp3(track, (p) => progress(`${i + 1}/${tracks.length} ${p}`, track.title), { album, trackNo: numbered ? i + 1 : undefined });
      await save(blob, [folder, `${numbered ? `${String(i + 1).padStart(pad, '0')}. ` : ''}${name}.mp3`]);
    } catch (e) {
      if (isStop(e)) throw e;
      failed.push(`${i + 1}. ${track.title}: ${e.message}`);
    }
  }
  return `«${folder}»: скачано ${tracks.length - failed.length} из ${tracks.length}.${failed.length ? `\nНе скачались:\n${failed.join('\n')}` : ''}`;
};

const createPlaylists = async (job, title, ids, progress) => {
  if (!ids.length) throw new Error('Треков не найдено.');
  const urls = [];
  const chunks = Math.ceil(ids.length / PLAYLIST_MAX);
  for (let i = 0; i < chunks; i++) {
    const name = chunks > 1 ? `${title} (${i + 1})` : title;
    progress(`плейлист ${i + 1}/${chunks}`);
    const r = await toBg({ type: 'createPlaylist', tabId: job.tabId, title: name, ids: ids.slice(i * PLAYLIST_MAX, (i + 1) * PLAYLIST_MAX), clientId: await getClientId() });
    if (r?.error) throw new Error(`не удалось создать плейлист: ${r.error}`);
    urls.push(r.url);
  }
  return `Создан приватный плейлист (${ids.length} треков):\n${urls.join('\n')}`;
};

const JOBS = {
  async url(job, progress) {
    const item = await resolve(job.url);
    if (item.kind === 'track') {
      const { blob, name } = await buildMp3(item, (p) => progress(p, item.title));
      await save(blob, [`${name}.mp3`]);
      return null;
    }
    if (item.kind === 'playlist') return downloadMany(item.title, await completeTracks(item.tracks), progress, { numbered: true, album: item.title });
    if (item.kind === 'user') return downloadMany(item.username, await artistTracks(item, progress), progress);
    throw new Error('Не понял, что это за ссылка.');
  },
  async artistTracks(job, progress) {
    const user = await userFromUrl(job.url);
    return downloadMany(user.username, await artistTracks(user, progress), progress);
  },
  async likes(job, progress) {
    return downloadMany('Нравится', await likedTracks(progress), progress);
  },
  async artistPlaylist(job, progress) {
    const user = await userFromUrl(job.url);
    return createPlaylists(job, `${user.username} — все треки`, (await artistTracks(user, progress)).map((t) => t.id), progress);
  },
  async likesPlaylist(job, progress) {
    return createPlaylists(job, `Нравится ${new Date().toLocaleDateString('ru-RU')}`, (await likedTracks(progress)).map((t) => t.id), progress);
  },
  async merge(job, progress) {
    const ids = [];
    for (const [i, url] of job.urls.entries()) {
      progress(`плейлист ${i + 1}/${job.urls.length}`);
      const set = await resolve(url);
      if (set.kind !== 'playlist') throw new Error(`Это не плейлист: ${url}`);
      ids.push(...set.tracks.map((t) => t.id));
    }
    return createPlaylists(job, job.title || 'Объединённый плейлист', [...new Set(ids)], progress);
  },
};

// The user's own playlists and the ones they liked, for the "merge" checklist in the menu.
const listPlaylists = async () => {
  if (!token) throw new Error('Войдите в аккаунт SoundCloud.');
  const me = await api('/me');
  const noProgress = () => {};
  const own = await paged(`/users/${me.id}/playlists?limit=${PAGE_SIZE}&linked_partitioning=1`, noProgress, '');
  const liked = (await paged(`/users/${me.id}/playlist_likes?limit=${PAGE_SIZE}&linked_partitioning=1`, noProgress, ''))
    .map((l) => l.playlist).filter(Boolean);
  const seen = new Set();
  return [...own.map((p) => ({ p, mine: true })), ...liked.map((p) => ({ p, mine: false }))]
    .filter(({ p }) => !seen.has(p.id) && seen.add(p.id))
    .map(({ p, mine }) => ({ title: p.title, url: p.permalink_url, count: p.track_count, mine }));
};

let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.to !== 'engine') return false;
  if (msg.type === 'listPlaylists') {
    token = msg.token;
    currentGen = stopGen;
    listPlaylists().then((list) => sendResponse({ list }), (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'control') {
    control(msg.action);
    return false;
  }
  if (msg.type !== 'run') return false;
  const { job } = msg;
  const ref = { id: job.id, tabId: job.tabId, fromButton: job.fromButton };
  const gen = stopGen; // a "stop" pressed while this job waits in the queue cancels it too
  queue = queue.then(async () => {
    token = job.token;
    folderWarning = null;
    currentGen = gen;
    const progress = (text, title) => toBg({ type: 'progress', job: ref, text, title, kind: job.kind });
    try {
      await gate();
      const message = await JOBS[job.kind](job, progress);
      await toBg({ type: 'done', job: ref, message: [message, folderWarning].filter(Boolean).join('\n\n') || null });
    } catch (e) {
      await toBg({ type: 'done', job: ref, ...(isStop(e) ? { stopped: true } : { error: e.message }) });
    }
  });
});
