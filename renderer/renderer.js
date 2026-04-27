'use strict';

// ── Navigation ────────────────────────────────────────────────────────────────
const navItems  = document.querySelectorAll('.nav-item');
const pages     = document.querySelectorAll('.page');

navItems.forEach(item => {
  item.addEventListener('click', () => {
    navItems.forEach(n => n.classList.remove('active'));
    pages.forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`page-${item.dataset.page}`).classList.add('active');

    // Refresh peer list when navigating to the peers tab
    if (item.dataset.page === 'peers') refreshPeerList();
  });
});

// ── State ────────────────────────────────────────────────────────────────────
let nodeRunning = false;
const peers = new Map(); // peerId → { address, protocol, source }

// ── Toast Notifications ──────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<div class="toast-message">${message}</div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}

// ── Utilities ────────────────────────────────────────────────────────────────
function formatBytes(n) {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const val = n / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

let bandwidthData = new Map(); // peerId → { bytesSent, bytesReceived }

async function refreshBandwidth() {
  const bw = await window.ipfs.getBandwidthStats();
  bandwidthData.clear();
  for (const p of bw.peers) {
    bandwidthData.set(p.peerId, { bytesSent: p.bytesSent, bytesReceived: p.bytesReceived });
  }
}

// ── Node toggle ───────────────────────────────────────────────────────────────
const btnToggle  = document.getElementById('btn-toggle');
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

function setNodeState(running) {
  nodeRunning = running;
  statusDot.className  = `dot ${running ? 'running' : 'stopped'}`;
  statusText.textContent = running ? 'Running' : 'Stopped';
  btnToggle.textContent  = running ? 'Stop Node' : 'Start Node';
  btnToggle.className    = running ? 'stop-mode' : '';
}

btnToggle.addEventListener('click', async () => {
  btnToggle.disabled = true;
  if (!nodeRunning) {
    log('info', 'Starting controller node\u2026');
    const res = await window.ipfs.startController();
    if (res.ok) {
      setNodeState(true);
      log('ok', 'Controller node started.');
      refreshStatus();
      refreshPeerList();
      loadConfig();
    } else {
      log('error', `Failed to start: ${res.error}`);
    }
  } else {
    log('warn', 'Stopping controller node\u2026');
    await window.ipfs.stopController();
    setNodeState(false);
    document.getElementById('card-peer-id').textContent    = '\u2014';
    document.getElementById('card-peer-count').textContent = '0';
    document.getElementById('card-blocks').textContent     = '0';
    peers.clear();
    renderPeerTable();
  }
  btnToggle.disabled = false;
});

// ── Status polling ────────────────────────────────────────────────────────────
async function refreshStatus() {
  if (!nodeRunning) return;
  const s = await window.ipfs.getStatus();
  if (!s) return;
  if (s.peerId)      document.getElementById('card-peer-id').textContent    = s.peerId;
  if (s.peerCount !== undefined) document.getElementById('card-peer-count').textContent = s.peerCount;
  if (s.blockCount !== undefined) document.getElementById('card-blocks').textContent    = s.blockCount;
  // Update cached items count
  const items = await window.ipfs.getCachedItems();
  document.getElementById('card-cached').textContent = items.length;

  // Storage & DHT cards
  const storage = await window.ipfs.getStorageStats();
  document.getElementById('card-storage-bytes').textContent = formatBytes(storage.totalBytes);
  const dht = await window.ipfs.getDHTStats();
  document.getElementById('card-dht-peers').textContent = dht.peers;

  // Privacy health
  const privacy = await window.ipfs.getPrivacyScore();
  const dot = document.getElementById('privacy-dot');
  dot.className = `privacy-dot ${privacy.score}`;
  document.getElementById('privacy-score-text').textContent = privacy.score.charAt(0).toUpperCase() + privacy.score.slice(1);
  document.getElementById('privacy-decoys').textContent = privacy.decoysEnabled ? 'Enabled' : 'Disabled';
  document.getElementById('privacy-registry').textContent = `${privacy.registrySize} CID\u00b3s`;
  document.getElementById('privacy-peers').textContent = privacy.connectedPeers;

  // Topology (only if Dashboard is active)
  const dashActive = document.getElementById('page-dashboard').classList.contains('active');
  if (dashActive) refreshTopology();
}
setInterval(refreshStatus, 5000);

// ── Add File ──────────────────────────────────────────────────────────────────
const addPathInput = document.getElementById('add-path');
const btnBrowse    = document.getElementById('btn-browse');
const btnAdd       = document.getElementById('btn-add');
const addResult    = document.getElementById('add-result');
const dropZone     = document.getElementById('drop-zone');

// Drag-and-drop
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.path) {
    addPathInput.value = file.path;
    btnAdd.disabled = false;
  }
});
// Click drop zone to open file dialog
dropZone.addEventListener('click', async () => {
  const p = await window.ipfs.openFileDialog();
  if (p) {
    addPathInput.value = p;
    btnAdd.disabled = false;
  }
});

