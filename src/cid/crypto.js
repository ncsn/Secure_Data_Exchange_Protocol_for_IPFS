/**
 * crypto.js — Hashing primitives for CID generation
 *
 * All cryptographic choices are isolated here so you can swap algorithms
 * in one place without touching any other module.
 *
 * Current choices:
 *   - Hash algorithm : SHA-256  (Node.js built-in, no dependencies)
 *   - Output length  : 32 bytes (256 bits)
 *   - Output format  : Buffer
 *
 * To switch to a different hash (e.g. SHA3-256, BLAKE2b):
 *   1. Change the HASH_ALGORITHM constant below.
 *   2. Update HASH_LENGTH_BYTES to match the new digest size.
 *   3. Update MULTIHASH_CODE to the correct multihash varint code:
 *        SHA2-256  → 0x12
 *        SHA3-256  → 0x16
 *        BLAKE2b   → 0xb220
 *      Full list: https://github.com/multiformats/multicodec/blob/master/table.csv
 */

import { createHash } from 'crypto';

// ── Algorithm configuration ───────────────────────────────────────────────────

/**
 * Name of the hash algorithm passed to Node's crypto.createHash().
 * SWAP THIS to change the hash function used everywhere.
 */
const HASH_ALGORITHM = 'sha256';

/**
 * Byte length of the digest produced by HASH_ALGORITHM.
 * Must be updated if you change HASH_ALGORITHM.
 */
const HASH_LENGTH_BYTES = 32;

/**
 * Multihash varint code identifying the hash algorithm.
 * This is stored inside CIDs so they are self-describing.
 * SWAP THIS when changing HASH_ALGORITHM.
 */
const MULTIHASH_CODE = 0x12; // SHA2-256

// ── Core hash function ────────────────────────────────────────────────────────

/**
 * hash(data) → Buffer
 *
 * Hashes arbitrary data and returns the raw digest as a Buffer.
 *
 * @param {Buffer|string} data — content to hash
 * @returns {Buffer} raw digest
 */
export function hash(data) {
  return createHash(HASH_ALGORITHM).update(data).digest();
}

// ── Multihash encoding ────────────────────────────────────────────────────────

/**
 * toMultihash(digest) → Buffer
 *
 * Wraps a raw hash digest in the multihash format:
 *
 *   [ varint(hash_code) | varint(digest_length) | digest_bytes ]
 *
 * This makes the hash self-describing — any reader knows which
 * algorithm was used without extra context.
 *
 * @param {Buffer} digest — raw hash bytes
 * @returns {Buffer} multihash-encoded bytes
 */
export function toMultihash(digest) {
  // Encode the algorithm code and digest length as varints.
  // For codes/lengths < 128 a varint is just the byte itself.
  // If you switch to an algorithm with code > 127 (e.g. BLAKE2b = 0xb220)
  // you will need a proper varint encoder here.
  const code   = encodeVarint(MULTIHASH_CODE);
  const length = encodeVarint(HASH_LENGTH_BYTES);
  return Buffer.concat([code, length, digest]);
}

/**
 * encodeVarint(n) → Buffer
 *
 * Encodes an unsigned integer as a multibyte varint (little-endian base-128).
 * Values 0–127 encode as a single byte.
 * Values ≥ 128 use multiple bytes (each byte's MSB signals continuation).
 *
 * @param {number} n — non-negative integer
 * @returns {Buffer}
 */
function encodeVarint(n) {
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80); // lower 7 bits, set continuation bit
    n >>>= 7;
  }
  bytes.push(n & 0x7f); // final byte, no continuation bit
  return Buffer.from(bytes);
}

export { HASH_ALGORITHM, HASH_LENGTH_BYTES, MULTIHASH_CODE };
