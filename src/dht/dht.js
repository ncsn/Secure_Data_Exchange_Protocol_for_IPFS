/**
 * dht.js — DHT node: provider records, peer lookup, content routing
 *
 * The DHT connects the routing table to the network. It answers:
 *   - "Who has CID X?"  → findProviders(cid)
 *   - "Where is peer P?" → findPeer(peerId)
 *   - "I have CID X"    → provide(cid)
 *
 * ── Provider records ─────────────────────────────────────────────────────────
 *
 *   When a node adds a file it calls provide(cid1) and provide(cid3).
 *   This stores a record in the DHT: "peer P has content CID X".
 *   The record is stored at the k peers closest to CID X in the network.
 *
 *   CID² is NEVER announced — it is the secret that proves ownership.
 *
 * ── Iterative lookup ─────────────────────────────────────────────────────────
 *
 *   To find providers for a CID:
 *     1. Start with our own k closest peers to the CID
 *     2. Ask each: "who do you know that is close to CID?"
 *     3. Add their responses to our candidate set
 *     4. Query the α closest un-queried candidates
 *     5. Repeat until no closer peers are found (convergence)
 *     6. Check if any of those peers have a provider record for CID
 *
 * ── DHT messages ─────────────────────────────────────────────────────────────
 *
 *   Sent over the '/dht/1.0' protocol on a Connection.
 *
 *   FIND_NODE  req  → "give me your k closest peers to this ID"
 *   FIND_NODE  resp → list of PeerInfo
 *   GET_PROVIDERS req  → "who has this CID?"
 *   GET_PROVIDERS resp → list of PeerInfo that have announced it
 *   ADD_PROVIDER      → "I have this CID" (stored at recipient)
 *   PING / PONG       → liveness check
 *
 * SWAP POINT — persistence:
 *   Provider records are stored in memory (Map). For a production node,
 *   persist them to disk (e.g. LevelDB) so they survive restarts.
 *   Replace this._providers Map with a persistent store.
 *
 * SWAP POINT — record TTL:
 *   Real IPFS provider records expire after 24 hours. The provider must
 *   re-announce periodically. Add a TTL field and a cleanup interval here.
 */

import EventEmitter    from 'events';
import { createPublicKey } from 'crypto';
import { sign, verify }    from '../libp2p/crypto.js';
import { RoutingTable, toId, compareDistance, ALPHA, K_BUCKET_SIZE } from './kademlia.js';

const DHT_PROTO = '/dht/1.0';

/** Provider records expire after 24 hours. Re-announce before this deadline. */
const PROVIDER_TTL_MS = 24 * 60 * 60 * 1000;

/** Maximum provider records per CID to prevent memory abuse */
const MAX_PROVIDERS_PER_CID = 100;

/** Maximum distinct CIDs in the provider table */
const MAX_PROVIDER_CIDS = 10000;

// ── Message types ─────────────────────────────────────────────────────────────

const DHTMsg = Object.freeze({
  FIND_NODE      : 0x01,
  FIND_NODE_RESP : 0x02,
  GET_PROVIDERS  : 0x03,
  GET_PROVIDERS_RESP: 0x04,
  ADD_PROVIDER   : 0x05,
  PING           : 0x06,
  PONG           : 0x07,
});

// ── Wire encoding ─────────────────────────────────────────────────────────────

/**
 * encodeDHT(type, key, peerInfos) → Buffer
 *
 * key      : arbitrary string (CID or peer ID)
 * peerInfos: array of { peerId, ip, port } — serialised for FIND_NODE_RESP
 *            and GET_PROVIDERS_RESP; empty for requests.
 */