btnBrowse.addEventListener('click', async () => {
  const p = await window.ipfs.openFileDialog();
  if (p) {
    addPathInput.value = p;
    btnAdd.disabled = false;
  }
});

btnAdd.addEventListener('click', async () => {
  if (!nodeRunning) { log('warn', 'Start the node first.'); return; }
  const filePath = addPathInput.value.trim();
  if (!filePath) return;
  btnAdd.disabled = true;
  log('info', `Adding file: ${filePath}`);
  const res = await window.ipfs.addFile(filePath);
  btnAdd.disabled = false;
  if (res && res.ok) {
    document.getElementById('res-cid1').textContent = res.cid1;
    document.getElementById('res-cid2').textContent = res.cid2;
    document.getElementById('res-cid3').textContent = res.cid3;
    addResult.classList.remove('hidden');
    log('ok', `File added. CID\u00b3 published: ${res.cid3}`);
    showToast('File added successfully', 'success');
  } else {
    log('error', `Add failed: ${res?.error || 'unknown'}`);
    showToast(`Add failed: ${res?.error || 'unknown'}`, 'error');
  }
});

// ── CID Validation ───────────────────────────────────────────────────────────
function validateCid1Input(str) {
  str = str.trim();
  if (!str) return { valid: false, error: 'Please enter a CID.' };
  if (!str.startsWith('b')) {
    return { valid: false, error: 'CID must start with "b" (base32 encoding).' };
  }
  if (str.length < 50 || str.length > 70) {
    return { valid: false, error: `Unexpected CID length (${str.length} chars). A valid CID\u00b9 is typically ~59 characters.` };
  }
  if (!/^b[a-z2-7]+$/.test(str)) {
    return { valid: false, error: 'CID contains invalid characters. Only lowercase a-z and 2-7 are valid in base32.' };
  }
  return { valid: true };
}

function improveErrorMessage(raw) {
  if (raw.includes('No providers found')) {
    return 'Could not find this content on the network. Make sure you are using CID\u00b9 (the private CID shown when the file was added), not CID\u00b2 or CID\u00b3.';
  }
  if (raw.includes('Failed to retrieve') && raw.includes('from all providers')) {
    return 'Found providers but could not complete the download. The CID may be incorrect (e.g. CID\u00b2 or CID\u00b3 instead of CID\u00b9), or the provider may be offline.';
  }
  if (raw.includes('content hash does not match')) {
    return 'Downloaded data did not match the expected hash. This usually means the wrong CID type was used.';
  }
  if (raw.includes('Handshake failed') || raw.includes('timeout')) {
    return 'Connection to provider failed. The peer may be offline or unreachable.';
  }
  return raw;
}

// ── Get File ──────────────────────────────────────────────────────────────────
const getCidInput      = document.getElementById('get-cid');
const btnGet           = document.getElementById('btn-get');
const getResult        = document.getElementById('get-result');
const getError         = document.getElementById('get-error');
const cidDerivation    = document.getElementById('cid-derivation');
const protocolStepper  = document.getElementById('protocol-stepper');
const stepperPeer      = document.getElementById('stepper-peer');

function resetGetUI() {
  getError.textContent = '';
  getResult.classList.add('hidden');
  cidDerivation.classList.add('hidden');
  protocolStepper.classList.add('hidden');
  stepperPeer.textContent = '';
  for (let i = 1; i <= 4; i++) {
    document.getElementById(`step-${i}`).className = 'step';
  }
}

btnGet.addEventListener('click', async () => {
  resetGetUI();

  if (!nodeRunning) { getError.textContent = 'Start the node first.'; return; }

  const cid1 = getCidInput.value.trim();
  const validation = validateCid1Input(cid1);
  if (!validation.valid) {
    getError.textContent = validation.error;
    return;
  }

  btnGet.disabled = true;

  // Show CID1
  document.getElementById('get-cid1-display').textContent = cid1;
  cidDerivation.classList.remove('hidden');

  // Show stepper
  protocolStepper.classList.remove('hidden');

  log('info', `Retrieving CID\u00b9: ${cid1}`);

  const res = await window.ipfs.getFile(cid1);
  btnGet.disabled = false;

  if (res && res.ok) {
    document.getElementById('res-path').textContent     = res.savedTo;
    document.getElementById('res-verified').textContent = res.verified ? '\u2713 OK' : '\u2717 Failed';
    document.getElementById('res-verified').style.color = res.verified ? 'var(--green)' : 'var(--red)';
    getResult.classList.remove('hidden');
    log('ok', `File retrieved and saved to: ${res.savedTo}`);
    showToast('File retrieved and saved', 'success');
  } else {
    const errorMsg = improveErrorMessage(res?.error || 'unknown');
    getError.textContent = errorMsg;
    // Mark current active step as failed
    for (let i = 1; i <= 4; i++) {
      const el = document.getElementById(`step-${i}`);
      if (el.classList.contains('active')) {
        el.classList.remove('active');
        el.classList.add('failed');
      }
    }
    log('error', `Get failed: ${errorMsg}`);
  }
});

