'use strict';

/**
 * controller.js — Electron main process ↔ IPFS Node bridge
 *
 * Wraps the existing Node class (from src/node/node.js) and exposes
 * a simple async API that ipcMain handlers can call directly.
 *
 * Event forwarding:
 *   The `start()` call receives an `emit` callback:
 *     emit('controller:event', { level, message })
 *     emit('peer:connected',   { peerId, address, protocol })
 *     emit('peer:disconnected',{ peerId })
 *     emit('transfer:update',  { message })
 *   These map 1:1 to the channels in preload.js.
 *
 * NOTE: src/ modules use ES Module syntax (import/export).
 *       Because this file is CommonJS (package.json has no "type":"module"),
 *       we use a dynamic import() to load them.
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { pathToFileURL } = require('url');

// ── ESM module URLs (resolved relative to this .cjs file) ───────────────────
const SRC        = path.join(__dirname, '..', 'src');
const NODE_URL   = pathToFileURL(path.join(SRC, 'node',  'node.js')).href;
const CID_URL    = pathToFileURL(path.join(SRC, 'cid',   'cid.js')).href;
const CRYPTO_URL = pathToFileURL(path.join(SRC, 'cid',   'crypto.js')).href;

// ── State ────────────────────────────────────────────────────────────────────

let node  = null;   // Node instance
let emit  = null;   // event forwarder → renderer
let _Node = null;   // lazy-loaded Node class

// ── Lazy ESM loader ──────────────────────────────────────────────────────────

async function loadNodeClass() {
  if (_Node) return _Node;
  const mod = await import(NODE_URL);
  _Node = mod.Node;
  return _Node;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * start(emitFn) → void
 *
 * Starts the IPFS privacy node.
 * @param {Function} emitFn  — (channel, data) → void, provided by main.js
 */
async function start(emitFn) {
  if (node) throw new Error('Node already running');
  emit = emitFn;

  const NodeClass = await loadNodeClass();

  const dataDir = path.join(os.homedir(), '.ipfs-desktop-privacy', 'blocks');
  fs.mkdirSync(dataDir, { recursive: true });

  node = new NodeClass({
    dataDir,
    host:       '0.0.0.0',
    announceIp: '127.0.0.1',
    listenPort: 0,
  });

  // ── Wire node events → renderer ──────────────────────────────────────────

  // Transport: new connection
  node.transport.on('connection', (conn) => {
    const peerId = (conn.remotePeer && conn.remotePeer.id) || 'unknown';
    _emit('peer:connected', {
      peerId,
      address:  `${conn.remoteIp || '?'}:${conn.remotePort || '?'}`,
      protocol: '/triple-hash/1.0.0',
    });
    conn.on('close', () => {
      _emit('peer:disconnected', { peerId });
    });
  });

  // Bitswap: handshake progress
  node.bitswap.on('handshake:step', (data) => {
    _emit('transfer:update', {
      type:    'handshake',
      step:    data.step,
      total:   data.total,
      peerId:  data.peerId || null,
      message: data.message,
    });
  });

  // DHT: peer discovered
  node.dht.on('peer:added', (peerId) => {
    _emit('controller:event', { level: 'info', message: `DHT peer discovered: ${peerId}` });
  });

  // General error forwarding
  node.bitswap.on('error', (err) => {
    _emit('controller:event', { level: 'error', message: `Bitswap: ${err.message}` });
  });
  node.dht.on('error', (err) => {
    _emit('controller:event', { level: 'error', message: `DHT: ${err.message}` });
  });

  // ── Start listening ──────────────────────────────────────────────────────
  const port = await node.start();
  _emit('controller:event', {
    level:   'ok',
    message: `Node started on port ${port} — Peer ID: ${node.id}`,
  });

  // ── Auto-connect to bootstrap peers ─────────────────────────────────────
  const bootstrapPeers = _loadBootstrapPeers();
  for (const addr of bootstrapPeers) {
    const [ip, portStr] = addr.split(':');
    if (ip && portStr) {
      try {
        await node.connect(ip, parseInt(portStr, 10));
        _emit('controller:event', { level: 'ok', message: `Bootstrap: connected to ${addr}` });
      } catch (e) {
        _emit('controller:event', { level: 'warn', message: `Bootstrap: failed to connect to ${addr} \u2014 ${e.message}` });
      }
    }
  }
}