function encodeDHT(type, key = '', peerInfos = []) {
  const keyBytes   = Buffer.from(key, 'utf8');
  // Encode peer list: each entry = [ peerId_len(2) | peerId | ip_len(1) | ip | port(2) ]
  const peerBufs   = peerInfos.map(p => {
    const pidBytes = Buffer.from(p.peerId, 'utf8');
    const ipBytes  = Buffer.from(p.ip,     'utf8');
    const buf      = Buffer.alloc(2 + pidBytes.length + 1 + ipBytes.length + 2);
    let off = 0;
    buf.writeUInt16BE(pidBytes.length, off);  off += 2;
    pidBytes.copy(buf, off);                  off += pidBytes.length;
    buf.writeUInt8(ipBytes.length, off);      off += 1;
    ipBytes.copy(buf, off);                   off += ipBytes.length;
    buf.writeUInt16BE(p.port, off);
    return buf;
  });
  const peersBytes  = Buffer.concat(peerBufs);
  const out         = Buffer.alloc(1 + 2 + keyBytes.length + 4 + peersBytes.length);
  let off = 0;
  out.writeUInt8(type, off);                  off += 1;
  out.writeUInt16BE(keyBytes.length, off);    off += 2;
  keyBytes.copy(out, off);                    off += keyBytes.length;
  out.writeUInt32BE(peersBytes.length, off);  off += 4;
  peersBytes.copy(out, off);
  return out;
}

function decodeDHT(buf) {
  let off          = 0;
  const type       = buf.readUInt8(off);                                  off += 1;
  const keyLen     = buf.readUInt16BE(off);                               off += 2;
  const key        = buf.slice(off, off + keyLen).toString('utf8');       off += keyLen;
  const peersLen   = buf.readUInt32BE(off);                               off += 4;
  const peersBuf   = buf.slice(off, off + peersLen);

  const peers = [];
  let poff = 0;
  while (poff < peersBuf.length) {
    const pidLen = peersBuf.readUInt16BE(poff);                           poff += 2;
    const peerId = peersBuf.slice(poff, poff + pidLen).toString('utf8'); poff += pidLen;
    const ipLen  = peersBuf.readUInt8(poff);                             poff += 1;
    const ip     = peersBuf.slice(poff, poff + ipLen).toString('utf8');  poff += ipLen;
    const port   = peersBuf.readUInt16BE(poff);                          poff += 2;
    peers.push({ peerId, ip, port });
  }

  return { type, key, peers };
}

// ── DHTNode ───────────────────────────────────────────────────────────────────