// ── Peers ─────────────────────────────────────────────────────────────────────
function renderPeerTable() {
  const tbody = document.getElementById('peer-tbody');
  tbody.innerHTML = '';
  if (peers.size === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);text-align:center">No peers connected. Use the form above to connect to a peer.</td></tr>';
    return;
  }
  for (const [id, info] of peers) {
    const tr = document.createElement('tr');
    const src = info.source || 'transport';
    const badge = src === 'transport' ? 'badge-transport' : 'badge-dht';
    const bw = bandwidthData.get(id);
    const sent = bw ? formatBytes(bw.bytesSent) : '\u2014';
    const recv = bw ? formatBytes(bw.bytesReceived) : '\u2014';
    tr.innerHTML = `<td>${id}</td><td>${info.address || '\u2014'}</td><td>${info.protocol || '\u2014'}</td><td><span class="badge ${badge}">${src}</span></td><td>${sent}</td><td>${recv}</td><td><button class="btn-disconnect-peer" data-peer-id="${id}">Disconnect</button></td>`;
    tbody.appendChild(tr);
  }
}

async function refreshPeerList() {
  if (!nodeRunning) return;
  const list = await window.ipfs.getPeers();
  peers.clear();
  for (const p of list) {
    peers.set(p.peerId, { address: p.address, protocol: p.protocol, source: p.source });
  }
  document.getElementById('card-peer-count').textContent = peers.size;
  await refreshBandwidth();
  renderPeerTable();
}

// Connect to peer
const btnConnectPeer  = document.getElementById('btn-connect-peer');
const btnRefreshPeers = document.getElementById('btn-refresh-peers');
const connectError    = document.getElementById('connect-error');

btnConnectPeer.addEventListener('click', async () => {
  connectError.textContent = '';
  if (!nodeRunning) { connectError.textContent = 'Start the node first.'; return; }
  const ip   = document.getElementById('connect-ip').value.trim();
  const port = document.getElementById('connect-port').value.trim();
  if (!ip || !port) { connectError.textContent = 'Enter both IP and port.'; return; }
  btnConnectPeer.disabled = true;
  log('info', `Connecting to ${ip}:${port}\u2026`);
  const res = await window.ipfs.connectToPeer(ip, port);
  btnConnectPeer.disabled = false;
  if (res && res.ok) {
    await refreshPeerList();
  } else {
    connectError.textContent = `Connection failed: ${res?.error || 'unknown'}`;
    log('error', `Connect failed: ${res?.error || 'unknown'}`);
  }
});

btnRefreshPeers.addEventListener('click', () => refreshPeerList());

// Disconnect peer (event delegation)
document.getElementById('peer-table').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-disconnect-peer')) return;
  const peerId = e.target.dataset.peerId;
  e.target.disabled = true;
  const res = await window.ipfs.disconnectPeer(peerId);
  if (res && res.ok) {
    peers.delete(peerId);
    document.getElementById('card-peer-count').textContent = peers.size;
    renderPeerTable();
    log('info', `Disconnected peer: ${peerId.slice(0, 16)}\u2026`);
  } else {
    log('error', `Disconnect failed: ${res?.error || 'unknown'}`);
    e.target.disabled = false;
  }
});

window.ipfs.onPeerConnected(data => {
  peers.set(data.peerId, { address: data.address, protocol: data.protocol || '/triple-hash/1.0.0', source: 'transport' });
  document.getElementById('card-peer-count').textContent = peers.size;
  renderPeerTable();
  log('ok', `Peer connected: ${data.peerId}`);
  showToast(`Peer connected: ${data.peerId.slice(0, 16)}\u2026`, 'success');
  if (document.getElementById('page-dashboard').classList.contains('active')) refreshTopology();
});

window.ipfs.onPeerDisconnected(data => {
  peers.delete(data.peerId);
  document.getElementById('card-peer-count').textContent = peers.size;
  renderPeerTable();
  log('warn', `Peer disconnected: ${data.peerId}`);
  showToast('Peer disconnected', 'warning');
  if (document.getElementById('page-dashboard').classList.contains('active')) refreshTopology();
});

