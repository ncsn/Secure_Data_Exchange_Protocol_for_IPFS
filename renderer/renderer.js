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
  } else {
    log('error', `Add failed: ${res?.error || 'unknown'}`);
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
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center">No peers connected. Use the form above to connect to a peer.</td></tr>';
    return;
  }
  for (const [id, info] of peers) {
    const tr = document.createElement('tr');
    const src = info.source || 'transport';
    const badge = src === 'transport' ? 'badge-transport' : 'badge-dht';
    tr.innerHTML = `<td>${id}</td><td>${info.address || '\u2014'}</td><td>${info.protocol || '\u2014'}</td><td><span class="badge ${badge}">${src}</span></td><td><button class="btn-disconnect-peer" data-peer-id="${id}">Disconnect</button></td>`;
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
});

window.ipfs.onPeerDisconnected(data => {
  peers.delete(data.peerId);
  document.getElementById('card-peer-count').textContent = peers.size;
  renderPeerTable();
  log('warn', `Peer disconnected: ${data.peerId}`);
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

log('info', 'IPFS Privacy Desktop ready. Click "Start Node" to begin.');
