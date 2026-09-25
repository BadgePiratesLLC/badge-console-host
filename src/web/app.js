// Plain vanilla JS, no build step — the point is that anyone can open
// this file in a text editor and read exactly what it does.

async function api(pathname, opts) {
  const res = await fetch(pathname, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { body });
  return body;
}

function timeAgo(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function timeUntil(ms) {
  if (!ms) return '—';
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `in ${s}s`;
  return `in ${Math.round(s / 60)}m`;
}

async function loadState() {
  const state = await api('/api/state');
  renderBadge(state.badge);
  renderFeeds(state.feeds);
}

function renderBadge(badge) {
  const el = document.getElementById('badge-status');
  if (badge.paired) {
    el.textContent = `Paired with ${badge.host}:${badge.port}.`;
    el.className = 'status-line ok';
    document.getElementById('badge-host').value = badge.host;
    document.getElementById('badge-port').value = badge.port;
  } else {
    el.textContent = 'Not paired yet — enter the badge’s IP and the token shown on its Wi-Fi setup portal.';
    el.className = 'status-line warn';
  }
}

function renderFeeds(feeds) {
  const container = document.getElementById('feeds-list');
  container.innerHTML = '';
  feeds.sort((a, b) => (a.config.order || 0) - (b.config.order || 0));
  feeds.forEach((feed, i) => {
    container.appendChild(renderFeed(feed, feeds, i));
  });
}

// Display order only has meaning relative to the other feeds, so a move
// re-numbers every feed in the sorted list (0..n-1) rather than asking the
// buyer to juggle raw integers.
async function moveFeed(sortedFeeds, id, direction) {
  const idx = sortedFeeds.findIndex((f) => f.id === id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= sortedFeeds.length) return;
  const reordered = [...sortedFeeds];
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  await Promise.all(reordered.map((f, i) => api(`/api/feeds/${f.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: i }),
  })));
  loadState();
}

function pillFor(feed) {
  if (!feed.config.enabled) return { text: 'off', cls: 'off' };
  if (feed.status.lastError) return { text: 'error', cls: 'err' };
  if (feed.status.lastSuccess) return { text: 'ok', cls: 'ok' };
  return { text: 'pending', cls: 'off' };
}

function renderFeed(feed, sortedFeeds, index) {
  const div = document.createElement('div');
  div.className = 'feed';
  const pill = pillFor(feed);

  const head = document.createElement('div');
  head.className = 'feed-head';
  head.innerHTML = `
    <div class="order-btns">
      <button data-role="move-up" title="Move up in display order" ${index === 0 ? 'disabled' : ''}>&uarr;</button>
      <button data-role="move-down" title="Move down in display order" ${index === sortedFeeds.length - 1 ? 'disabled' : ''}>&darr;</button>
    </div>
    <div>
      <span class="feed-name">${feed.label}</span>
      <span class="pill ${pill.cls}">${pill.text}</span>
    </div>
    <label style="flex-direction:row;align-items:center;gap:0.4rem">
      <input type="checkbox" ${feed.config.enabled ? 'checked' : ''} data-role="enabled"> enabled
    </label>
  `;
  head.addEventListener('click', (e) => {
    if (e.target.dataset.role === 'enabled' || e.target.dataset.role === 'move-up' || e.target.dataset.role === 'move-down') return;
    div.classList.toggle('open');
  });
  head.querySelector('[data-role="enabled"]').addEventListener('change', async (e) => {
    await api(`/api/feeds/${feed.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) });
    loadState();
  });
  head.querySelector('[data-role="move-up"]').addEventListener('click', (e) => {
    e.stopPropagation();
    moveFeed(sortedFeeds, feed.id, -1);
  });
  head.querySelector('[data-role="move-down"]').addEventListener('click', (e) => {
    e.stopPropagation();
    moveFeed(sortedFeeds, feed.id, 1);
  });

  const desc = document.createElement('p');
  desc.className = 'feed-desc';
  desc.textContent = feed.description;

  const body = document.createElement('div');
  body.className = 'feed-body';

  const statusLine = document.createElement('div');
  statusLine.className = 'status-line';
  statusLine.textContent = feed.status.lastError
    ? `Last error (${timeAgo(feed.status.lastError.at)}): ${feed.status.lastError.message}`
    : `Last success: ${timeAgo(feed.status.lastSuccess)} · next poll: ${timeUntil(feed.status.nextPollAt)}`;
  statusLine.classList.add(feed.status.lastError ? 'err' : 'ok');

  const intervalRow = document.createElement('div');
  intervalRow.className = 'row';
  intervalRow.innerHTML = `
    <label>Poll interval (s)
      <input type="number" min="${feed.minIntervalSeconds}" value="${feed.config.intervalSeconds}" data-role="interval">
    </label>
    <button data-role="test">Test now</button>
  `;
  intervalRow.querySelector('[data-role="interval"]').addEventListener('change', async (e) => {
    await api(`/api/feeds/${feed.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalSeconds: Number(e.target.value) }) });
  });
  intervalRow.querySelector('[data-role="test"]').addEventListener('click', async () => {
    const btn = intervalRow.querySelector('[data-role="test"]');
    btn.disabled = true; btn.textContent = 'testing…';
    try {
      await api(`/api/feeds/${feed.id}/test`, { method: 'POST' });
    } catch { /* error is visible in the status line after reload */ }
    btn.disabled = false; btn.textContent = 'Test now';
    loadState();
  });

  body.appendChild(statusLine);
  body.appendChild(intervalRow);

  for (const setting of feed.settingsSchema) {
    const row = document.createElement('div');
    row.className = 'row';
    const val = feed.config.settings?.[setting.key] ?? setting.default ?? '';
    row.innerHTML = `<label>${setting.label} <input type="text" value="${val}" data-key="${setting.key}"></label>`;
    row.querySelector('input').addEventListener('change', async (e) => {
      await api(`/api/feeds/${feed.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { [setting.key]: e.target.value } }) });
    });
    body.appendChild(row);
  }

  for (const account of feed.needsCredentials) {
    const row = document.createElement('div');
    row.className = 'row';
    const have = feed.credentials[account];
    row.innerHTML = `
      <label>${account} <input type="password" placeholder="${have ? 'stored — enter a new value to replace' : 'paste key here'}" data-account="${account}"></label>
      <button data-role="save-cred">${have ? 'Replace' : 'Save'}</button>
      ${have ? '<button data-role="clear-cred">Clear</button>' : ''}
    `;
    row.querySelector('[data-role="save-cred"]').addEventListener('click', async () => {
      const input = row.querySelector(`[data-account="${account}"]`);
      if (!input.value) return;
      const result = await api(`/api/feeds/${feed.id}/credential`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account, value: input.value }) });
      input.value = '';
      if (result.warning) alert(result.warning);
      loadState();
    });
    const clearBtn = row.querySelector('[data-role="clear-cred"]');
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      await api(`/api/feeds/${feed.id}/credential?account=${encodeURIComponent(account)}`, { method: 'DELETE' });
      loadState();
    });
    body.appendChild(row);
  }

  div.appendChild(head);
  div.appendChild(desc);
  div.appendChild(body);
  return div;
}

document.getElementById('pair-btn').addEventListener('click', async () => {
  const host = document.getElementById('badge-host').value.trim();
  const port = Number(document.getElementById('badge-port').value) || 80;
  const token = document.getElementById('badge-token').value.trim();
  const resultEl = document.getElementById('pair-result');
  resultEl.textContent = 'pairing…';
  try {
    await api('/api/badge/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, port, token }) });
    resultEl.textContent = 'Paired.';
    loadState();
  } catch (e) {
    resultEl.textContent = `Failed: ${e.message}`;
  }
});

document.getElementById('discover-btn').addEventListener('click', async () => {
  const resultEl = document.getElementById('pair-result');
  resultEl.textContent = 'searching the local network (3s)…';
  const { results } = await api('/api/badge/discover');
  if (results.length === 0) {
    resultEl.textContent = 'No badge found via mDNS — enter its IP directly instead (firmware mDNS advertising may not be flashed yet).';
    return;
  }
  document.getElementById('badge-host').value = results[0].host;
  document.getElementById('badge-port').value = results[0].port;
  resultEl.textContent = `Found ${results[0].host}:${results[0].port} — paste the token from its portal and click Pair.`;
});

loadState();
setInterval(loadState, 10000);