/**
 * stop() → void
 */
async function stop() {
  if (!node) return;
  await node.stop();
  node = null;
  emit = null;
  _emit('controller:event', { level: 'warn', message: 'Node stopped.' });
}

/**
 * getStatus() → { running, peerId, peerCount, blockCount }
 */
function getStatus() {
  if (!node) return { running: false };
  try {
    const info = node.info();
    return {
      running:    true,
      peerId:     info.peerId,
      peerCount:  info.connections,
      blockCount: info.blocks,
    };
  } catch {
    return { running: true };
  }
}

/**
 * addFile(filePath) → { ok, cid1, cid2, cid3, error? }
 *
 * Adds a file using Triple Hashing. Returns all three CIDs.
 * CID² is returned for display only — the owner should store it privately.
 */
async function addFile(filePath) {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    _emit('controller:event', { level: 'info', message: `Adding: ${path.basename(filePath)}` });
    const result = await node.add(filePath);
    _emit('controller:event', {
      level:   'ok',
      message: `Added — CID³ published: ${result.cid3.slice(0, 24)}…`,
    });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * getFile(cid1String) → { ok, savedTo, verified, error? }
 *
 * Retrieves a file using the 4-step Enhanced Privacy Protocol.
 * Saves the result to the user's Downloads folder.
 */
async function getFile(cid1String) {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    // Reconstruct CID¹ from its string to extract the raw digest h1 = H(OBJ)
    const { cidFromString, CID } = await import(CID_URL);
    const { hash }               = await import(CRYPTO_URL);

    const cid1   = cidFromString(cid1String);
    const h1     = cid1.digest;       // h1 = H(OBJ)

    // Derive CID³ correctly: h2 = H(h1), h3 = H(h2), cid3 = CID(h3)
    // (tripleHash(h1) would treat h1 as raw data and re-hash it from scratch,
    //  producing the wrong CID³)
    const h2   = hash(h1);
    const h3   = hash(h2);
    const cid3 = new CID(h3);

    _emit('transfer:update', {
      type: 'derivation',
    });

    _emit('transfer:update', {
      type:    'search',
      message: 'Searching for CID\u00b3 providers\u2026',
    });

    // The Node.get() API handles the full 4-step handshake internally
    const bytes = await node.get(cid3.string, h1);

    _emit('transfer:update', { type: 'complete' });

    // Save to Downloads
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });
    const outPath = path.join(downloadsDir, `ipfs-${cid1String.slice(1, 12)}.bin`);
    fs.writeFileSync(outPath, bytes);

    _emit('controller:event', {
      level:   'ok',
      message: `Retrieved and saved: ${path.basename(outPath)}`,
    });

    return { ok: true, savedTo: outPath, verified: true };
  } catch (e) {
    _emit('transfer:update', { type: 'error' });
    let error = e.message;
    if (error.includes('No providers found')) {
      error = 'No providers found for this CID. Verify you are using CID\u00b9 (the private CID shown when the file was added).';
    } else if (error.includes('Failed to retrieve') && error.includes('from all providers')) {
      error = 'Found providers but retrieval failed. The CID may be wrong (e.g. CID\u00b2 or CID\u00b3 instead of CID\u00b9), or the provider is offline.';
    }
    return { ok: false, error };
  }
}

/**
 * getPeers() → Array<{ peerId, address, protocol, source }>
 *
 * Aggregates peers from transport connections and the DHT routing table.
 */