window.ipfs.onTransferUpdate(data => {
  if (data.type === 'derivation') {
    log('info', 'CID\u00b3 derived internally for DHT lookup');
    return;
  }

  if (data.type === 'search') {
    document.getElementById('step-1').classList.add('active');
    log('info', data.message);
    return;
  }

  if (data.type === 'handshake') {
    const step = data.step;

    // Show peer info
    if (data.peerId && stepperPeer) {
      stepperPeer.textContent = `Peer B: ${data.peerId.slice(0, 16)}\u2026`;
    }

    // Mark previous steps as completed, current as active
    for (let i = 1; i < step; i++) {
      const el = document.getElementById(`step-${i}`);
      el.classList.remove('active');
      el.classList.add('completed');
    }
    const currentEl = document.getElementById(`step-${step}`);
    currentEl.classList.remove('completed');
    currentEl.classList.add('active');

    log('info', `Step ${step}/${data.total}: ${data.message}`);
    return;
  }

  if (data.type === 'complete') {
    for (let i = 1; i <= 4; i++) {
      const el = document.getElementById(`step-${i}`);
      el.classList.remove('active');
      el.classList.add('completed');
    }
    log('ok', 'Protocol complete \u2014 file retrieved and verified');
    return;
  }

  if (data.type === 'error') {
    return; // error handling is done in the getFile callback
  }

  // Fallback for unstructured messages
  if (data.message) log('info', data.message);
});

window.ipfs.onControllerEvent(data => {
  log(data.level || 'info', data.message);
  if (data.level === 'error') showToast(data.message, 'error');
});

// ── Cache ────────────────────────────────────────────────────────────────────
const cacheCid3Input   = document.getElementById('cache-cid3');
const cachePeerSelect  = document.getElementById('cache-peer-select');
const btnCache         = document.getElementById('btn-cache');
const cacheError       = document.getElementById('cache-error');
const cacheResult      = document.getElementById('cache-result');
const btnRefreshCache  = document.getElementById('btn-refresh-cache');

// Populate peer dropdown from connected peers
async function refreshCachePeerDropdown() {
  if (!nodeRunning) return;
  const list = await window.ipfs.getPeers();
  cachePeerSelect.innerHTML = '<option value="">Select peer\u2026</option>';
  for (const p of list) {
    if (p.source !== 'transport') continue; // only directly connected peers
    const opt = document.createElement('option');
    opt.value = p.peerId;
    opt.textContent = `${p.peerId.slice(0, 16)}\u2026 (${p.address})`;
    cachePeerSelect.appendChild(opt);
  }
}

btnCache.addEventListener('click', async () => {
  cacheError.textContent = '';
  cacheResult.classList.add('hidden');

  if (!nodeRunning) { cacheError.textContent = 'Start the node first.'; return; }

  const cid3 = cacheCid3Input.value.trim();
  if (!cid3) { cacheError.textContent = 'Enter a CID\u00b3.'; return; }
  if (!cid3.startsWith('b')) { cacheError.textContent = 'CID\u00b3 must start with "b" (base32).'; return; }

  const peerId = cachePeerSelect.value;
  if (!peerId) { cacheError.textContent = 'Select a connected peer.'; return; }

  btnCache.disabled = true;
  log('info', `Caching CID\u00b3 from peer ${peerId.slice(0, 12)}\u2026`);

  const res = await window.ipfs.cacheFromPeer(cid3, peerId);
  btnCache.disabled = false;

  if (res && res.ok) {
    cacheResult.classList.remove('hidden');
    log('ok', `Cached CID\u00b3: ${cid3.slice(0, 24)}\u2026`);
    showToast('Cached successfully', 'success');
    refreshCacheTable();
  } else {
    cacheError.textContent = `Cache failed: ${res?.error || 'unknown'}`;
    log('error', `Cache failed: ${res?.error || 'unknown'}`);
  }
});

// Cached items table
async function refreshCacheTable() {
  const tbody = document.getElementById('cache-tbody');
  tbody.innerHTML = '';

  if (!nodeRunning) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted);text-align:center">Node not running</td></tr>';
    return;
  }

  const items = await window.ipfs.getCachedItems();
  document.getElementById('card-cached').textContent = items.length;

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted);text-align:center">No cached items</td></tr>';
    return;
  }

  for (const item of items) {
    const tr = document.createElement('tr');
    const ts = item.timestamp ? new Date(item.timestamp).toLocaleString() : '\u2014';
    tr.innerHTML = `<td class="mono" style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${item.cid3}</td><td>${ts}</td><td><button class="btn-remove-cache" data-cid3="${item.cid3}">Remove</button></td>`;
    tbody.appendChild(tr);
  }
}

// Remove cached item (event delegation)
document.getElementById('cache-table').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-remove-cache')) return;
  const cid3 = e.target.dataset.cid3;
  await window.ipfs.removeCached(cid3);
  refreshCacheTable();
});

