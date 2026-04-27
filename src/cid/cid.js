/**
 * cid.js — Content Identifier (CID) generation
 *
 * A CID is a self-describing, content-addressed identifier.
 * It encodes:
 *   1. The CID version
 *   2. A multicodec — what kind of data was hashed
 *   3. A multihash — which algorithm produced the hash + the digest itself
 *
 * This module extends standard CID generation to produce the three CIDs
 * required by the triple-hash privacy protocol:
 *
 *   CID¹  =  CID of  H(OBJ)          — standard CID, published to DHT
 *   CID²  =  CID of  H(H(OBJ))       — kept SECRET by the owner
 *   CID³  =  CID of  H(H(H(OBJ)))    — published to DHT alongside CID¹
 *
 * ── CID binary layout ──────────────────────────────────────────────────────
 *
 *   [ varint(version) | varint(codec) | multihash ]
 *
 *   multihash = [ varint(hash_code) | varint(digest_length) | digest ]
 *
 * ── Encoding ───────────────────────────────────────────────────────────────
 *
 *   Binary CIDs are base32-encoded (lowercase, no padding) for display.
 *   This matches the CIDv1 convention used by IPFS.
 *
 *   SWAP POINT: To use base58 (CIDv0 style) or base64url, change
 *   the encode() / decode() helpers in this file.
 *
 * ── Multicodec values ──────────────────────────────────────────────────────
 *
 *   0x55  raw         — plain bytes (used here for OBJ content)
 *   0x70  dag-pb      — Protocol Buffers DAG node (used by UnixFS later)
 *   0x0129 dag-json   — JSON DAG node
 *
 *   SWAP POINT: Change MULTICODEC below when working with DAG nodes
 *   (Phase 2) instead of raw content.
 *   Full table: https://github.com/multiformats/multicodec/blob/master/table.csv
 */

import { hash, toMultihash } from './crypto.js';

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * CID version number stored in every CID prefix.
 * 1 = CIDv1 (recommended, supports multicodec).
 * SWAP THIS if you ever need CIDv0 compatibility (version 0 = legacy SHA2-256 only).
 */
const CID_VERSION = 1;

/**
 * Multicodec identifying the type of content being addressed.
 * 0x55 = raw bytes.
 * SWAP THIS to 0x70 (dag-pb) when you start encoding UnixFS DAG nodes in Phase 2.
 */
const MULTICODEC = 0x55; // raw

// ── CID class ─────────────────────────────────────────────────────────────────

export class CID {
  /**
   * @param {Buffer} digest   — raw hash digest (not multihash-wrapped)
   * @param {number} version  — CID version (default: CID_VERSION)
   * @param {number} codec    — multicodec value (default: MULTICODEC)
   */
  constructor(digest, version = CID_VERSION, codec = MULTICODEC) {
    this.version  = version;
    this.codec    = codec;
    this.digest   = digest;                  // raw hash bytes
    this.multihash = toMultihash(digest);    // self-describing hash
    this.bytes    = this._encode();          // full binary CID
    this.string   = this._toBase32();        // human-readable CID string
  }

  /**
   * _encode() → Buffer
   *
   * Serialises the CID into its binary representation:
   *   [ varint(version) | varint(codec) | multihash ]
   */
  _encode() {
    const version = encodeVarint(this.version);
    const codec   = encodeVarint(this.codec);
    return Buffer.concat([version, codec, this.multihash]);
  }

  /**
   * _toBase32() → string
   *
   * Base32-encodes the binary CID (lowercase, RFC 4648, no padding).
   * Prefixed with 'b' — the multibase prefix for base32lower.
   *
   * SWAP POINT: Replace this method body to use a different encoding.
   *   Base58btc  → prefix 'z', use the bs58 npm package
   *   Base64url  → prefix 'u', use Buffer.toString('base64url')
   */
  _toBase32() {
    return 'b' + base32Encode(this.bytes);
  }

  toString() { return this.string; }
  toJSON()   { return this.string; }
}

// ── Triple-hash factory ───────────────────────────────────────────────────────

/**
 * tripleHash(data) → { cid1, cid2, cid3, h1, h2, h3 }
 *
 * Given raw object data, produces the three CIDs required by the
 * triple-hash privacy protocol:
 *
 *   h1 = H(data)        → CID¹  (published to DHT)
 *   h2 = H(h1)          → CID²  (SECRET — never share this)
 *   h3 = H(h2)          → CID³  (published to DHT)
 *
 * The raw digest values (h1, h2, h3) are also returned because:
 *   - h1 is used as the AES encryption key in the caching protocol
 *   - h2 is used as a challenge in the Bitswap authentication handshake
 *
 * @param {Buffer|string} data — raw object content
 * @returns {{ cid1: CID, cid2: CID, cid3: CID, h1: Buffer, h2: Buffer, h3: Buffer }}
 */
export function tripleHash(data) {
  // Convert strings to Buffer so hashing is consistent
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

  const h1 = hash(buf);        // H(OBJ)
  const h2 = hash(h1);         // H(H(OBJ))
  const h3 = hash(h2);         // H(H(H(OBJ)))

  return {
    cid1: new CID(h1),         // published — standard address of the object
    cid2: new CID(h2),         // SECRET    — proof of ownership
    cid3: new CID(h3),         // published — privacy-preserving lookup key
    h1,                        // raw digest — used as AES key in caching
    h2,                        // raw digest — used as challenge in Bitswap auth
    h3,                        // raw digest — (informational)
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * cidFromString(str) → CID
 *
 * Reconstructs a CID from its base32 string representation.
 * Useful when you receive a CID over the network as a string.
 *
 * SWAP POINT: If you change the encoding in _toBase32(), update the
 * decoder here to match.
 *
 * @param {string} str — base32-encoded CID string (starts with 'b')
 * @returns {CID}
 */
export function cidFromString(str) {
  if (!str.startsWith('b')) {
    throw new Error(`Expected base32 CID starting with 'b', got: ${str[0]}`);
  }
  const bytes = base32Decode(str.slice(1));

  // Parse version and codec varints from the front
  const { value: version, bytesRead: vBytes } = decodeVarint(bytes, 0);
  const { value: codec,   bytesRead: cBytes } = decodeVarint(bytes, vBytes);
  const multihash = bytes.slice(vBytes + cBytes);

  // Digest starts after the two varint prefixes inside the multihash
  const { bytesRead: hBytes } = decodeVarint(multihash, 0); // hash code
  const { bytesRead: lBytes } = decodeVarint(multihash, hBytes); // length
  const digest = multihash.slice(hBytes + lBytes);

  return new CID(digest, version, codec);
}

// ── Varint helpers ────────────────────────────────────────────────────────────

function encodeVarint(n) {
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

function decodeVarint(buf, offset) {
  let value = 0, shift = 0, bytesRead = 0;
  while (true) {
    const byte = buf[offset + bytesRead];
    value |= (byte & 0x7f) << shift;
    bytesRead++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, bytesRead };
}

// ── Base32 (RFC 4648 lowercase, no padding) ───────────────────────────────────
// Built-in — no npm dependency needed.
// SWAP POINT: Replace these two functions if you choose a different encoding.

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Encode(buf) {
  let bits = 0, value = 0, output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  const lookup = Object.fromEntries([...BASE32_ALPHABET].map((c, i) => [c, i]));
  let bits = 0, value = 0;
  const output = [];
  for (const char of str.toLowerCase()) {
    if (!(char in lookup)) continue; // skip unknown chars
    value = (value << 5) | lookup[char];
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
