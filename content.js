// Adds an orange download button to every track/playlist on soundcloud.com; the work happens in the extension.
(() => {
  const RESERVED_ROOT = /^(you|discover|search|charts|pages|stations|upload|settings|messages|notifications|feed|people|tags|jobs|imprint|terms-of-use)$/;
  const RESERVED_SUB = /^(likes|tracks|albums|sets|reposts|followers|following|popular-tracks|comments|spotlight|toptracks)$/;
  // Cards whose own link is the item to download; the player bar reuses its DOM, so links are read at click time.
  const CARD = '.playbackSoundBadge, .queueItemView, .trackItem, .compactTrackListItem, .soundBadge, .playableTile, .sound';
  const SHARE_LABEL = /^share$/i;
  const SKIP = '.commentItem, .playControls, .modal, .dropdownMenu, [role="menu"], [role="dialog"]';
  const CLICKABLE = 'button, [role="button"]';
  const ARROW = 'M7 2h2v6.6l2.3-2.3 1.4 1.4L8 12.4 3.3 7.7l1.4-1.4L7 8.6V2zM3 13h10v2H3z';
  const ROLE_CLASSES = /\bsc-button-(more|like|follow|selected|repost|share|copylink|addtoset|addtonextup)\b/g;
  const pending = new Map(); // job id -> button

  const STYLE_ID = 'scdl-style';
  // The new /n/ site rewrites <head>, so the style is re-added whenever it disappears.
  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    document.documentElement.append(Object.assign(document.createElement('style'), {
      id: STYLE_ID,
      // Only the icon is orange; the outline/background stay as on the neighbouring buttons.
      textContent: `.scdl-btn svg, .scdl-btn svg path { fill: #f50 !important; stroke: none !important; color: #f50 !important; }
        .scdl-btn .scdl-progress { color: #f50; font-size: 10px; font-weight: 600; white-space: nowrap; }`,
    }));
  };

  const itemPath = (href) => {
    // The new site lives under /n/ (soundcloud.com/n/user/track); the API only knows the classic path.
    const path = new URL(href, location.origin).pathname.replace(/^\/n(?=\/)/, '').replace(/\/$/, '');
    const parts = path.split('/').filter(Boolean);
    const ok = (parts.length === 2 && !RESERVED_SUB.test(parts[1])) || (parts.length === 3 && parts[1] === 'sets');
    return ok && !RESERVED_ROOT.test(parts[0]) ? `https://soundcloud.com${path}` : null;
  };

  // The new track page is drawn inside an embedded soundcloud.com iframe (/n/pages/standby…);
  // there the track URL lives in the top window's address.
  const pageItem = () => {
    const own = itemPath(location.pathname);
    if (own || window === window.top) return own;
    try { return itemPath(window.top.location.pathname); } catch { return null; }
  };

  const targetUrl = (btn) => {
    const card = btn.closest(CARD);
    if (!card) return pageItem();
    return [...card.querySelectorAll('a[href]')].map((a) => itemPath(a.getAttribute('href'))).find(Boolean) || null;
  };

  const arrowSvg = (like) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const attr of ['class', 'width', 'height', 'style']) if (like?.hasAttribute(attr)) svg.setAttribute(attr, like.getAttribute(attr));
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ARROW);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  };

  // Clone the neighbouring button so ours gets the exact same shape and size, then swap in our icon.
  const makeButton = (model) => {
    const btn = model.cloneNode(true);
    for (const attr of ['id', 'aria-describedby', 'aria-pressed', 'aria-expanded', 'aria-haspopup', 'data-testid']) btn.removeAttribute(attr);
    btn.className = `${btn.className.replace(ROLE_CLASSES, '')} sc-button-icon scdl-btn`;
    btn.type = 'button';
    btn.title = 'Скачать';
    btn.setAttribute('aria-label', 'Скачать');
    btn.disabled = false;
    btn.querySelectorAll('.sc-button-label').forEach((n) => n.remove());
    const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach((t) => t.remove()); // like counters etc.
    const oldSvg = btn.querySelector('svg');
    if (oldSvg) oldSvg.replaceWith(arrowSvg(oldSvg));
    else btn.prepend(arrowSvg(null));
    const idle = [...btn.childNodes];

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = targetUrl(btn);
      if (!url || btn.dataset.busy) return;
      btn.dataset.busy = '1';
      setProgress(btn, '…');
      const id = crypto.randomUUID(); // registered before sending so a fast "done" can't be missed
      pending.set(id, { btn, idle });
      try {
        const r = await chrome.runtime.sendMessage({ to: 'bg', type: 'job', job: { kind: 'url', url, id } });
        if (r?.error) throw new Error(r.error);
      } catch (err) {
        pending.delete(id);
        finish(btn, idle);
        alert(`SoundCloud Downloader: ${err.message}`);
      }
    }, true);
    return btn;
  };

  const setProgress = (btn, text) => {
    btn.replaceChildren(Object.assign(document.createElement('span'), { className: 'scdl-progress', textContent: text }));
    btn.title = text;
  };
  const finish = (btn, idle) => {
    delete btn.dataset.busy;
    btn.replaceChildren(...idle);
    btn.title = 'Скачать';
  };

  // Messages reach every frame of the tab: button jobs are handled by the frame that owns the button,
  // menu (popup) jobs only by the top frame, so each result is shown once.
  chrome.runtime.onMessage.addListener((msg) => {
    const job = pending.get(msg.id);
    if (msg.type === 'scdl-progress' && job) setProgress(job.btn, msg.text);
    if (msg.type !== 'scdl-done') return;
    if (msg.fromButton ? !job : window !== window.top) return;
    if (job) finish(job.btn, job.idle);
    pending.delete(msg.id);
    if (msg.error) alert(`SoundCloud Downloader: ${msg.error}`);
    else if (msg.message) alert(msg.message);
  });

  const label = (b) => (b.getAttribute('aria-label') || b.title || '').trim();

  const scan = () => {
    ensureStyle();
    // Rows, tiles, queue, player: next to the card's Like button, or before "…" when there is no Like
    // (your own private playlists have no Like button).
    for (const anchor of document.querySelectorAll('button.sc-button-like, button.sc-button-more')) {
      const row = anchor.parentElement;
      if (!anchor.closest(CARD) || anchor.closest('.commentItem') || row.querySelector(':scope > .scdl-btn')) continue;
      if (anchor.matches('.sc-button-more') && row.querySelector(':scope > .sc-button-like')) continue; // Like path handles it
      const before = anchor.matches('.sc-button-like') ? row.querySelector(':scope > .sc-button-more') || anchor.nextElementSibling : anchor;
      row.insertBefore(makeButton(anchor), before);
    }
    // Track / playlist page header: right before Share, styled like it. The new page renders the header twice
    // (wide and narrow layouts, one hidden), so every copy gets its own button.
    // New wide: [♡] [Write a comment] [⬇] [share] … ; classic: … [repost] [⬇] [share] ….
    if (!pageItem()) return;
    for (const share of document.querySelectorAll(CLICKABLE)) {
      if (!SHARE_LABEL.test(label(share)) || share.closest(CARD) || share.closest(SKIP)) continue;
      if (share.previousElementSibling?.classList.contains('scdl-btn')) continue;
      share.before(makeButton(share));
    }
  };

  // Observe the whole document, not <body>: the new /n/ site is a React app rendered over the entire document
  // and may swap <body> after load, which would silently detach an observer bound to the old one.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }).observe(document, { childList: true, subtree: true });
  scan();
})();