btnRefreshCache.addEventListener('click', () => {
  refreshCacheTable();
  refreshCachePeerDropdown();
});

// Refresh peer dropdown when navigating to cache tab
navItems.forEach(item => {
  if (item.dataset.page === 'cache') {
    item.addEventListener('click', () => {
      refreshCachePeerDropdown();
      refreshCacheTable();
    });
  }
});

// ── Copy buttons (event delegation) ──────────────────────────────────────────
document.addEventListener('click', (e) => {
  if (!e.target.classList.contains('btn-copy')) return;
  const targetId = e.target.dataset.target;
  const el = document.getElementById(targetId);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const orig = e.target.textContent;
    e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = orig; }, 1500);
  });
});

// ── Log ───────────────────────────────────────────────────────────────────────
const logOutput = document.getElementById('log-output');

function log(level, message) {
  const ts   = new Date().toLocaleTimeString();
  const span = document.createElement('span');
  span.className = `log-${level}`;
  span.textContent = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}\n`;
  logOutput.appendChild(span);
  // Auto-scroll if near bottom
  const c = document.getElementById('log-container');
  if (c.scrollHeight - c.scrollTop < c.clientHeight + 80) {
    c.scrollTop = c.scrollHeight;
  }
}

document.getElementById('btn-clear-log').addEventListener('click', () => {
  logOutput.innerHTML = '';
});

// ── Decoy toggle ────────────────────────────────────────────────────────────
const decoyToggle = document.getElementById('setting-decoys');
if (decoyToggle) {
  decoyToggle.addEventListener('change', () => {
    window.ipfs.setDecoysEnabled(decoyToggle.checked);
    log('info', `Decoy requests ${decoyToggle.checked ? 'enabled' : 'disabled'}`);
  });
}

// ── Manual decoy button ─────────────────────────────────────────────────────
const btnSendDecoy = document.getElementById('btn-send-decoy');
if (btnSendDecoy) {
  btnSendDecoy.addEventListener('click', async () => {
    if (!nodeRunning) { log('warn', 'Start the node first.'); return; }
    btnSendDecoy.disabled = true;
    log('info', 'Sending manual decoy request\u2026');
    const res = await window.ipfs.sendDecoy();
    btnSendDecoy.disabled = false;
    if (res && res.ok) {
      log('ok', 'Decoy request completed successfully (response discarded).');
    } else {
      log('warn', `Decoy: ${res?.error || 'no eligible targets (need connected peers + known CID\u00b3s in registry)'}`);
    }
  });
}

// ── DHT ─────────────────────────────────────────────────────────────────────
let dhtInterval = null;

async function refreshDHT() {
  if (!nodeRunning) return;

  // Stats cards
  const stats = await window.ipfs.getDHTStats();
  document.getElementById('dht-card-peers').textContent       = stats.peers;
  document.getElementById('dht-card-providers').textContent   = stats.providers;
  document.getElementById('dht-card-registry').textContent    = stats.registry;
  document.getElementById('dht-card-connections').textContent = stats.connections;
  document.getElementById('dht-card-kbucket').textContent     = stats.kBucketSize;

  // K-Buckets table
  const buckets = await window.ipfs.getDHTBuckets();
  const bucketsTbody = document.getElementById('dht-buckets-tbody');
  bucketsTbody.innerHTML = '';

  if (buckets.length === 0) {
    bucketsTbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center">No peers in routing table</td></tr>';
  } else {
    for (const b of buckets) {
      // Main row
      const tr = document.createElement('tr');
      tr.className = 'bucket-row';
      tr.dataset.bucket = b.index;
      tr.innerHTML = `<td>${b.index}</td><td class="mono">${b.index}-bit</td><td>${b.peers.length}</td><td class="bucket-toggle">\u25B6</td>`;
      bucketsTbody.appendChild(tr);

      // Detail row (hidden)
      const detailTr = document.createElement('tr');
      detailTr.className = 'bucket-peers';
      const detailTd = document.createElement('td');
      detailTd.colSpan = 4;
      let html = '<div class="bucket-peers-inner">';
      for (const p of b.peers) {
        const ago = p.lastSeen ? formatAgo(p.lastSeen) : '\u2014';
        html += `<div class="bucket-peer-entry"><span class="mono">${p.peerId.slice(0, 24)}\u2026</span><span>${p.ip}:${p.port}</span><span class="muted">seen ${ago}</span></div>`;
      }
      html += '</div>';
      detailTd.innerHTML = html;
      detailTr.appendChild(detailTd);
      bucketsTbody.appendChild(detailTr);
    }
  }

  // Provider Records + CID Registry
  const { providers, registry } = await window.ipfs.getDHTProviders();

  const provTbody = document.getElementById('dht-providers-tbody');
  provTbody.innerHTML = '';
  if (providers.length === 0) {
    provTbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted);text-align:center">No provider records</td></tr>';
  } else {
    for (const pr of providers) {
      const tr = document.createElement('tr');
      const peerList = pr.peers.map(p => `${p.peerId.slice(0, 12)}\u2026`).join(', ');
      tr.innerHTML = `<td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${pr.cid}</td><td>${pr.peers.length} peer${pr.peers.length !== 1 ? 's' : ''}</td><td class="mono" style="font-size:11px">${peerList}</td>`;
      provTbody.appendChild(tr);
    }
  }

  const regTbody = document.getElementById('dht-registry-tbody');
  regTbody.innerHTML = '';
  if (registry.length === 0) {
    regTbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted);text-align:center">No CID\u00b3 entries in registry</td></tr>';
  } else {
    for (const r of registry) {
      const tr = document.createElement('tr');
      const selfBadge = r.selfOwned ? '<span class="badge badge-self">SELF</span>' : '';
      tr.innerHTML = `<td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${r.cid3}</td><td>${r.peers.length} ${selfBadge}</td><td>${r.selfOwned ? 'Yes' : 'No'}</td>`;
      regTbody.appendChild(tr);
    }
  }
}

function formatAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// Bucket row toggle (event delegation)
document.getElementById('dht-buckets-tbody').addEventListener('click', (e) => {
  const row = e.target.closest('.bucket-row');
  if (!row) return;
  row.classList.toggle('open');
});

// DHT tab auto-refresh on navigation
navItems.forEach(item => {
  if (item.dataset.page === 'dht') {
    item.addEventListener('click', () => {
      refreshDHT();
      // Start 5s interval while DHT tab is active
      if (dhtInterval) clearInterval(dhtInterval);
      dhtInterval = setInterval(refreshDHT, 5000);
    });
  } else {
    item.addEventListener('click', () => {
      // Stop DHT polling when leaving the tab
      if (dhtInterval) { clearInterval(dhtInterval); dhtInterval = null; }
    });
  }
});

// DHT Lookup tool
const btnDhtLookup  = document.getElementById('btn-dht-lookup');
const dhtLookupCid  = document.getElementById('dht-lookup-cid');
const dhtLookupErr  = document.getElementById('dht-lookup-error');
const dhtLookupRes  = document.getElementById('dht-lookup-results');

btnDhtLookup.addEventListener('click', async () => {
  dhtLookupErr.textContent = '';
  dhtLookupRes.classList.add('hidden');
  dhtLookupRes.innerHTML = '';

  if (!nodeRunning) { dhtLookupErr.textContent = 'Start the node first.'; return; }

  const cid = dhtLookupCid.value.trim();
  if (!cid) { dhtLookupErr.textContent = 'Enter a CID.'; return; }

  btnDhtLookup.disabled = true;
  log('info', `DHT lookup: ${cid.slice(0, 24)}\u2026`);

  const res = await window.ipfs.dhtLookup(cid);
  btnDhtLookup.disabled = false;

  if (res && res.ok) {
    dhtLookupRes.classList.remove('hidden');
    if (res.providers.length === 0) {
      dhtLookupRes.innerHTML = '<div style="color:var(--muted)">No providers found for this CID.</div>';
    } else {
      let html = `<div style="margin-bottom:8px;font-weight:600">Found ${res.providers.length} provider${res.providers.length !== 1 ? 's' : ''}:</div>`;
      for (const p of res.providers) {
        html += `<div class="mono" style="font-size:12px;margin:4px 0">${p.peerId.slice(0, 24)}\u2026 \u2014 ${p.ip}:${p.port}</div>`;
      }
      dhtLookupRes.innerHTML = html;
    }
    log('ok', `DHT lookup: found ${res.providers.length} provider(s)`);
  } else {
    dhtLookupErr.textContent = res?.error || 'Lookup failed';
    log('error', `DHT lookup failed: ${res?.error || 'unknown'}`);
  }
});

// ── Storage ──────────────────────────────────────────────────────────────────
async function refreshStorageStats() {
  if (!nodeRunning) return;
  const stats = await window.ipfs.getStorageStats();
  document.getElementById('storage-card-blocks').textContent = stats.blockCount;
  document.getElementById('storage-card-bytes').textContent  = formatBytes(stats.totalBytes);
  document.getElementById('storage-card-pinned').textContent = stats.pinnedCount;
  // Usage bar (cap at 1GB for visual)
  const pct = Math.min(100, (stats.totalBytes / (1024 * 1024 * 1024)) * 100);
  document.getElementById('storage-usage-fill').style.width = `${pct}%`;
  document.getElementById('storage-usage-label').textContent = `${formatBytes(stats.totalBytes)} used`;
}

async function refreshStorageTable() {
  const tbody = document.getElementById('storage-tbody');
  tbody.innerHTML = '';
  if (!nodeRunning) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center">Node not running</td></tr>';
    return;
  }
  const blocks = await window.ipfs.getBlocks();
  if (blocks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center">No blocks in storage</td></tr>';
    return;
  }
  for (const b of blocks) {
    const tr = document.createElement('tr');
    const pinBadge = b.pinType
      ? `<span class="badge badge-${b.pinType}">${b.pinType}</span>`
      : '<span style="color:var(--muted)">unpinned</span>';
    let actions = '';
    if (b.pinType) {
      actions += `<button class="btn-unpin-block" data-cid="${b.cid}">Unpin</button>`;
    } else {
      actions += `<button class="btn-pin-block" data-cid="${b.cid}" data-type="direct">Pin</button>`;
    }
    actions += `<button class="btn-delete-block" data-cid="${b.cid}">Delete</button>`;
    tr.innerHTML = `<td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${b.cid}</td><td>${formatBytes(b.size)}</td><td>${pinBadge}</td><td>${actions}</td>`;
    tbody.appendChild(tr);
  }
}

// Storage event delegation
document.getElementById('storage-table').addEventListener('click', async (e) => {
  const target = e.target;
  if (target.classList.contains('btn-pin-block')) {
    const cid = target.dataset.cid;
    const type = target.dataset.type || 'direct';
    target.disabled = true;
    const res = await window.ipfs.pinBlock(cid, type);
    if (res.ok) { showToast('Block pinned', 'success'); }
    else { showToast(res.error, 'error'); }
    refreshStorageTable(); refreshStorageStats();
  }
  if (target.classList.contains('btn-unpin-block')) {
    const cid = target.dataset.cid;
    target.disabled = true;
    const res = await window.ipfs.unpinBlock(cid);
    if (res.ok) { showToast('Block unpinned', 'info'); }
    else { showToast(res.error, 'error'); }
    refreshStorageTable(); refreshStorageStats();
  }
  if (target.classList.contains('btn-delete-block')) {
    const cid = target.dataset.cid;
    target.disabled = true;
    const res = await window.ipfs.deleteBlock(cid);
    if (res.ok) { showToast('Block deleted', 'warning'); }
    else { showToast(res.error, 'error'); }
    refreshStorageTable(); refreshStorageStats();
  }
});

document.getElementById('btn-run-gc').addEventListener('click', async () => {
  if (!nodeRunning) { log('warn', 'Start the node first.'); return; }
  const btn = document.getElementById('btn-run-gc');
  btn.disabled = true;
  const res = await window.ipfs.runGC();
  btn.disabled = false;
  const gcResult = document.getElementById('gc-result');
  if (res.ok) {
    gcResult.style.color = 'var(--green)';
    gcResult.textContent = `GC complete: ${res.deleted.length} block(s) removed`;
    showToast(`GC: ${res.deleted.length} block(s) removed`, 'success');
    refreshStorageTable(); refreshStorageStats();
  } else {
    gcResult.style.color = '';
    gcResult.textContent = res.error;
  }
});

document.getElementById('btn-refresh-storage').addEventListener('click', () => {
  refreshStorageStats();
  refreshStorageTable();
});

// Storage tab nav hook
navItems.forEach(item => {
  if (item.dataset.page === 'storage') {
    item.addEventListener('click', () => { refreshStorageStats(); refreshStorageTable(); });
  }
});

// ── Network Topology ─────────────────────────────────────────────────────────
let topoNodes = [];

function drawTopology(peerList) {
  const canvas = document.getElementById('topology-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = 400 * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = 400;
  const cx = W / 2;
  const cy = H / 2;
  ctx.clearRect(0, 0, W, H);

  const transportPeers = peerList.filter(p => p.source === 'transport');
  const dhtPeers = peerList.filter(p => p.source === 'dht');
  topoNodes = [];

  // Self node at center
  topoNodes.push({ id: 'self', label: 'You', x: cx, y: cy, type: 'self' });

  // Transport peers in inner ring
  const innerR = Math.min(W, H) * 0.28;
  transportPeers.forEach((p, i) => {
    const angle = (2 * Math.PI * i) / (transportPeers.length || 1) - Math.PI / 2;
    topoNodes.push({
      id: p.peerId, label: p.peerId.slice(0, 8) + '\u2026',
      x: cx + innerR * Math.cos(angle), y: cy + innerR * Math.sin(angle),
      type: 'transport',
    });
  });

  // DHT-only peers in outer ring
  const outerR = Math.min(W, H) * 0.42;
  dhtPeers.forEach((p, i) => {
    const angle = (2 * Math.PI * i) / (dhtPeers.length || 1) - Math.PI / 2;
    topoNodes.push({
      id: p.peerId, label: p.peerId.slice(0, 8) + '\u2026',
      x: cx + outerR * Math.cos(angle), y: cy + outerR * Math.sin(angle),
      type: 'dht',
    });
  });

  // Draw edges
  for (const n of topoNodes) {
    if (n.type === 'self') continue;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(n.x, n.y);
    if (n.type === 'transport') {
      ctx.strokeStyle = '#3ecf8e';
      ctx.setLineDash([]);
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = '#4f9eff';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Draw nodes
  for (const n of topoNodes) {
    const r = n.type === 'self' ? 18 : 12;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = n.type === 'self' ? '#4f9eff' : n.type === 'transport' ? '#3ecf8e' : '#7b5ea7';
    ctx.fill();
    ctx.strokeStyle = '#2a3148';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(n.label, n.x, n.y + r + 14);
  }

  // Legend
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  const lx = 12, ly = H - 36;
  ctx.fillStyle = '#3ecf8e'; ctx.fillRect(lx, ly, 10, 10);
  ctx.fillStyle = '#8892a4'; ctx.fillText('Transport', lx + 14, ly + 9);
  ctx.fillStyle = '#4f9eff'; ctx.fillRect(lx, ly + 16, 10, 10);
  ctx.fillStyle = '#8892a4'; ctx.fillText('DHT', lx + 14, ly + 25);
}

// Tooltip
const topoCanvas = document.getElementById('topology-canvas');
const topoTip = document.getElementById('topo-tooltip');
if (topoCanvas) {
  topoCanvas.addEventListener('mousemove', (e) => {
    const rect = topoCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let found = null;
    for (const n of topoNodes) {
      const dx = mx - n.x, dy = my - n.y;
      if (Math.sqrt(dx * dx + dy * dy) < 16) { found = n; break; }
    }
    if (found && found.type !== 'self') {
      topoTip.textContent = found.id;
      topoTip.style.left = `${mx + 16}px`;
      topoTip.style.top = `${my - 10}px`;
      topoTip.classList.remove('hidden');
    } else {
      topoTip.classList.add('hidden');
    }
  });
  topoCanvas.addEventListener('mouseleave', () => topoTip.classList.add('hidden'));
}

async function refreshTopology() {
  if (!nodeRunning) return;
  const peerList = await window.ipfs.getPeers();
  drawTopology(peerList);
}

window.addEventListener('resize', () => {
  if (document.getElementById('page-dashboard').classList.contains('active')) refreshTopology();
});

// ── Bootstrap Peers ──────────────────────────────────────────────────────────
async function refreshBootstrapList() {
  const list = await window.ipfs.getBootstrapPeers();
  const container = document.getElementById('bootstrap-list');
  container.innerHTML = '';
  if (list.length === 0) {
    container.innerHTML = '<div style="color:var(--muted);font-size:12px">No bootstrap peers saved</div>';
    return;
  }
  for (const addr of list) {
    const entry = document.createElement('div');
    entry.className = 'bootstrap-entry';
    entry.innerHTML = `<span>${addr}</span><button class="btn-remove-bootstrap" data-addr="${addr}">Remove</button>`;
    container.appendChild(entry);
  }
}

document.getElementById('btn-add-bootstrap').addEventListener('click', async () => {
  const input = document.getElementById('bootstrap-address');
  const error = document.getElementById('bootstrap-error');
  error.textContent = '';
  const addr = input.value.trim();
  if (!addr) { error.textContent = 'Enter an address.'; return; }
  const res = await window.ipfs.addBootstrapPeer(addr);
  if (res.ok) {
    input.value = '';
    showToast(`Bootstrap peer added: ${addr}`, 'success');
    refreshBootstrapList();
  } else {
    error.textContent = res.error;
  }
});

document.getElementById('bootstrap-list').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-remove-bootstrap')) return;
  const addr = e.target.dataset.addr;
  await window.ipfs.removeBootstrapPeer(addr);
  showToast('Bootstrap peer removed', 'warning');
  refreshBootstrapList();
});

// Bootstrap refresh on Settings tab
navItems.forEach(item => {
  if (item.dataset.page === 'settings') {
    item.addEventListener('click', () => refreshBootstrapList());
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
renderPeerTable();

// Populate settings with real config
async function loadConfig() {
  const cfg = await window.ipfs.getConfig();
  if (cfg.dataDir)     document.getElementById('setting-data-dir').value     = cfg.dataDir;
  if (cfg.downloadDir) document.getElementById('setting-download-dir').value = cfg.downloadDir;
  if (cfg.listenPort)  document.getElementById('setting-port').value         = cfg.listenPort;
  if (cfg.announceIp)  document.getElementById('setting-announce-ip').value  = cfg.announceIp;
}
loadConfig();
refreshBootstrapList();

log('info', 'IPFS Privacy Desktop ready. Click "Start Node" to begin.');
