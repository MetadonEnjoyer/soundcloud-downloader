// Small window opened from the menu's settings panel: the system folder dialog would close the toolbar popup.
const $ = (id) => document.getElementById(id);
const CLOSE_DELAY_MS = 1200;

const status = (text, isError = false) => {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
};

const render = async () => {
  const root = await scdlKvGet('root');
  $('current').textContent = root ? root.name : 'Загрузки (папка Chrome)';
  $('regrant').hidden = !root || (await root.queryPermission({ mode: 'readwrite' })) === 'granted';
};

const done = async (text) => {
  await render();
  status(text);
  setTimeout(() => window.close(), CLOSE_DELAY_MS);
};

$('pick').addEventListener('click', async () => {
  try {
    const dir = await showDirectoryPicker({ id: 'scdl', mode: 'readwrite', startIn: 'music' });
    await scdlKvSet('root', dir);
    await chrome.storage.local.set({ folderName: dir.name });
    await done(`Сохраняю в «${dir.name}».`);
  } catch (e) {
    if (e.name !== 'AbortError') status(e.message, true); // AbortError = dialog cancelled
  }
});

$('regrant').addEventListener('click', async () => {
  const root = await scdlKvGet('root');
  if ((await root.requestPermission({ mode: 'readwrite' })) === 'granted') await done(`Доступ к «${root.name}» есть.`);
  else status('Доступ не выдан.', true);
});

$('reset').addEventListener('click', async () => {
  await scdlKvDel('root');
  await chrome.storage.local.remove('folderName');
  await done('Сохраняю в «Загрузки».');
});

render().catch((e) => status(e.message, true));
