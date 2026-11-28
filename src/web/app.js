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
  if (state.badge.paired) {
    loadOtaStatus();
  } else {
    document.getElementById('badge-ota-actions').style.display = 'none';
    document.getElementById('badge-ota-status').textContent = '';
  }
  loadSelfUpdateStatus();
}

// Nexus b1ad1a04: this app's own update check (vs. the badge firmware's,
// above) — GitHub Releases only, check-and-prompt, never a silent
// self-replace. The server caches the GitHub call for 24h regardless of
// how often this polls, so polling on the same 10s loadState() loop is
// harmless (see self-update-check.mjs).
async function loadSelfUpdateStatus() {
  const banner = document.getElementById('self-update-banner');
  try {
    const status = await api('/api/self/update-status');
    if (status.updateAvailable) {
      banner.style.display = '';
      banner.className = 'status-line warn';
      banner.innerHTML = `A new version is available: v${status.latestVersion} (you're on v${status.currentVersion}). <a href="${status.latestUrl}" target="_blank" rel="noopener">Download it</a>.`;
    } else {
      banner.style.display = 'none';
    }
  } catch {
    banner.style.display = 'none';
  }
}

function renderBadge(badge) {
  const el = document.getElementById('badge-status');
  if (badge.paired) {
    el.textContent = `Paired with ${badge.host}:${badge.port}.`;
    el.className = 'status-line ok';
    document.getElementById('badge-host').value = badge.host;
    document.getElementById('badge-port').value = badge.port;
  } else {
    el.textContent = 'Not paired yet — on the badge, open Cards and press Pair, then enter the badge’s IP and the 6-digit code shown here.';
    el.className = 'status-line warn';
  }
}