export class DHTNode extends EventEmitter {
  /**
   * @param {import('../libp2p/peer.js').PeerId} localPeer
   */
  constructor(localPeer, announceIp = '127.0.0.1') {
    super();
    this.localPeer    = localPeer;
    this.announceIp   = announceIp;
    this.table        = new RoutingTable(localPeer.id);

    // Provider records: cid string → Set of PeerInfo
    // SWAP POINT: replace with a persistent store + TTL expiry
    this._providers   = new Map();

    // Pending RPC responses: reqId → { resolve, reject, timeout }
    this._pending     = new Map();
    this._reqCounter  = 0;

    // Live connections: peerId.id → Connection
    this._connections = new Map();

    // Hourly cleanup of expired provider records
    this._cleanupInterval = setInterval(() => this._cleanupProviders(), 60 * 60 * 1000);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  // ── Connection management ─────────────────────────────────────────────────

  /**
   * addConnection(conn) — register a connection and add peer to routing table
   *
   * @param {import('../libp2p/transport.js').Connection} conn
   * @param {string} ip    — remote IP (needed for routing table entry)
   * @param {number} port  — remote port
   */
  addConnection(conn, ip, port) {
    const peerId = conn.remotePeer.id;
    this.table.add({ peerId, ip, port });
    this._connections.set(peerId, conn);

    conn.onMessage(DHT_PROTO, (payload) => {
      this._handleMessage(decodeDHT(payload), conn, ip, port, payload)
        .catch(err => this.emit('error', err));
    });

    conn.on('close', () => {
      this._connections.delete(peerId);
      this.table.remove(peerId);
    });

    // Re-announce our own provider records to the new peer so they learn
    // what we have (they may have connected after our initial broadcast).
    for (const [cidString, providerMap] of this._providers) {
      const ownRecord = providerMap.get(this.localPeer.id);
      if (ownRecord) {
        try { this._sendSignedProviders(conn, cidString, [ownRecord]); } catch {}
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * provide(cidString) — announce "I have this CID" to the network
   *
   * Stores a local provider record and announces to all connected peers.
   * Also performs an iterative Kademlia store — walks the DHT to find the
   * k closest nodes to the CID and stores the provider record at each.
   * Each announcement is signed with this node's ECDSA private key so
   * recipients can verify authenticity before storing the record.
   *
   * Privacy rule: call with cid1.string and cid3.string — NEVER cid2.string.
   *
   * @param {string} cidString
   * @param {number} [port=0]
   */
  provide(cidString, port = 0) {
    // Store locally (no auth needed for our own records)
    this._addProvider(cidString, {
      peerId: this.localPeer.id,
      ip:     this.announceIp,
      port,
    });

    // Sign the CID string to prove we are the legitimate announcer
    const sig    = sign(Buffer.from(cidString, 'utf8'), this.localPeer.privateKey);
    const pubKey = Buffer.from(this.localPeer.publicKeyRaw);

    // Auth blob: [ pubKeyLen(2) | pubKey | sigLen(2) | sig ]
    const authBlob = Buffer.alloc(2 + pubKey.length + 2 + sig.length);
    let off = 0;
    authBlob.writeUInt16BE(pubKey.length, off); off += 2;
    pubKey.copy(authBlob, off);                 off += pubKey.length;
    authBlob.writeUInt16BE(sig.length, off);    off += 2;
    sig.copy(authBlob, off);

    for (const conn of this._connections.values()) {
      const peersBuf = encodeDHT(DHTMsg.ADD_PROVIDER, cidString, [{
        peerId: this.localPeer.id,
        ip:     this.announceIp,
        port,
      }]);
      // Append auth blob after the standard encoded message
      this._send(conn, Buffer.concat([peersBuf, authBlob]));
    }

    // Iterative Kademlia store — walk the DHT to find & store at the k closest nodes.
    // Fire-and-forget so it doesn't block the caller.
    this._storeAtClosest(cidString, port).catch(() => {});
  }

  /**
   * findProviders(cidString) → Promise<PeerInfo[]>
   *
   * Iterative Kademlia lookup to find peers that have announced the CID.
   *
   * Algorithm:
   *   1. Seed with our k closest known peers to cidString
   *   2. Query ALPHA peers in parallel: GET_PROVIDERS(cid)
   *   3. Add any newly discovered peers to the candidate set
   *   4. If responses include providers → collect them
   *   5. Repeat until no closer un-queried candidates remain
   *   6. Return all found providers (deduplicated)
   *
   * @param {string} cidString
   * @param {number} [timeout=10000]
   * @returns {Promise<Array<{peerId:string, ip:string, port:number}>>}
   */
  async findProviders(cidString, timeout = 10000) {
    // Check local store first
    if (this._providers.has(cidString)) {
      return [...this._providers.get(cidString).values()];
    }

    const target     = toId(cidString);
    const queried    = new Set();
    const providers  = new Map(); // peerId → PeerInfo
    let   candidates = this.table.findClosest(cidString, K_BUCKET_SIZE);

    const deadline = Date.now() + timeout;

    while (candidates.length > 0 && Date.now() < deadline) {
      // Pick ALPHA un-queried candidates closest to target
      const batch = candidates
        .filter(p => !queried.has(p.peerId))
        .slice(0, ALPHA);

      if (batch.length === 0) break;

      // Query them in parallel
      const results = await Promise.allSettled(
        batch.map(peer => this._queryPeer(peer, cidString))
      );

      for (let i = 0; i < batch.length; i++) {
        const peer   = batch[i];
        queried.add(peer.peerId);
        const result = results[i];
        if (result.status !== 'fulfilled') continue;

        const { closerPeers, foundProviders } = result.value;

        // Collect providers
        for (const p of foundProviders) {
          providers.set(p.peerId, p);
        }

        // Add newly discovered peers to candidates
        for (const p of closerPeers) {
          if (!queried.has(p.peerId)) {
            this.table.add(p);
            candidates.push({ ...p, id: toId(p.peerId) });
          }
        }
      }

      // Re-sort candidates by distance, keep only closest
      candidates.sort((a, b) => compareDistance(a.id, b.id, target));
      candidates = candidates.slice(0, K_BUCKET_SIZE);
    }

    return [...providers.values()];
  }

  /**
   * findPeer(peerId) → Promise<{ip, port} | null>
   *
   * Looks up the network address of a peer by their ID.
   * Uses the same iterative lookup as findProviders.
   *
   * @param {string} peerId
   * @returns {Promise<{ip:string, port:number}|null>}
   */
  async findPeer(peerId, timeout = 10000) {
    // Check if we already have a direct connection
    const known = this.table.findClosest(peerId, 1);
    if (known.length > 0 && known[0].peerId === peerId) {
      return { ip: known[0].ip, port: known[0].port };
    }

    const target     = toId(peerId);
    const queried    = new Set();
    let   candidates = this.table.findClosest(peerId, K_BUCKET_SIZE);
    const deadline   = Date.now() + timeout;

    while (candidates.length > 0 && Date.now() < deadline) {
      const batch = candidates
        .filter(p => !queried.has(p.peerId))
        .slice(0, ALPHA);

      if (batch.length === 0) break;

      const results = await Promise.allSettled(
        batch.map(p => this._findNodeRPC(p, peerId))
      );

      for (let i = 0; i < batch.length; i++) {
        queried.add(batch[i].peerId);
        if (results[i].status !== 'fulfilled') continue;
        const closer = results[i].value;
        for (const p of closer) {
          if (p.peerId === peerId) return { ip: p.ip, port: p.port };
          if (!queried.has(p.peerId)) {
            this.table.add(p);
            candidates.push({ ...p, id: toId(p.peerId) });
          }
        }
      }

      candidates.sort((a, b) => compareDistance(a.id, b.id, target));
      candidates = candidates.slice(0, K_BUCKET_SIZE);
    }

    return null;
  }

  // ── Incoming message handler ──────────────────────────────────────────────

  async _handleMessage(msg, conn, ip, port, rawBuf) {
    const { type, key, peers } = msg;
    const remotePeerId = conn.remotePeer.id;

    // Refresh this peer in our routing table on every message
    this.table.add({ peerId: remotePeerId, ip, port });

    if (type === DHTMsg.FIND_NODE) {
      // Respond with our k closest peers to the requested key
      const closest = this.table.findClosest(key, K_BUCKET_SIZE);
      this._send(conn, encodeDHT(DHTMsg.FIND_NODE_RESP, key, closest));
      return;
    }

    if (type === DHTMsg.GET_PROVIDERS) {
      // Send known providers as ADD_PROVIDER so the requester stores them directly.
      // We re-sign with our own key when relaying records — this proves we genuinely
      // hold this provider record in our routing table (relay authentication).
      if (this._providers.has(key)) {
        const providers = [...this._providers.get(key).values()];
        if (providers.length > 0) {
          this._sendSignedProviders(conn, key, providers);
        }
      }
      // Also send our closest peers so the requester can continue iterating
      const closest = this.table.findClosest(key, K_BUCKET_SIZE);
      this._send(conn, encodeDHT(DHTMsg.GET_PROVIDERS_RESP, key, closest));
      return;
    }

    if (type === DHTMsg.ADD_PROVIDER) {
      // Extract the auth blob appended after the standard encoded message.
      // Standard header size: 1 (type) + 2 (keyLen) + keyLen + 4 (peersLen) + peersLen
      const keyLenVal   = rawBuf.readUInt16BE(1);
      const peersLenVal = rawBuf.readUInt32BE(1 + 2 + keyLenVal);
      const headerSize  = 1 + 2 + keyLenVal + 4 + peersLenVal;
      const authBlob    = rawBuf.slice(headerSize);

      // Reject records without an auth blob
      if (authBlob.length < 4) return;

      let aoff = 0;
      const pkLen   = authBlob.readUInt16BE(aoff);              aoff += 2;
      const pkBytes = authBlob.slice(aoff, aoff + pkLen);       aoff += pkLen;
      if (aoff + 2 > authBlob.length) return;
      const sigLen  = authBlob.readUInt16BE(aoff);              aoff += 2;
      const sigBytes = authBlob.slice(aoff, aoff + sigLen);

      // Import public key and verify signature of the CID string
      let pubKey;
      try {
        pubKey = createPublicKey({ key: pkBytes, type: 'spki', format: 'der' });
      } catch { return; }

      // The signing key must match the TCP-handshake-authenticated peer key.
      // This prevents injecting forged records from a third party.
      if (!pkBytes.equals(Buffer.from(conn.remotePeer.publicKeyRaw))) return;

      const valid = verify(Buffer.from(key, 'utf8'), sigBytes, pubKey);
      if (!valid) return; // discard — bad signature

      // Store all provider records in this authenticated message.
      // The sender vouches for them (either self-announcing or relaying).
      for (const p of peers) {
        this._addProvider(key, p);
        // Emit cid:seen with the provider's peerId so the decoy registry
        // can map CID3 → provider for targeted decoy requests
        this.emit('cid:seen', key, p.peerId);
      }
      return;
    }

    if (type === DHTMsg.PING) {
      this._send(conn, encodeDHT(DHTMsg.PONG, key));
      return;
    }

    // Responses to our outgoing RPCs — resolve pending promises
    if (type === DHTMsg.FIND_NODE_RESP || type === DHTMsg.GET_PROVIDERS_RESP) {
      const pending = this._pending.get(key + ':' + type);
      if (pending) {
        clearTimeout(pending.timeout);
        this._pending.delete(key + ':' + type);
        pending.resolve({ peers, type });
      }
      return;
    }
  }

  // ── RPC helpers ───────────────────────────────────────────────────────────

  /**
   * _queryPeer(peer, cidString) → Promise<{ closerPeers, foundProviders }>
   *
   * Sends GET_PROVIDERS to a peer and waits for the response.
   * Separates the response into closer peers vs. actual providers.
   */
  _queryPeer(peer, cidString) {
    return new Promise((resolve, reject) => {
      const conn = this._connections.get(peer.peerId);
      if (!conn) {
        reject(new Error(`No connection to peer ${peer.peerId.slice(0, 12)}...`));
        return;
      }

      const rKey   = cidString + ':' + DHTMsg.GET_PROVIDERS_RESP;
      const timeout = setTimeout(() => {
        this._pending.delete(rKey);
        reject(new Error('GET_PROVIDERS timeout'));
      }, 5000);

      this._pending.set(rKey, {
        timeout,
        resolve: ({ peers }) => {
          // Yield to the event loop so any ADD_PROVIDER frame that arrived
          // alongside this response gets processed before we read local providers.
          setImmediate(() => {
            const localProviders = this._providers.has(cidString)
              ? [...this._providers.get(cidString).values()]
              : [];
            resolve({ closerPeers: peers, foundProviders: localProviders });
          });
        },
        reject,
      });

      this._send(conn, encodeDHT(DHTMsg.GET_PROVIDERS, cidString));
    });
  }

  /**
   * _findNodeRPC(peer, targetId) → Promise<PeerInfo[]>
   *
   * Sends FIND_NODE to a peer and returns their closest-peers response.
   */
  _findNodeRPC(peer, targetId) {
    return new Promise((resolve, reject) => {
      const conn = this._connections.get(peer.peerId);
      if (!conn) { reject(new Error('No connection')); return; }

      const rKey   = targetId + ':' + DHTMsg.FIND_NODE_RESP;
      const timeout = setTimeout(() => {
        this._pending.delete(rKey);
        reject(new Error('FIND_NODE timeout'));
      }, 5000);

      this._pending.set(rKey, {
        timeout,
        resolve: ({ peers }) => resolve(peers),
        reject,
      });

      this._send(conn, encodeDHT(DHTMsg.FIND_NODE, targetId));
    });
  }

  /**
   * _storeAtClosest(cidString, port) — iterative Kademlia store
   *
   * Walks the DHT to find the k closest nodes to cidString, then sends
   * ADD_PROVIDER to each. This is the "iterative store" from the Kademlia
   * paper — ensures provider records reach the nodes most responsible for
   * this CID, not just our direct neighbours.
   *
   * Runs async / fire-and-forget so it doesn't block add().
   *
   * @param {string} cidString
   * @param {number} port
   */
  async _storeAtClosest(cidString, port) {
    const target     = toId(cidString);
    const queried    = new Set();
    let   candidates = this.table.findClosest(cidString, K_BUCKET_SIZE);

    if (candidates.length === 0) return;

    const deadline = Date.now() + 8000; // 8s timeout

    // Iterative FIND_NODE to discover the k-closest nodes to cidString
    while (candidates.length > 0 && Date.now() < deadline) {
      const batch = candidates
        .filter(p => !queried.has(p.peerId))
        .slice(0, ALPHA);

      if (batch.length === 0) break;

      const results = await Promise.allSettled(
        batch.map(peer => this._findNodeRPC(peer, cidString))
      );

      for (let i = 0; i < batch.length; i++) {
        queried.add(batch[i].peerId);
        if (results[i].status !== 'fulfilled') continue;

        for (const p of results[i].value) {
          if (!queried.has(p.peerId)) {
            this.table.add(p);
            candidates.push({ ...p, id: toId(p.peerId) });
          }
        }
      }

      candidates.sort((a, b) => compareDistance(a.id, b.id, target));
      candidates = candidates.slice(0, K_BUCKET_SIZE);
    }

    // Now send ADD_PROVIDER to the k closest nodes we found
    const closest = candidates.slice(0, K_BUCKET_SIZE);
    const providerInfo = [{
      peerId: this.localPeer.id,
      ip:     this.announceIp,
      port,
    }];

    for (const peer of closest) {
      const conn = this._connections.get(peer.peerId);
      if (!conn) continue;
      try {
        this._sendSignedProviders(conn, cidString, providerInfo);
      } catch {
        // peer may have disconnected — skip
      }
    }
  }

  _send(conn, buf) {
    conn.sendMessage(DHT_PROTO, buf);
  }

  /**
   * _sendSignedProviders(conn, cidString, providers) — send a signed ADD_PROVIDER
   *
   * When relaying provider records, we sign the CID with our own key so the
   * recipient can verify the relay is authentic (not a spoofed injection).
   */
  _sendSignedProviders(conn, cidString, providers) {
    const sig    = sign(Buffer.from(cidString, 'utf8'), this.localPeer.privateKey);
    const pubKey = Buffer.from(this.localPeer.publicKeyRaw);
    const authBlob = Buffer.alloc(2 + pubKey.length + 2 + sig.length);
    let off = 0;
    authBlob.writeUInt16BE(pubKey.length, off); off += 2;
    pubKey.copy(authBlob, off);                 off += pubKey.length;
    authBlob.writeUInt16BE(sig.length, off);    off += 2;
    sig.copy(authBlob, off);
    const peersBuf = encodeDHT(DHTMsg.ADD_PROVIDER, cidString, providers);
    conn.sendMessage(DHT_PROTO, Buffer.concat([peersBuf, authBlob]));
  }

  _addProvider(cidString, peerInfo) {
    if (!this._providers.has(cidString)) {
      // SECURITY: cap total distinct CIDs to prevent memory exhaustion
      if (this._providers.size >= MAX_PROVIDER_CIDS) return;
      this._providers.set(cidString, new Map());
    }
    const peerMap = this._providers.get(cidString);
    // SECURITY: cap providers per CID
    if (!peerMap.has(peerInfo.peerId) && peerMap.size >= MAX_PROVIDERS_PER_CID) return;
    peerMap.set(peerInfo.peerId, {
      ...peerInfo,
      timestamp: Date.now(),
    });
  }

  /**
   * _cleanupProviders() — remove provider records older than PROVIDER_TTL_MS
   * Called automatically every hour.
   */
  _cleanupProviders() {
    const cutoff = Date.now() - PROVIDER_TTL_MS;
    for (const [cid, peerMap] of this._providers) {
      for (const [peerId, record] of peerMap) {
        if (record.timestamp < cutoff) peerMap.delete(peerId);
      }
      if (peerMap.size === 0) this._providers.delete(cid);
    }
  }

  /**
   * stop() — clear timers
   */
  stop() {
    clearInterval(this._cleanupInterval);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  /**
   * stat() → { peers, providers }
   */
  stat() {
    let providerCount = 0;
    for (const set of this._providers.values()) providerCount += set.size;
    return { peers: this.table.size(), providers: providerCount };
  }
}
