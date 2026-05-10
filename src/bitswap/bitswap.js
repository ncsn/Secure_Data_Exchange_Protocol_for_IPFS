/**
 * bitswap.js — Bitswap engine
 *
 * The Bitswap engine sits between the block store and the network.
 * It handles:
 *   1. Standard block exchange (want-list, HAVE/BLOCK responses)
 *   2. Per-peer ledgers (bytes sent vs received — incentive layer)
 *   3. Privacy protocol handshake (Steps 1–4 from the research paper)
 *   4. Decoy requests
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *
 *   BitswapEngine
 *     ├── BlockStore            — local block storage (read + write)
 *     ├── PeerId                — local peer identity (for signing)
 *     ├── Map<peerId, Ledger>   — per-peer accounting
 *     ├── Map<cid, callbacks>   — pending requests waiting for blocks
 *     └── Connection registry   — connections handed to us by TCPTransport
 *
 * ── Ledger ────────────────────────────────────────────────────────────────────
 *
 *   For each peer we track:
 *     bytesSent     — how many bytes we sent them
 *     bytesReceived — how many bytes they sent us
 *     debt ratio    — bytesSent / (bytesReceived + 1)
 *
 *   Peers with high debt (they receive much more than they send) get
 *   lower priority. This is the incentive mechanism that prevents leeching.
 *
 *   SWAP POINT — incentive strategy:
 *     Real Bitswap uses a more sophisticated strategy (Bitswap 1.2 uses
 *     a sigmoid function over the debt ratio). Replace _shouldServe()
 *     to implement a different strategy.
 *
 * ── Privacy protocol ──────────────────────────────────────────────────────────
 *
 *   When a node calls requestPrivate(cid3, cid1, ownerConn):
 *     Step 1: send WANT_HAVE(cid3)
 *     Step 2: receive PRIVACY_CHALLENGE(Sign(CID₂ ‖ PKB ‖ Gb), PKB, Gb)
 *             verify sig against owner's public key
 *     Step 3: generate DH keypair (ga, Ga), compute K_AB = DH(ga, Gb)
 *             send PRIVACY_RESPONSE(ecies(CID₁ ‖ H(K_AB) ‖ Ga, PKB))
 *     Step 4: receive PRIVACY_BLOCK(aes_K_AB(OBJ))
 *             decrypt with K_AB, verify hash = CID₁ digest
 *
 *   When a node is the owner and receives WANT_HAVE(cid3):
 *     - looks up cid3 → cid2 mapping (owner's private table)
 *     - generates ephemeral DH keypair (gb, Gb)
 *     - sends PRIVACY_CHALLENGE(Sign(CID₂ ‖ PKB ‖ Gb), PKB, Gb)
 *     - waits for PRIVACY_RESPONSE, decrypts to get CID₁ + H(K_AB) + Ga
 *     - computes K_AB = DH(gb, Ga), verifies H(K_AB)
 *     - fetches OBJ, encrypts with K_AB, sends PRIVACY_BLOCK
 */

import EventEmitter from 'events';
import { randomBytes, timingSafeEqual } from 'crypto';

import { MessageType, MessageTypeName, encode, decode } from './messages.js';
import { sign, verify, eciesDecrypt, eciesEncrypt,
         aesEncrypt, aesDecrypt,
         generateDHKeyPair, computeDHSecret }           from '../libp2p/crypto.js';
import { serialize as serializeDAG,
         deserialize as deserializeDAG }                from '../dag/node.js';
import { tripleHash }                                   from '../cid/cid.js';
import { hash }                                         from '../cid/crypto.js';
import { createPublicKey, createHash }                  from 'crypto';

const BITSWAP_PROTO = '/bitswap/1.0';

/** Cached objects expire after 24 hours. Cache nodes drop expired entries. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Maximum concurrent pending requests to prevent memory exhaustion */
const MAX_PENDING = 1024;

/** 16-byte magic value embedded in DECOY_REQUEST payloads.
 *  Owner B decrypts the ECIES payload and checks for this prefix to distinguish
 *  decoy requests from real PRIVACY_RESPONSE messages. */
const DECOY_FLAG = Buffer.from('DECOY_TRIPLE_HSH'); // exactly 16 bytes

// ── Ledger ────────────────────────────────────────────────────────────────────

class Ledger {
  constructor(peerId) {
    this.peerId        = peerId;
    this.bytesSent     = 0;
    this.bytesReceived = 0;
  }

  /** debt ratio — higher means we've sent more than we received */
  debtRatio() {
    return this.bytesSent / (this.bytesReceived + 1);
  }
}

// ── BitswapEngine ─────────────────────────────────────────────────────────────

export class BitswapEngine extends EventEmitter {
  /**
   * @param {import('../blockstore/blockstore.js').BlockStore} store
   * @param {import('../libp2p/peer.js').PeerId}               localPeer
   */
  constructor(store, localPeer) {
    super();
    this.store      = store;
    this.localPeer  = localPeer;

    // per-peer ledgers
    this.ledgers    = new Map(); // peerId.id → Ledger

    // pending block requests: cid string → { resolve, reject, timeout }
    this._pending   = new Map();

    // owner's private triple-hash table: cid3.string → { cid1, cid2, h1, rawData }
    // Populated when this node adds a file it owns.
    this._owned     = new Map();

    // encrypted cache: cid3.string → { encryptedBlob, authorization, ownerPubKeyRaw, timestamp }
    // Populated when this node caches content from an owner.
    // encryptedBlob = AES(OBJ, H(CID¹)) || timestamp — cannot be decrypted by cache node.
    this._cached    = new Map();
  }

  // ── Connection management ─────────────────────────────────────────────────