// Nexus ad98fbf6: the badge's own OTA status (current version, plus
// whatever its OtaWorker last found during its 6h background check or an
// explicit "Check for update" click below), re-fetched every loadState()
// tick (same 10s loop below) once the badge is paired.
async function loadOtaStatus() {
  const statusEl = document.getElementById('badge-ota-status');
  const actionsEl = document.getElementById('badge-ota-actions');
  const updateBtn = document.getElementById('ota-update-btn');
  try {
    const status = await api('/api/badge/ota-status');
    actionsEl.style.display = '';
    if (status.availableVersion) {
      statusEl.textContent = `Firmware v${status.currentVersion} — update available: v${status.availableVersion}.`;
      statusEl.className = 'status-line warn';
      updateBtn.textContent = `Update now (v${status.availableVersion})`;
      updateBtn.style.display = '';
    } else if (status.checking) {
      statusEl.textContent = `Firmware v${status.currentVersion} — checking for updates…`;
      statusEl.className = 'status-line';
      updateBtn.style.display = 'none';
    } else {
      statusEl.textContent = `Firmware v${status.currentVersion} — up to date.`;
      statusEl.className = 'status-line ok';
      updateBtn.style.display = 'none';
    }
  } catch (e) {
    // Badge briefly unreachable (asleep, rebooting, off Wi-Fi) shouldn't
    // nuke the rest of the page — just go quiet about OTA until it
    // answers again on the next loadState() tick.
    actionsEl.style.display = 'none';
    statusEl.textContent = '';
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

function missingRequiredCredential(feed) {
  return feed.credentialsSchema.some((cred) => cred.required && !feed.credentials[cred.account]);
}

function pillFor(feed) {
  if (!feed.config.enabled) return { text: 'off', cls: 'off' };
  // A feed that only lacks its key can't have succeeded yet either, so this
  // takes priority over the error pill below — the fix is "add a key", not
  // "something's broken".
  if (missingRequiredCredential(feed)) return { text: 'needs key', cls: 'warn' };
  if (feed.status.lastError) return { text: 'error', cls: 'err' };
  if (feed.status.lastSuccess) return { text: 'ok', cls: 'ok' };
  return { text: 'pending', cls: 'off' };
}

// One input per configured symbol, not one comma-list field — editing a
// slot's value replaces that slot (one API call with the full rejoined
// list), it never appends. A second tile only shows up after an explicit
// "+ Add" click (Nexus 281ee5a2: Kevin typed a new symbol expecting it to
// change the built-in tile and got a second one instead).
function renderSymbolListSetting(feed, setting) {
  const wrap = document.createElement('div');
  wrap.className = 'symbol-list';

  const raw = feed.config.settings?.[setting.key] ?? setting.default ?? '';
  const symbols = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (symbols.length === 0) symbols.push('');
  const max = setting.max || 3;

  async function save(nextSymbols) {
    const cleaned = nextSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
    await api(`/api/feeds/${feed.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { [setting.key]: cleaned.join(',') } }),
    });
    loadState();
  }

  const label = document.createElement('div');
  label.textContent = setting.label;
  wrap.appendChild(label);

  symbols.forEach((sym, i) => {
    const slotRow = document.createElement('div');
    slotRow.className = 'row';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = sym;
    input.placeholder = i === 0 ? 'e.g. AAPL' : 'another symbol';
    input.dataset.role = 'symbol-slot';
    input.addEventListener('change', () => {
      const next = [...symbols];
      next[i] = input.value;
      save(next);
    });
    slotRow.appendChild(input);
    if (symbols.length > 1) {
      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        const next = symbols.filter((_, j) => j !== i);
        save(next.length ? next : ['']);
      });
      slotRow.appendChild(removeBtn);
    }
    wrap.appendChild(slotRow);
  });

  if (symbols.filter(Boolean).length < max) {
    const addRow = document.createElement('div');
    addRow.className = 'row';
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add another symbol';
    addBtn.addEventListener('click', () => {
      // Insert one blank slot locally — nothing is saved (so no tile is
      // added) until the buyer actually types a symbol into it.
      const slotRow = document.createElement('div');
      slotRow.className = 'row';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'another symbol';
      input.addEventListener('change', () => {
        const current = String(feed.config.settings?.[setting.key] ?? setting.default ?? '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        save([...current, input.value]);
      });
      slotRow.appendChild(input);
      wrap.insertBefore(slotRow, addRow);
      addRow.remove();
    });
    addRow.appendChild(addBtn);
    wrap.appendChild(addRow);
  }

  return wrap;
}

function renderFeed(feed, sortedFeeds, index) {
  const div = document.createElement('div');
  div.className = 'feed';
  const pill = pillFor(feed);
  // Auto-expand anything that needs the buyer's attention — a collapsed row
  // is exactly how "add one on the Feeds page" ends up pointing at nothing
  // visible (Nexus 31f026ef). Healthy/off feeds stay collapsed by default.
  if (pill.cls === 'err' || pill.cls === 'warn') div.classList.add('open');

  const head = document.createElement('div');
  head.className = 'feed-head';
  head.innerHTML = `
    <div class="order-btns">
      <button data-role="move-up" title="Move up in display order" ${index === 0 ? 'disabled' : ''}>&uarr;</button>
      <button data-role="move-down" title="Move down in display order" ${index === sortedFeeds.length - 1 ? 'disabled' : ''}>&darr;</button>
    </div>
    <div>
      <span class="chevron">&#9656;</span>
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
  statusLine.classList.add(pill.cls === 'warn' ? 'warn' : feed.status.lastError ? 'err' : 'ok');

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
    if (setting.type === 'stock-symbols') {
      body.appendChild(renderSymbolListSetting(feed, setting));
      continue;
    }
    const row = document.createElement('div');
    row.className = 'row';
    const val = feed.config.settings?.[setting.key] ?? setting.default ?? '';
    row.innerHTML = `<label>${setting.label} <input type="text" value="${val}" data-key="${setting.key}"></label>`;
    row.querySelector('input').addEventListener('change', async (e) => {
      await api(`/api/feeds/${feed.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { [setting.key]: e.target.value } }) });
    });
    body.appendChild(row);
  }

  for (const cred of feed.credentialsSchema) {
    const account = cred.account;
    const row = document.createElement('div');
    row.className = 'row';
    const have = feed.credentials[account];
    const label = cred.label || account;
    const helpLink = cred.helpUrl
      ? ` — <a href="${cred.helpUrl}" target="_blank" rel="noopener">get a key</a>`
      : '';
    row.innerHTML = `
      <label>${label}${helpLink} <input type="password" placeholder="${have ? 'stored — enter a new value to replace' : 'paste key here'}" data-account="${account}"></label>
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
  const code = document.getElementById('badge-code').value.trim();
  const resultEl = document.getElementById('pair-result');
  resultEl.textContent = 'pairing…';
  try {
    await api('/api/badge/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, port, code }) });
    resultEl.textContent = 'Paired.';
    document.getElementById('badge-code').value = ''; // one-time code — never leave it sitting in the field
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

document.getElementById('ota-check-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('badge-ota-status');
  statusEl.textContent = 'Checking for updates…';
  statusEl.className = 'status-line';
  try {
    await api('/api/badge/ota-check', { method: 'POST' });
    // Non-blocking on the badge's side — give its manifest GET a moment
    // to land before polling the result instead of racing it.
    setTimeout(loadOtaStatus, 3000);
  } catch (e) {
    statusEl.textContent = `Check failed: ${e.message}`;
    statusEl.className = 'status-line warn';
  }
});

document.getElementById('ota-update-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('badge-ota-status');
  const btn = document.getElementById('ota-update-btn');
  if (!confirm('Install this update on the badge now? It will be unusable for a minute or two while it downloads, flashes, and restarts.')) {
    return;
  }
  btn.disabled = true;
  statusEl.textContent = 'Installing — the badge screen will show progress. Waiting for it to come back on the new version (up to ~4 min)…';
  statusEl.className = 'status-line';
  try {
    const result = await api('/api/badge/ota-update', { method: 'POST' });
    statusEl.textContent = `Update installed and confirmed: badge is now running ${result.currentVersion}.`;
    statusEl.className = 'status-line ok';
  } catch (e) {
    statusEl.textContent = `Update failed: ${e.message}`;
    statusEl.className = 'status-line warn';
  } finally {
    btn.disabled = false;
    // Give a restart time to actually finish before re-polling status.
    setTimeout(loadOtaStatus, 10000);
  }
});

loadState();
setInterval(loadState, 10000);