function getPeers() {
  if (!node) return [];
  const result = [];
  const seen = new Set();

  // Active transport connections
  for (const [peerId, conn] of node.transport.connections) {
    seen.add(peerId);
    result.push({
      peerId,
      address: `${conn.remoteIp || '?'}:${conn.remotePort || '?'}`,
      protocol: '/triple-hash/1.0.0',
      source: 'transport',
    });
  }

  // DHT routing table entries not already in transport
  for (const entry of node.dht.table.all()) {
    if (!seen.has(entry.peerId)) {
      seen.add(entry.peerId);
      result.push({
        peerId: entry.peerId,
        address: `${entry.ip}:${entry.port}`,
        protocol: '/dht/1.0',
        source: 'dht',
      });
    }
  }

  return result;
}

/**
 * connectToPeer(ip, port) → { ok, peerId?, error? }
 *
 * Dials a peer and emits connection events to the renderer.
 */
async function connectToPeer(ip, port) {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    const conn = await node.connect(ip, parseInt(port, 10));
    const peerId = (conn.remotePeer && conn.remotePeer.id) || 'unknown';
    // NOTE: peer:connected is already emitted by the transport 'connection' event
    // handler above — no need to emit it again here. Just log the controller event.
    _emit('controller:event', {
      level: 'ok',
      message: `Dialed peer ${peerId.slice(0, 12)}\u2026 at ${ip}:${port}`,
    });
    return { ok: true, peerId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * disconnectPeer(peerId) → { ok, error? }
 *
 * Closes the transport connection to a peer and removes it from the DHT routing table.
 */
function disconnectPeer(peerId) {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    const conn = node.transport.connections.get(peerId);
    if (conn) {
      conn.close();
    }
    // Also remove from DHT routing table
    if (node.dht && node.dht.table) {
      node.dht.table.remove(peerId);
    }
    _emit('controller:event', {
      level: 'info',
      message: `Disconnected peer: ${peerId.slice(0, 12)}\u2026`,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Internal helper ───────────────────────────────────────────────────────────

function _emit(channel, data) {
  if (emit) {
    try { emit(channel, data); } catch { /* renderer may be closed */ }
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * getConfig() → { dataDir, downloadDir, listenPort, announceIp }
 */
function getConfig() {
  const dataDir     = path.join(os.homedir(), '.ipfs-desktop-privacy', 'blocks');
  const downloadDir = path.join(os.homedir(), 'Downloads');
  return {
    dataDir,
    downloadDir,
    listenPort:  node ? (node._listenAddr?.port || 0) : 0,
    announceIp:  node ? node._announceIp : '127.0.0.1',
  };
}

// ── Cache operations ─────────────────────────────────────────────────────────

/**
 * cacheFromPeer(cid3String, peerId) → { ok, error? }
 *
 * Requests to cache an object from a connected peer (the owner).
 * This node stores the encrypted blob without ever learning CID¹.
 */
async function cacheFromPeer(cid3String, peerId) {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    const conn = node.transport.connections.get(peerId);
    if (!conn) return { ok: false, error: `Not connected to peer: ${peerId.slice(0, 12)}…` };

    _emit('controller:event', {
      level: 'info',
      message: `Caching CID³ ${cid3String.slice(0, 20)}… from peer ${peerId.slice(0, 12)}…`,
    });

    await node.cacheFrom(cid3String, conn);

    _emit('controller:event', {
      level: 'ok',
      message: `Cached successfully — CID³: ${cid3String.slice(0, 24)}…`,
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * getCachedItems() → Array<{ cid3, timestamp }>
 *
 * Returns the list of items this node is caching.
 */
function getCachedItems() {
  if (!node) return [];
  const items = [];
  for (const [cid3, entry] of node.bitswap._cached) {
    items.push({
      cid3,
      timestamp: entry.timestamp,
    });
  }
  return items;
}

/**
 * removeCached(cid3String) → { ok }
 *
 * Removes a cached item.
 */
function removeCached(cid3String) {
  if (!node) return { ok: false, error: 'Node not running' };
  node.bitswap._cached.delete(cid3String);
  _emit('controller:event', {
    level: 'info',
    message: `Removed cached item: ${cid3String.slice(0, 24)}…`,
  });
  return { ok: true };
}

// ── Decoy operations ────────────────────────────────────────────────────────

/**
 * setDecoysEnabled(enabled) → void
 *
 * Toggles automatic decoy requests on/off.
 */
function setDecoysEnabled(enabled) {
  if (node) node._decoysEnabled = !!enabled;
}

/**
 * sendDecoy() → { ok, error? }
 *
 * Manually triggers a single decoy request for testing.
 */
async function sendDecoy() {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    const res = await node.sendDecoy();
    if (res && res.ok) {
      _emit('controller:event', {
        level: 'info',
        message: 'Decoy request sent and completed (response discarded)',
      });
    }
    return res;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── DHT operations ─────────────────────────────────────────────────────────

/**
 * getDHTStats() → { peers, providers, registry, connections, kBucketSize }
 */
function getDHTStats() {
  if (!node) return { peers: 0, providers: 0, registry: 0, connections: 0, kBucketSize: 20 };
  const dhtStat = node.dht.stat();
  return {
    peers:        dhtStat.peers,
    providers:    dhtStat.providers,
    registry:     node._cidRegistry.size,
    connections:  node.transport.connections.size,
    kBucketSize:  20,
  };
}

/**
 * getDHTBuckets() → Array<{ index, peers: [{ peerId, ip, port, lastSeen }] }>
 *
 * Returns only non-empty k-buckets from the routing table.
 */
function getDHTBuckets() {
  if (!node) return [];
  return node.dht.table.buckets
    .map((bucket, i) => ({
      index: i,
      peers: bucket.map(p => ({
        peerId:   p.peerId,
        ip:       p.ip,
        port:     p.port,
        lastSeen: p.lastSeen,
      })),
    }))
    .filter(b => b.peers.length > 0);
}

/**
 * getDHTProviders() → { providers: [{ cid, peers }], registry: [{ cid3, peers, selfOwned }] }
 *
 * Returns both DHT provider records and the CID registry (decoy targets).
 */
function getDHTProviders() {
  if (!node) return { providers: [], registry: [] };

  const providers = [];
  for (const [cid, peerMap] of node.dht._providers) {
    providers.push({
      cid,
      peers: [...peerMap.values()].map(p => ({ peerId: p.peerId, ip: p.ip, port: p.port })),
    });
  }

  const registry = [];
  for (const [cid3, peerSet] of node._cidRegistry) {
    registry.push({
      cid3,
      peers:     [...peerSet],
      selfOwned: peerSet.has(node.id),
    });
  }

  return { providers, registry };
}

/**
 * dhtLookup(cid) → { ok, providers: [{ peerId, ip, port }], error? }
 *
 * Runs an iterative DHT findProviders lookup for a given CID.
 */
async function dhtLookup(cid) {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    const results = await node.dht.findProviders(cid, 8000);
    return {
      ok: true,
      providers: results.map(p => ({ peerId: p.peerId, ip: p.ip, port: p.port })),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { start, stop, getStatus, addFile, getFile, getPeers, connectToPeer, disconnectPeer, getConfig, cacheFromPeer, getCachedItems, removeCached, setDecoysEnabled, sendDecoy, getDHTStats, getDHTBuckets, getDHTProviders, dhtLookup, getStorageStats, getBlocks, pinBlock, unpinBlock, deleteBlock, runGC, getBandwidthStats, getPrivacyScore, getBootstrapPeers, addBootstrapPeer, removeBootstrapPeer };

// ── Storage operations ──────────────────────────────────────────────────────

function getStorageStats() {
  if (!node) return { blockCount: 0, totalBytes: 0, pinnedCount: 0 };
  return node.store.stat();
}

function getBlocks() {
  if (!node) return [];
  const cids = node.store.list();
  return cids.map(cid => {
    let size = 0;
    try {
      size = fs.statSync(path.join(node.store.blocksDir, cid)).size;
    } catch { /* ignore */ }
    const pinType = node.store.pins.get(cid) || null;
    return { cid, size, pinType };
  });
}

function pinBlock(cid, type) {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    node.store.pin(cid, type);
    _emit('controller:event', { level: 'info', message: `Pinned block (${type}): ${cid.slice(0, 24)}\u2026` });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function unpinBlock(cid) {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    node.store.unpin(cid);
    _emit('controller:event', { level: 'info', message: `Unpinned block: ${cid.slice(0, 24)}\u2026` });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deleteBlock(cid) {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    node.store.delete(cid);
    _emit('controller:event', { level: 'info', message: `Deleted block: ${cid.slice(0, 24)}\u2026` });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function runGC() {
  if (!node) return { ok: false, error: 'Node not running' };
  try {
    const deleted = node.store.gc();
    _emit('controller:event', { level: 'ok', message: `GC complete: ${deleted.length} block(s) removed` });
    return { ok: true, deleted };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Bandwidth & Privacy ─────────────────────────────────────────────────────

function getBandwidthStats() {
  if (!node) return { peers: [], totalSent: 0, totalReceived: 0 };
  const peerStats = [];
  let totalSent = 0, totalReceived = 0;
  for (const [peerId, ledger] of node.bitswap.ledgers) {
    peerStats.push({
      peerId,
      bytesSent: ledger.bytesSent,
      bytesReceived: ledger.bytesReceived,
      debtRatio: ledger.debtRatio(),
    });
    totalSent += ledger.bytesSent;
    totalReceived += ledger.bytesReceived;
  }
  return { peers: peerStats, totalSent, totalReceived };
}

function getPrivacyScore() {
  if (!node) return { decoysEnabled: false, registrySize: 0, connectedPeers: 0, score: 'poor' };
  const decoysEnabled = !!node._decoysEnabled;
  const registrySize = node._cidRegistry.size;
  const connectedPeers = node.transport.connections.size;

  let score = 'poor';
  if (decoysEnabled && registrySize > 0 && connectedPeers > 0) {
    score = (connectedPeers >= 3 && registrySize >= 3) ? 'good' : 'fair';
  } else if (decoysEnabled && connectedPeers > 0) {
    score = 'fair';
  }

  return { decoysEnabled, registrySize, connectedPeers, score };
}

// ── Bootstrap Peers ─────────────────────────────────────────────────────────

const BOOTSTRAP_FILE = path.join(os.homedir(), '.ipfs-desktop-privacy', 'bootstrap.json');

function _loadBootstrapPeers() {
  try {
    return JSON.parse(fs.readFileSync(BOOTSTRAP_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function _saveBootstrapPeers(peers) {
  fs.mkdirSync(path.dirname(BOOTSTRAP_FILE), { recursive: true });
  fs.writeFileSync(BOOTSTRAP_FILE, JSON.stringify(peers, null, 2));
}

function getBootstrapPeers() {
  return _loadBootstrapPeers();
}

function addBootstrapPeer(address) {
  if (!/^[\d.]+:\d+$/.test(address)) return { ok: false, error: 'Invalid format. Use ip:port (e.g. 127.0.0.1:4001)' };
  const list = _loadBootstrapPeers();
  if (list.includes(address)) return { ok: false, error: 'Already in bootstrap list' };
  list.push(address);
  _saveBootstrapPeers(list);
  return { ok: true };
}

function removeBootstrapPeer(address) {
  const list = _loadBootstrapPeers().filter(a => a !== address);
  _saveBootstrapPeers(list);
  return { ok: true };
}