  /**
   * addConnection(conn) — register a live Connection with this engine
   *
   * Must be called whenever TCPTransport emits a 'connection' event.
   * Attaches a message handler so the engine processes incoming Bitswap messages.
   *
   * @param {import('../libp2p/transport.js').Connection} conn
   */
  addConnection(conn) {
    const peerId = conn.remotePeer.id;
    if (!this.ledgers.has(peerId)) {
      this.ledgers.set(peerId, new Ledger(peerId));
    }

    conn.onMessage(BITSWAP_PROTO, (payload) => {
      this._handleMessage(decode(payload), conn).catch(err =>
        this.emit('error', err)
      );
    });

    conn.on('close', () => {
      // Clean up any pending requests that were waiting on this peer
      for (const [cid, pending] of this._pending) {
        if (pending.peerId === peerId) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`Connection closed before block received: ${cid}`));
          this._pending.delete(cid);
        }
      }
    });
  }

  // ── Ownership registration ────────────────────────────────────────────────

  /**
   * registerOwned(data) — register raw object data as owned by this node
   *
   * Computes the triple hash and stores the private mapping
   * cid3 → { cid1, cid2, h1, data } so we can respond to privacy requests.
   *
   * @param {Buffer} data — raw object bytes
   * @returns {{ cid1, cid2, cid3 }} the three CIDs
   */
  registerOwned(data) {
    const { cid1, cid2, cid3, h1, h2 } = tripleHash(data);
    // Store only metadata — do NOT keep full bytes in memory (unbounded growth risk).
    // Raw data is persisted in the block store below and fetched on demand when serving.
    this._owned.set(cid3.string, { cid1, cid2, h1, h2 });
    // Also store raw data under cid1 so wantBlock / getPublic can serve it
    this.store.put(cid1.string, data);
    return { cid1, cid2, cid3 };
  }

  // ── Standard Bitswap: requester side ─────────────────────────────────────

  /**
   * wantBlock(cidString, conn) → Promise<Buffer>
   *
   * Standard block request: WANT_HAVE → WANT_BLOCK → receive BLOCK.
   * Returns the raw block bytes.
   *
   * @param {string}     cidString
   * @param {Connection} conn
   * @returns {Promise<Buffer>}
   */
  wantBlock(cidString, conn) {
    return new Promise((resolve, reject) => {
      if (this._pending.size >= MAX_PENDING) {
        return reject(new Error('Too many pending requests'));
      }
      // Step 1: WANT_HAVE
      this._send(conn, MessageType.WANT_HAVE, cidString);

      // Register pending request
      const timeout = setTimeout(() => {
        this._pending.delete(cidString);
        reject(new Error(`Timeout waiting for block: ${cidString.slice(0, 20)}...`));
      }, 15000);

      this._pending.set(cidString, { resolve, reject, timeout, peerId: conn.remotePeer.id, conn });
    });
  }

  // ── Privacy protocol: requester side (Node A) ─────────────────────────────

  /**
   * requestPrivate(cid3String, cid1Digest, conn) → Promise<Buffer>
   *
   * Full 4-step privacy handshake from requester's perspective.
   * Session key K_AB is derived via Diffie-Hellman during the handshake
   * (provides forward secrecy per paper Figure 2).
   *
   * @param {string} cid3String   — CID³ string (what we search for)
   * @param {Buffer} cid1Digest   — raw h1 = H(OBJ), used to verify the response
   * @param {import('../libp2p/transport.js').Connection} conn
   * @returns {Promise<Buffer>} the decrypted object bytes
   */
  requestPrivate(cid3String, cid1Digest, conn) {
    return new Promise((resolve, reject) => {
      if (this._pending.size >= MAX_PENDING) {
        return reject(new Error('Too many pending requests'));
      }
      // Step 1 → WANT_HAVE(CID³)
      this._send(conn, MessageType.WANT_HAVE, cid3String);
      this.emit('handshake:step', { step: 1, total: 4, peerId: conn.remotePeer.id, cid: cid3String, message: 'WANT_HAVE(CID³) sent' });

      const timeout = setTimeout(() => {
        this._pending.delete(cid3String);
        reject(new Error(`Privacy request timeout for: ${cid3String.slice(0, 20)}...`));
      }, 15000);

      this._pending.set(cid3String, {
        peerId: conn.remotePeer.id,
        conn,
        timeout,
        isPrivate: true,
        cid1Digest,
        // K will be derived via DH during Step 3 (set by PRIVACY_CHALLENGE handler)
        K: null,
        resolve,
        reject,
      });
    });
  }

  // ── Decoy request (Node A) ────────────────────────────────────────────────

  /**
   * sendDecoy(cid3String, conn) → Promise<void>
   *
   * Sends a decoy request — appears identical to a real privacy request
   * to any outside observer, but includes a decoy flag instead of a real CID¹.
   * The owner recognises the flag and sends back random bits.
   *
   * @param {string}     cid3String — CID³ of any existing object
   * @param {Connection} conn
   * @returns {Promise<void>}
   */
  sendDecoy(cid3String, conn) {
    return new Promise((resolve, reject) => {
      if (this._pending.size >= MAX_PENDING) {
        return reject(new Error('Too many pending requests'));
      }
      // If there's already a pending decoy for this CID3, skip to avoid key collision
      if (this._pending.has(cid3String + ':decoy')) {
        return resolve(); // silently succeed — previous decoy is in-flight
      }
      this._send(conn, MessageType.WANT_HAVE, cid3String);

      const timeout = setTimeout(() => {
        this._pending.delete(cid3String + ':decoy');
        reject(new Error('Decoy request timeout'));
      }, 15000);

      this._pending.set(cid3String + ':decoy', {
        peerId: conn.remotePeer.id,
        conn,
        timeout,
        isDecoy: true,
        cid3String,
        resolve,
        reject,
      });
    });
  }

  // ── Encrypted caching: cache population (Node C → Owner B) ────────────────

  /**
   * requestCache(cid3String, conn) → Promise<void>
   *
   * Cache node C asks owner B to cache an object.
   * Steps 1–2 reuse WANT_HAVE / PRIVACY_CHALLENGE (same wire messages).
   * Step 3: C sends CACHE_REQUEST with ecies(K + C_pubkey, B_pubkey)
   * Step 4: B responds with CACHE_RESPONSE containing the encrypted blob + authorization
   *
   * The cached blob is encrypted with H(CID¹) — C never learns CID¹.
   *
   * @param {string}     cid3String — CID³ of the object to cache
   * @param {Connection} conn       — connection to owner B
   * @returns {Promise<void>} resolves when cache entry is stored
   */
  requestCache(cid3String, conn) {
    return new Promise((resolve, reject) => {
      if (this._pending.size >= MAX_PENDING) {
        return reject(new Error('Too many pending requests'));
      }
      // Step 1: WANT_HAVE(CID³) — same as privacy request
      this._send(conn, MessageType.WANT_HAVE, cid3String);

      const timeout = setTimeout(() => {
        this._pending.delete(cid3String + ':cache');
        reject(new Error(`Cache request timeout for: ${cid3String.slice(0, 20)}...`));
      }, 15000);

      this._pending.set(cid3String + ':cache', {
        peerId: conn.remotePeer.id,
        conn,
        timeout,
        isCachePopulation: true,
        cid3String,
        resolve,
        reject,
      });
    });
  }

  // ── Encrypted caching: cache retrieval (Node A → Cache C) ─────────────────

  /**
   * requestFromCache(cid3String, cid1Digest, K, conn) → Promise<Buffer>
   *
   * Requester A gets an object from cache node C.
   * Step 5: A sends WANT_HAVE(CID³)
   * Step 6: C responds with CACHE_CHALLENGE (authorization + B_pub + C_pub)
   * Step 7: A verifies authorization, sends CACHE_REQUEST ecies(K, C_pubkey)
   * Step 8: C responds with CACHE_BLOCK AES_K(cached_blob)
   * Step 9: A decrypts outer with K, inner with H(CID¹), verifies integrity
   *
   * @param {string} cid3String   — CID³ string
   * @param {Buffer} cid1Digest   — raw H(OBJ), used to decrypt inner layer + verify
   * @param {Buffer} K            — 32-byte AES session key generated by A
   * @param {Connection} conn     — connection to cache node C
   * @returns {Promise<Buffer>} the decrypted object bytes
   */
  requestFromCache(cid3String, cid1Digest, K, conn) {
    return new Promise((resolve, reject) => {
      if (this._pending.size >= MAX_PENDING) {
        return reject(new Error('Too many pending requests'));
      }
      // Step 5: WANT_HAVE(CID³)
      this._send(conn, MessageType.WANT_HAVE, cid3String);

      const timeout = setTimeout(() => {
        this._pending.delete(cid3String + ':fromcache');
        reject(new Error(`Cache retrieval timeout for: ${cid3String.slice(0, 20)}...`));
      }, 15000);

      this._pending.set(cid3String + ':fromcache', {
        peerId: conn.remotePeer.id,
        conn,
        timeout,
        isCacheRetrieval: true,
        cid1Digest,
        K,
        resolve,
        reject,
      });
    });
  }

  // ── Message handler (incoming) ────────────────────────────────────────────

  /**
   * _handleMessage(msg, conn) — route an incoming Bitswap message
   *
   * @param {{ type, cid, payload }} msg
   * @param {Connection}             conn
   */
  async _handleMessage(msg, conn) {
    const { type, cid, payload } = msg;
    const peerId = conn.remotePeer.id;
    const ledger = this._ledger(peerId);

    // ── Serving side (we received a request) ─────────────────────────────────

    if (type === MessageType.WANT_HAVE) {
      if (this._owned.has(cid)) {
        // Privacy request — Step 2: send Sign(CID₂ ‖ PKB ‖ Gb), PKB, Gb
        // Per paper Figure 2: B generates ephemeral DH keypair, signs the
        // challenge binding CID₂, its public key, and Gb together.
        // This provides forward secrecy via the DH exchange.
        const owned = this._owned.get(cid);

        // Generate ephemeral DH keypair for this session
        const { privateKey: gb, publicKey: Gb } = generateDHKeyPair();

        // Store gb temporarily so we can compute K_AB when PRIVACY_RESPONSE arrives
        // Key: cid + peerId to handle concurrent requests from different peers
        const dhKey = cid + ':' + peerId;
        if (!this._dhEphemeral) this._dhEphemeral = new Map();
        this._dhEphemeral.set(dhKey, { gb, Gb });

        // Sign (CID₂.digest ‖ PKB ‖ Gb) — binds DH parameter to the signature
        const pubKey = this.localPeer.publicKeyRaw;
        const signedData = Buffer.concat([owned.cid2.digest, pubKey, Gb]);
        const sig = sign(signedData, this.localPeer.privateKey);

        // Pack: [ Gb_length(2) | Gb(65) | sig_length(2) | sig | pubKey_length(2) | pubKey ]
        const packed = Buffer.alloc(2 + Gb.length + 2 + sig.length + 2 + pubKey.length);
        let off = 0;
        packed.writeUInt16BE(Gb.length, off);     off += 2;
        Gb.copy(packed, off);                     off += Gb.length;
        packed.writeUInt16BE(sig.length, off);    off += 2;
        sig.copy(packed, off);                    off += sig.length;
        packed.writeUInt16BE(pubKey.length, off); off += 2;
        pubKey.copy(packed, off);

        this._send(conn, MessageType.PRIVACY_CHALLENGE, cid, packed);
        ledger.bytesSent += packed.length;

      } else if (this._cached.has(cid)) {
        // Cache node serving — Step 6: send CACHE_CHALLENGE
        const cached = this._cached.get(cid);

        // Check TTL — drop expired cache entries
        if (cached.timestamp && Date.now() - cached.timestamp > CACHE_TTL_MS) {
          this._cached.delete(cid);
          this.emit('error', new Error(`Cache expired for ${cid.slice(0, 20)}…`));
          this._send(conn, MessageType.DONT_HAVE, cid);
          return;
        }

        // Payload: [ auth_len(2) | auth | ownerPubKeyLen(2) | ownerPubKey | cachePubKeyLen(2) | cachePubKey ]
        const cachePubKey = this.localPeer.publicKeyRaw;
        const challengePayload = Buffer.alloc(
          2 + cached.authorization.length +
          2 + cached.ownerPubKeyRaw.length +
          2 + cachePubKey.length
        );
        let off = 0;
        challengePayload.writeUInt16BE(cached.authorization.length, off); off += 2;
        cached.authorization.copy(challengePayload, off);                 off += cached.authorization.length;
        challengePayload.writeUInt16BE(cached.ownerPubKeyRaw.length, off); off += 2;
        cached.ownerPubKeyRaw.copy(challengePayload, off);                off += cached.ownerPubKeyRaw.length;
        challengePayload.writeUInt16BE(cachePubKey.length, off);           off += 2;
        cachePubKey.copy(challengePayload, off);

        this._send(conn, MessageType.CACHE_CHALLENGE, cid, challengePayload);
        ledger.bytesSent += challengePayload.length;

      } else if (this.store.has(cid) && this._shouldServe(ledger)) {
        // Standard request — respond with HAVE
        this._send(conn, MessageType.HAVE, cid);
      } else {
        this._send(conn, MessageType.DONT_HAVE, cid);
      }
      return;
    }

    if (type === MessageType.WANT_BLOCK) {
      if (this.store.has(cid) && this._shouldServe(ledger)) {
        const blockData = this.store.get(cid);
        this._send(conn, MessageType.BLOCK, cid, blockData);
        ledger.bytesSent += blockData.length;
      }
      return;
    }

    // ── Privacy Step 3: owner receives PRIVACY_RESPONSE ───────────────────────
    // This handler serves BOTH real privacy requests AND decoy requests.
    // Since decoys use the same PRIVACY_RESPONSE message type (for wire
    // indistinguishability), the owner must decrypt first and then check
    // whether the payload starts with DECOY_FLAG to distinguish the two.
    if (type === MessageType.PRIVACY_RESPONSE) {
      if (!this._owned.has(cid)) return;
      const owned = this._owned.get(cid);

      try {
        // Decrypt the payload with our private key
        const decrypted = eciesDecrypt(payload, this.localPeer.privateKey);

        // Check for DECOY_FLAG prefix (16 bytes) — if present, this is a decoy
        if (decrypted.length >= DECOY_FLAG.length &&
            decrypted.length < 64 &&
            timingSafeEqual(decrypted.slice(0, DECOY_FLAG.length), DECOY_FLAG)) {
          // Decoy request — extract size hint and respond with random bits
          const MAX_DECOY_SIZE = 1024 * 1024; // 1 MiB cap to prevent memory abuse
          const rawHint = decrypted.length >= 20
            ? decrypted.readUInt32BE(DECOY_FLAG.length)
            : 256;
          const sizeHint = Math.min(rawHint, MAX_DECOY_SIZE);
          const randomData = randomBytes(sizeHint);
          this._send(conn, MessageType.PRIVACY_BLOCK, cid, randomData);
          ledger.bytesSent += randomData.length;
          return;
        }

        // Real privacy request — paper Figure 2 Step 3:
        // Decrypted payload: [ CID₁ digest (32) | H(K_AB) (32) | Ga (65) ]
        if (decrypted.length < 32 + 32 + 65) {
          this._send(conn, MessageType.DONT_HAVE, cid);
          return;
        }
        const receivedCid1Digest = decrypted.slice(0, 32);
        const receivedHK         = decrypted.slice(32, 64);
        const Ga                 = decrypted.slice(64);

        // Verify CID¹: H(receivedCid1Digest) must equal cid2.digest
        const verifiedH2 = hash(receivedCid1Digest);
        if (verifiedH2.length !== owned.cid2.digest.length ||
            !timingSafeEqual(verifiedH2, owned.cid2.digest)) {
          this._send(conn, MessageType.DONT_HAVE, cid);
          return;
        }

        // Retrieve our ephemeral DH private key (gb) stored during Step 2
        const dhKey = cid + ':' + peerId;
        const dhEph = this._dhEphemeral?.get(dhKey);
        if (!dhEph) {
          this._send(conn, MessageType.DONT_HAVE, cid);
          return;
        }
        this._dhEphemeral.delete(dhKey); // one-time use

        // Compute K_AB = KDF(ECDH(gb, Ga))
        const K_AB = computeDHSecret(dhEph.gb, Ga);

        // Verify H(K_AB) matches what A sent — this proves both parties derived
        // the same session key (mutual key confirmation per the paper)
        const computedHK = createHash('sha256').update(K_AB).digest();
        if (!timingSafeEqual(computedHK, receivedHK)) {
          this._send(conn, MessageType.DONT_HAVE, cid);
          return;
        }

        // Fetch raw data from block store
        const rawData = this.store.get(owned.cid1.string);
        if (!rawData) {
          this._send(conn, MessageType.DONT_HAVE, cid);
          return;
        }

        // Encrypt OBJ with K_AB and send PRIVACY_BLOCK
        const encrypted = aesEncrypt(rawData, K_AB);
        this._send(conn, MessageType.PRIVACY_BLOCK, cid, encrypted);
        ledger.bytesSent += encrypted.length;

      } catch (err) {
        this._send(conn, MessageType.DONT_HAVE, cid);
      }
      return;
    }

    // Note: DECOY_REQUEST (0x20) handler removed — decoys now use PRIVACY_RESPONSE
    // for wire indistinguishability. The PRIVACY_RESPONSE handler above detects
    // decoys via DECOY_FLAG after ECIES decryption.

    // ── Cache population Step 3: owner receives CACHE_REQUEST ─────────────────
    if (type === MessageType.CACHE_REQUEST) {
      // Two cases: (a) owner B receives from cache node C, (b) cache C receives from requester A

      // Case (a): owner side — cid is in _owned
      if (this._owned.has(cid)) {
        const owned = this._owned.get(cid);
        try {
          // Decrypt payload: ecies(K + C_pubKeyRaw, B_pubkey)
          const decrypted = eciesDecrypt(payload, this.localPeer.privateKey);

          // Payload is K (32 bytes) + C's public key (remaining bytes)
          const K          = decrypted.slice(0, 32);
          const cPubKeyRaw = decrypted.slice(32);

          // Fetch raw data from block store
          const rawData = this.store.get(owned.cid1.string);
          if (!rawData) {
            this._send(conn, MessageType.DONT_HAVE, cid);
            return;
          }

          // Inner encryption: AES(OBJ, H(CID¹)) — using cid1.digest as the key
          const innerCipher = aesEncrypt(rawData, owned.cid1.digest);

          // Append 8-byte timestamp
          const tsBuf = Buffer.alloc(8);
          tsBuf.writeBigUInt64BE(BigInt(Date.now()));
          const blob = Buffer.concat([innerCipher, tsBuf]);

          // Outer encryption: AES_K(blob)
          const outerCipher = aesEncrypt(blob, K);

          // Sign authorization: sign(CID².digest || C_pubKeyRaw)
          const authData = Buffer.concat([owned.cid2.digest, cPubKeyRaw]);
          const authorization = sign(authData, this.localPeer.privateKey);

          // Build CACHE_RESPONSE: [ outerLen(4) | outer_cipher | auth_len(2) | auth | ownerPubKeyLen(2) | ownerPubKey ]
          const ownerPubKey = this.localPeer.publicKeyRaw;
          const response = Buffer.alloc(
            4 + outerCipher.length + 2 + authorization.length + 2 + ownerPubKey.length
          );
          let off = 0;
          response.writeUInt32BE(outerCipher.length, off);               off += 4;
          outerCipher.copy(response, off);                               off += outerCipher.length;
          response.writeUInt16BE(authorization.length, off);             off += 2;
          authorization.copy(response, off);                             off += authorization.length;
          response.writeUInt16BE(ownerPubKey.length, off);               off += 2;
          ownerPubKey.copy(response, off);

          this._send(conn, MessageType.CACHE_RESPONSE, cid, response);
          ledger.bytesSent += response.length;

        } catch (err) {
          this._send(conn, MessageType.DONT_HAVE, cid);
        }
        return;
      }

      // Case (b): cache node C receives from requester A (cache retrieval Step 7)
      if (this._cached.has(cid)) {
        const cached = this._cached.get(cid);
        try {
          // Decrypt payload: ecies(K, C_pubkey) — just the AES key
          const K = eciesDecrypt(payload, this.localPeer.privateKey);

          // Outer-encrypt the cached blob with requester's K
          const outerCipher = aesEncrypt(cached.encryptedBlob, K);
          this._send(conn, MessageType.CACHE_BLOCK, cid, outerCipher);
          ledger.bytesSent += outerCipher.length;

        } catch (err) {
          this._send(conn, MessageType.DONT_HAVE, cid);
        }
        return;
      }
      return;
    }

    // ── Requesting side (we receive a response) ───────────────────────────────

    if (type === MessageType.HAVE) {
      const pending = this._pending.get(cid);
      if (!pending) return;
      // SECURITY: only accept HAVE from the peer we sent the request to
      if (pending.peerId && pending.peerId !== conn.remotePeer.id) return;
      // Upgrade to WANT_BLOCK
      this._send(conn, MessageType.WANT_BLOCK, cid);
      return;
    }

    if (type === MessageType.DONT_HAVE) {
      const errMsg = `Peer does not have block: ${cid.slice(0, 20)}...`;
      // Check standard pending, then cache-related pending entries
      for (const key of [cid, cid + ':cache', cid + ':fromcache']) {
        const pending = this._pending.get(key);
        if (!pending) continue;
        // SECURITY: only accept DONT_HAVE from the peer we sent the request to
        if (pending.peerId && pending.peerId !== conn.remotePeer.id) continue;
        clearTimeout(pending.timeout);
        this._pending.delete(key);
        pending.reject(new Error(errMsg));
      }
      return;
    }

    if (type === MessageType.BLOCK) {
      const pending = this._pending.get(cid);
      if (!pending) return;
      // SECURITY: only accept BLOCK from the peer we sent the request to
      if (pending.peerId && pending.peerId !== conn.remotePeer.id) return;
      clearTimeout(pending.timeout);
      this._pending.delete(cid);
      ledger.bytesReceived += payload.length;
      pending.resolve(payload);
      return;
    }

    // ── Privacy Step 2 response: requester receives PRIVACY_CHALLENGE ─────────
    if (type === MessageType.PRIVACY_CHALLENGE) {
      // Check for privacy request first
      const pending = this._pending.get(cid);

      // Also check for cache population request (keyed as cid + ':cache')
      const cachePending = this._pending.get(cid + ':cache');

      if (cachePending?.isCachePopulation) {
        // Cache population Step 2→3: cache node C received PRIVACY_CHALLENGE from owner B
        // New format: [ Gb_len(2) | Gb | sig_len(2) | sig | pubKey_len(2) | pubKey ]
        // C cannot verify the signature (doesn't know CID²), but validates the pubkey.

        // SECURITY: bounds check before parsing
        if (payload.length < 2 + 65 + 2 + 2) {
          clearTimeout(cachePending.timeout);
          this._pending.delete(cid + ':cache');
          cachePending.reject(new Error('PRIVACY_CHALLENGE: payload too short'));
          return;
        }
        let off       = 0;
        const GbLen   = payload.readUInt16BE(off); off += 2;
        off += GbLen; // skip Gb — C doesn't use it for cache protocol
        if (off + 2 > payload.length) {
          clearTimeout(cachePending.timeout);
          this._pending.delete(cid + ':cache');
          cachePending.reject(new Error('PRIVACY_CHALLENGE: malformed payload'));
          return;
        }
        const sigLen  = payload.readUInt16BE(off); off += 2;
        if (off + sigLen + 2 > payload.length) {
          clearTimeout(cachePending.timeout);
          this._pending.delete(cid + ':cache');
          cachePending.reject(new Error('PRIVACY_CHALLENGE: malformed payload'));
          return;
        }
        // skip sig — C cannot verify it (doesn't know CID²)
        off += sigLen;
        const pkLen   = payload.readUInt16BE(off); off += 2;
        if (off + pkLen > payload.length) {
          clearTimeout(cachePending.timeout);
          this._pending.delete(cid + ':cache');
          cachePending.reject(new Error('PRIVACY_CHALLENGE: malformed payload'));
          return;
        }
        const pubKeyRaw = payload.slice(off, off + pkLen);

        // SECURITY: verify pubkey matches the authenticated connection key
        const expectedKey = conn.remotePeer.publicKeyRaw;
        if (pubKeyRaw.length !== expectedKey.length ||
            !timingSafeEqual(pubKeyRaw, expectedKey)) {
          clearTimeout(cachePending.timeout);
          this._pending.delete(cid + ':cache');
          cachePending.reject(new Error('PRIVACY_CHALLENGE: public key mismatch — possible MITM'));
          return;
        }

        // Step 3: send CACHE_REQUEST with ecies(K + our_pubkey, B_pubkey)
        const K = randomBytes(32);  // fresh AES session key
        cachePending._cacheK = K;   // stash for when CACHE_RESPONSE arrives
        const cachePayload = Buffer.concat([K, this.localPeer.publicKeyRaw]);
        const encrypted = eciesEncrypt(cachePayload, conn.remotePeer.publicKey);

        this._send(conn, MessageType.CACHE_REQUEST, cid, encrypted);
        ledger.bytesSent += encrypted.length;
        return;
      }

      // Check for decoy request (keyed as cid + ':decoy')
      const decoyPending = this._pending.get(cid + ':decoy');

      if (decoyPending?.isDecoy) {
        // Decoy Step 2→3: received PRIVACY_CHALLENGE from owner B.
        // Send PRIVACY_RESPONSE (same message type as a real request!) containing
        // ecies(DECOY_FLAG + sizeHint, B_pubkey). On the wire this is completely
        // indistinguishable from a real PRIVACY_RESPONSE — same type byte, same
        // ECIES envelope. Only the owner can tell the difference after decryption.

        // Extract B's public key from the new format:
        // [ Gb_len(2) | Gb | sig_len(2) | sig | pubKey_len(2) | pubKey ]

        // SECURITY: bounds check before parsing
        if (payload.length < 2 + 65 + 2 + 2) {
          clearTimeout(decoyPending.timeout);
          this._pending.delete(cid + ':decoy');
          decoyPending.reject(new Error('PRIVACY_CHALLENGE: payload too short'));
          return;
        }
        let off       = 0;
        const GbLen   = payload.readUInt16BE(off); off += 2;
        off += GbLen; // skip Gb (decoy doesn't use it)
        if (off + 2 > payload.length) {
          clearTimeout(decoyPending.timeout);
          this._pending.delete(cid + ':decoy');
          decoyPending.reject(new Error('PRIVACY_CHALLENGE: malformed payload'));
          return;
        }
        const sigLen  = payload.readUInt16BE(off); off += 2;
        if (off + sigLen + 2 > payload.length) {
          clearTimeout(decoyPending.timeout);
          this._pending.delete(cid + ':decoy');
          decoyPending.reject(new Error('PRIVACY_CHALLENGE: malformed payload'));
          return;
        }
        off += sigLen;  // skip signature (decoy doesn't verify it)
        const pkLen   = payload.readUInt16BE(off); off += 2;
        if (off + pkLen > payload.length) {
          clearTimeout(decoyPending.timeout);
          this._pending.delete(cid + ':decoy');
          decoyPending.reject(new Error('PRIVACY_CHALLENGE: malformed payload'));
          return;
        }
        const pubKeyRaw = payload.slice(off, off + pkLen);

        // SECURITY: verify pubkey matches the authenticated connection
        const expectedKey = conn.remotePeer.publicKeyRaw;
        if (pubKeyRaw.length !== expectedKey.length ||
            !timingSafeEqual(pubKeyRaw, expectedKey)) {
          clearTimeout(decoyPending.timeout);
          this._pending.delete(cid + ':decoy');
          decoyPending.reject(new Error('PRIVACY_CHALLENGE: public key mismatch — possible MITM'));
          return;
        }

        // Build decoy payload: DECOY_FLAG(16) + sizeHint(4)
        // sizeHint tells owner how many random bytes to send back (mimics real file size)
        const sizeHint = Buffer.alloc(4);
        sizeHint.writeUInt32BE(256 + Math.floor(Math.random() * 1024), 0);
        const decoyPayload = Buffer.concat([DECOY_FLAG, sizeHint]);
        const encryptedDecoy = eciesEncrypt(decoyPayload, conn.remotePeer.publicKey);

        // Use PRIVACY_RESPONSE — not DECOY_REQUEST — so the message type byte
        // on the wire is identical to a real request (indistinguishable to observers)
        this._send(conn, MessageType.PRIVACY_RESPONSE, cid, encryptedDecoy);
        ledger.bytesSent += encryptedDecoy.length;
        return;
      }

      if (!pending?.isPrivate) return;

      // SECURITY: bounds check before parsing
      // New format: [ Gb_len(2) | Gb(65) | sig_len(2) | sig | pk_len(2) | pk ]
      if (payload.length < 2 + 65 + 2 + 2) {
        clearTimeout(pending.timeout);
        this._pending.delete(cid);
        pending.reject(new Error('PRIVACY_CHALLENGE: payload too short'));
        return;
      }

      // Unpack: [ Gb_len(2) | Gb | sig_len(2) | sig | pk_len(2) | pk ]
      let off       = 0;
      const GbLen   = payload.readUInt16BE(off); off += 2;
      if (off + GbLen + 4 > payload.length) {
        clearTimeout(pending.timeout);
        this._pending.delete(cid);
        pending.reject(new Error('PRIVACY_CHALLENGE: malformed payload'));
        return;
      }
      const Gb      = payload.slice(off, off + GbLen); off += GbLen;
      const sigLen  = payload.readUInt16BE(off); off += 2;
      if (off + sigLen + 2 > payload.length) {
        clearTimeout(pending.timeout);
        this._pending.delete(cid);
        pending.reject(new Error('PRIVACY_CHALLENGE: malformed payload'));
        return;
      }
      const sig     = payload.slice(off, off + sigLen); off += sigLen;
      const pkLen   = payload.readUInt16BE(off); off += 2;
      if (off + pkLen > payload.length) {
        clearTimeout(pending.timeout);
        this._pending.delete(cid);
        pending.reject(new Error('PRIVACY_CHALLENGE: malformed payload'));
        return;
      }
      const pubKeyRaw = payload.slice(off, off + pkLen);

      // SECURITY: verify the public key in the payload matches the key that was
      // authenticated during the TCP handshake.
      const expectedKey = conn.remotePeer.publicKeyRaw;
      if (pubKeyRaw.length !== expectedKey.length ||
          !timingSafeEqual(pubKeyRaw, expectedKey)) {
        clearTimeout(pending.timeout);
        this._pending.delete(cid);
        pending.reject(new Error('PRIVACY_CHALLENGE: public key mismatch — possible MITM'));
        return;
      }

      // SECURITY: verify the signature over (CID₂ ‖ PKB ‖ Gb)
      // Per paper Figure 2: signature binds CID₂, B's identity, AND the DH parameter
      const expectedCid2Digest = hash(pending.cid1Digest);
      const signedData = Buffer.concat([expectedCid2Digest, pubKeyRaw, Gb]);
      if (!verify(signedData, sig, conn.remotePeer.publicKey)) {
        clearTimeout(pending.timeout);
        this._pending.delete(cid);
        pending.reject(new Error('PRIVACY_CHALLENGE: signature verification failed'));
        return;
      }

      this.emit('handshake:step', { step: 2, total: 4, peerId: conn.remotePeer.id, cid, message: 'PRIVACY_CHALLENGE verified — signature OK' });

      // Step 3: Generate ephemeral DH keypair, compute K_AB, send ECIES_PKB(CID₁ ‖ H(K_AB) ‖ Ga)
      const { privateKey: ga, publicKey: Ga } = generateDHKeyPair();
      const K_AB = computeDHSecret(ga, Gb);
      const HK = createHash('sha256').update(K_AB).digest();

      // Store K_AB for decrypting the response in Step 4
      pending.K = K_AB;

      const packed    = Buffer.concat([pending.cid1Digest, HK, Ga]);
      const encrypted = eciesEncrypt(packed, conn.remotePeer.publicKey);

      this._send(conn, MessageType.PRIVACY_RESPONSE, cid, encrypted);
      this.emit('handshake:step', { step: 3, total: 4, peerId: conn.remotePeer.id, cid, message: 'PRIVACY_RESPONSE sent (CID¹ + H(K_AB) + Ga)' });
      ledger.bytesSent += encrypted.length;
      return;
    }

    // ── Privacy Step 4: requester receives PRIVACY_BLOCK ─────────────────────
    // This handler serves BOTH real privacy responses AND decoy responses.
    // Since decoys now use PRIVACY_BLOCK (not DECOY_BLOCK) for wire
    // indistinguishability, we check for decoy pending entries first.
    if (type === MessageType.PRIVACY_BLOCK) {
      // Check for decoy pending first (keyed as cid + ':decoy')
      const decoyKey = cid + ':decoy';
      const decoyPending = this._pending.get(decoyKey);
      if (decoyPending?.isDecoy) {
        clearTimeout(decoyPending.timeout);
        this._pending.delete(decoyKey);
        // Discard random bits — decoy complete
        decoyPending.resolve();
        return;
      }

      // Real privacy response
      const pending = this._pending.get(cid);
      if (!pending?.isPrivate) return;
      clearTimeout(pending.timeout);
      this._pending.delete(cid);
      ledger.bytesReceived += payload.length;

      try {
        // Decrypt with K
        const decrypted = aesDecrypt(payload, pending.K);

        // Verify integrity: H(decrypted) should equal cid1Digest
        const actualHash = hash(decrypted);
        if (actualHash.length !== pending.cid1Digest.length ||
            !timingSafeEqual(actualHash, pending.cid1Digest)) {
          pending.reject(new Error('PRIVACY_BLOCK: content hash does not match CID¹'));
          return;
        }

        this.emit('handshake:step', { step: 4, total: 4, peerId: conn.remotePeer.id, cid, message: 'PRIVACY_BLOCK received and verified' });
        pending.resolve(decrypted);
      } catch (err) {
        pending.reject(new Error(`PRIVACY_BLOCK decrypt failed: ${err.message}`));
      }
      return;
    }

    // Note: DECOY_BLOCK (0x21) handler removed — decoy responses now arrive as
    // PRIVACY_BLOCK and are handled by the PRIVACY_BLOCK handler above.

    // ── Cache population Step 4: cache node C receives CACHE_RESPONSE ─────────
    if (type === MessageType.CACHE_RESPONSE) {
      const key = cid + ':cache';
      const pending = this._pending.get(key);
      if (!pending?.isCachePopulation) return;

      try {
        // Parse: [ outerLen(4) | outerCipher | auth_len(2) | auth | ownerPubKeyLen(2) | ownerPubKey ]
        let off = 0;
        const outerLen = payload.readUInt32BE(off); off += 4;
        const outerCipher = payload.slice(off, off + outerLen); off += outerLen;
        const authLen = payload.readUInt16BE(off); off += 2;
        const authorization = payload.slice(off, off + authLen); off += authLen;
        const ownerPubKeyLen = payload.readUInt16BE(off); off += 2;
        const ownerPubKeyRaw = payload.slice(off, off + ownerPubKeyLen);

        // Decrypt outer layer with our session key K
        const blob = aesDecrypt(outerCipher, pending._cacheK);

        // blob = innerCipher || timestamp(8)
        // Store entire blob — we cannot decrypt the inner layer (keyed with H(CID¹)).
        // The timestamp is extracted for informational purposes only.
        const tsBuf = blob.slice(blob.length - 8);
        const timestamp = Number(tsBuf.readBigUInt64BE());

        // Store in _cached — keep full blob intact for re-serving
        this._cached.set(cid, {
          encryptedBlob: blob,     // innerCipher || timestamp — we cannot decrypt the inner part
          authorization,         // sign(CID².digest || our_pubkey)
          ownerPubKeyRaw,        // B's public key (SPKI DER)
          timestamp,
        });

        clearTimeout(pending.timeout);
        this._pending.delete(key);
        ledger.bytesReceived += payload.length;
        pending.resolve();

      } catch (err) {
        clearTimeout(pending.timeout);
        this._pending.delete(key);
        pending.reject(new Error(`CACHE_RESPONSE processing failed: ${err.message}`));
      }
      return;
    }

    // ── Cache retrieval Step 6: requester A receives CACHE_CHALLENGE ──────────
    if (type === MessageType.CACHE_CHALLENGE) {
      const key = cid + ':fromcache';
      const pending = this._pending.get(key);
      if (!pending?.isCacheRetrieval) return;

      try {
        // Unpack: [ auth_len(2) | auth | ownerPubKeyLen(2) | ownerPubKey | cachePubKeyLen(2) | cachePubKey ]
        let off = 0;
        const authLen = payload.readUInt16BE(off); off += 2;
        const authorization = payload.slice(off, off + authLen); off += authLen;
        const ownerPubKeyLen = payload.readUInt16BE(off); off += 2;
        const ownerPubKeyRaw = payload.slice(off, off + ownerPubKeyLen); off += ownerPubKeyLen;
        const cachePubKeyLen = payload.readUInt16BE(off); off += 2;
        const cachePubKeyRaw = payload.slice(off, off + cachePubKeyLen);

        // Reconstruct owner's public key from DER bytes
        const ownerPubKey = createPublicKey({ key: ownerPubKeyRaw, type: 'spki', format: 'der' });

        // SECURITY: verify authorization — owner B signed (CID².digest || C_pubkey)
        // Requester A derives CID² from its known CID¹: CID² = H(H(OBJ)) = H(cid1Digest)
        const expectedCid2Digest = hash(pending.cid1Digest);
        const authData = Buffer.concat([expectedCid2Digest, cachePubKeyRaw]);
        if (!verify(authData, authorization, ownerPubKey)) {
          clearTimeout(pending.timeout);
          this._pending.delete(key);
          pending.reject(new Error('CACHE_CHALLENGE: authorization signature verification failed'));
          return;
        }

        // SECURITY: verify cache node's public key matches authenticated connection
        const expectedCacheKey = conn.remotePeer.publicKeyRaw;
        if (cachePubKeyRaw.length !== expectedCacheKey.length ||
            !timingSafeEqual(cachePubKeyRaw, expectedCacheKey)) {
          clearTimeout(pending.timeout);
          this._pending.delete(key);
          pending.reject(new Error('CACHE_CHALLENGE: cache node public key mismatch — possible MITM'));
          return;
        }

        // Step 7: send ecies(K, C_pubkey)
        const encrypted = eciesEncrypt(pending.K, conn.remotePeer.publicKey);
        this._send(conn, MessageType.CACHE_REQUEST, cid, encrypted);
        ledger.bytesSent += encrypted.length;

      } catch (err) {
        clearTimeout(pending.timeout);
        this._pending.delete(key);
        pending.reject(new Error(`CACHE_CHALLENGE processing failed: ${err.message}`));
      }
      return;
    }

    // ── Cache retrieval Step 8: requester A receives CACHE_BLOCK ──────────────
    if (type === MessageType.CACHE_BLOCK) {
      const key = cid + ':fromcache';
      const pending = this._pending.get(key);
      if (!pending?.isCacheRetrieval) return;
      clearTimeout(pending.timeout);
      this._pending.delete(key);
      ledger.bytesReceived += payload.length;

      try {
        // Decrypt outer layer with our session key K
        const blob = aesDecrypt(payload, pending.K);

        // blob = innerCipher || timestamp(8)
        // innerCipher = AES(OBJ, H(CID¹))
        const innerCipher = blob.slice(0, blob.length - 8);
        const tsBuf = blob.slice(blob.length - 8);
        const timestamp = Number(tsBuf.readBigUInt64BE());

        // Verify the cached object has not expired
        if (Date.now() - timestamp > CACHE_TTL_MS) {
          pending.reject(new Error('CACHE_BLOCK: cached object has expired'));
          return;
        }

        // Decrypt inner layer with H(CID¹) = cid1Digest (32 bytes, used as AES key)
        const decrypted = aesDecrypt(innerCipher, pending.cid1Digest);

        // Verify integrity: H(decrypted) should equal cid1Digest
        const actualHash = hash(decrypted);
        if (actualHash.length !== pending.cid1Digest.length ||
            !timingSafeEqual(actualHash, pending.cid1Digest)) {
          pending.reject(new Error('CACHE_BLOCK: content hash does not match CID¹'));
          return;
        }

        pending.resolve(decrypted);
      } catch (err) {
        pending.reject(new Error(`CACHE_BLOCK decrypt failed: ${err.message}`));
      }
      return;
    }
  }

  // ── Ledger / incentive ────────────────────────────────────────────────────

  /**
   * _shouldServe(ledger) → boolean
   *
   * Decides whether to serve a block to this peer based on their debt ratio.
   *
   * SWAP POINT — incentive strategy:
   *   Current rule: serve if debt ratio < 10 (peer has received < 10x what they sent).
   *   Replace this method with a sigmoid function, token bucket, or any other
   *   strategy to tune the incentive behaviour.
   *
   * @param {Ledger} ledger
   * @returns {boolean}
   */
  _shouldServe(ledger) {
    return ledger.debtRatio() < 10;
  }

  _ledger(peerId) {
    if (!this.ledgers.has(peerId)) {
      this.ledgers.set(peerId, new Ledger(peerId));
    }
    return this.ledgers.get(peerId);
  }

  // ── Wire helpers ──────────────────────────────────────────────────────────

  _send(conn, type, cid, payload = Buffer.alloc(0)) {
    const msg = encode(type, cid, payload);
    conn.sendMessage(BITSWAP_PROTO, msg);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  /**
   * ledgerFor(peerId) → Ledger
   * @param {string} peerId
   */
  ledgerFor(peerId) {
    return this.ledgers.get(peerId) || new Ledger(peerId);
  }

  /**
   * hasCached(cid3String) → boolean
   * @param {string} cid3String
   */
  hasCached(cid3String) {
    return this._cached.has(cid3String);
  }
}
