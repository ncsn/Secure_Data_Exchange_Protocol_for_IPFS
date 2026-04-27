/**
 * peer.js — Peer identity
 *
 * A Peer ID is the cryptographic identity of a node in the network.
 * It is derived from the node's public key so that:
 *   - Every peer has a globally unique, verifiable identity
 *   - You can verify that a message came from a claimed peer
 *   - Peer IDs are stable across IP address changes
 *
 * ── Peer ID derivation ────────────────────────────────────────────────────────
 *
 *   PeerID = base58( multihash( SHA-256( SPKI_DER(publicKey) ) ) )
 *
 *   This matches the libp2p spec for Ed25519/ECDSA keys.
 *
 * ── Multiaddr ─────────────────────────────────────────────────────────────────
 *
 *   A multiaddr is a self-describing network address. Format:
 *     /ip4/<address>/tcp/<port>/p2p/<peerID>
 *
 *   Examples:
 *     /ip4/127.0.0.1/tcp/4001/p2p/QmAbc...
 *     /ip4/192.168.1.5/tcp/4001/p2p/QmDef...
 *
 *   SWAP POINT — transport:
 *     Real libp2p supports /ip6, /dns4, /ws, /wss, /quic, /webrtc.
 *     This implementation only handles /ip4/tcp. To add more transports,
 *     extend the Multiaddr.parse() method with additional protocol handlers.
 */

import { createHash }       from 'crypto';
import { generateKeyPair }  from './crypto.js';

// ── Multiaddr ─────────────────────────────────────────────────────────────────

export class Multiaddr {
  /**
   * @param {string} ip      — IPv4 address string
   * @param {number} port    — TCP port number
   * @param {string} [peerId] — optional peer ID string
   */
  constructor(ip, port, peerId = null) {
    this.ip     = ip;
    this.port   = port;
    this.peerId = peerId;
  }

  /**
   * toString() → string
   * Returns the canonical multiaddr string representation.
   *
   * @returns {string}
   */
  toString() {
    let addr = `/ip4/${this.ip}/tcp/${this.port}`;
    if (this.peerId) addr += `/p2p/${this.peerId}`;
    return addr;
  }

  /**
   * parse(str) → Multiaddr
   *
   * Parses a multiaddr string like '/ip4/127.0.0.1/tcp/4001/p2p/QmAbc...'
   *
   * SWAP POINT: Extend this to handle /ip6, /dns4, /ws, /quic etc.
   *
   * @param {string} str
   * @returns {Multiaddr}
   */
  static parse(str) {
    // Expected format: /ip4/<ip>/tcp/<port>[/p2p/<peerId>]
    const match = str.match(/^\/ip4\/([\d.]+)\/tcp\/(\d+)(?:\/p2p\/([A-Za-z0-9]+))?/);
    if (!match) {
      throw new Error(`Cannot parse multiaddr: ${str}`);
    }
    return new Multiaddr(match[1], parseInt(match[2], 10), match[3] || null);
  }

  toJSON() { return this.toString(); }
}

// ── PeerId ────────────────────────────────────────────────────────────────────

export class PeerId {
  /**
   * @param {string}    id           — base58-like hex string identifying this peer
   * @param {KeyObject} publicKey    — Node.js public key object
   * @param {KeyObject} [privateKey] — Node.js private key (only on the local peer)
   * @param {Buffer}    publicKeyRaw — raw DER-encoded public key bytes
   */
  constructor(id, publicKey, privateKey, publicKeyRaw) {
    this.id          = id;
    this.publicKey   = publicKey;
    this.privateKey  = privateKey  || null;
    this.publicKeyRaw = publicKeyRaw;
  }

  /**
   * create() → PeerId
   *
   * Generates a fresh peer identity with a new key pair.
   * Call this once when a node starts for the first time, then persist
   * the key pair to disk so the peer ID survives restarts.
   *
   * SWAP POINT — key persistence:
   *   In production, save privateKey.export({ type:'pkcs8', format:'pem' })
   *   to a keystore file and load it on startup instead of generating a new one.
   *
   * @returns {PeerId}
   */
  static create() {
    const { privateKey, publicKey, publicKeyRaw } = generateKeyPair();
    const id = PeerId._deriveId(publicKeyRaw);
    return new PeerId(id, publicKey, privateKey, publicKeyRaw);
  }

  /**
   * fromPublicKey(publicKey, publicKeyRaw) → PeerId
   *
   * Reconstructs a PeerId for a remote peer from their public key.
   * Used when a peer announces itself over the network.
   *
   * @param {KeyObject} publicKey
   * @param {Buffer}    publicKeyRaw
   * @returns {PeerId}
   */
  static fromPublicKey(publicKey, publicKeyRaw) {
    const id = PeerId._deriveId(publicKeyRaw);
    return new PeerId(id, publicKey, null, publicKeyRaw);
  }

  /**
   * _deriveId(publicKeyRaw) → string
   *
   * Derives the peer ID string from raw public key bytes:
   *   SHA-256(publicKeyRaw) → hex string (first 20 bytes, like a fingerprint)
   *
   * SWAP POINT — ID format:
   *   Real libp2p uses multihash + base58btc encoding (starts with 'Qm').
   *   We use a simple hex fingerprint here to avoid adding a base58 dependency.
   *   To switch: apply toMultihash() from cid/crypto.js then base58-encode.
   */
  static _deriveId(publicKeyRaw) {
    return createHash('sha256')
      .update(publicKeyRaw)
      .digest('hex')
      .slice(0, 40); // 40 hex chars = 20 bytes, enough for a unique fingerprint
  }

  toString() { return this.id; }
  toJSON()   { return this.id; }
}
