/**
 * kademlia.js — Kademlia routing table and XOR distance metric
 *
 * Kademlia organises peers in a 256-bit XOR metric space.
 * Every peer and every key (CID) maps to a point in this space.
 * "Closeness" is defined by the XOR of two IDs — not geographic distance.
 *
 * ── XOR distance ─────────────────────────────────────────────────────────────
 *
 *   distance(A, B) = A XOR B
 *
 *   Properties that make XOR useful as a metric:
 *     - d(A, A) = 0               (identity)
 *     - d(A, B) = d(B, A)         (symmetry)
 *     - d(A, C) ≤ d(A,B) + d(B,C) (triangle inequality)
 *
 *   The "closest" peer to a key is the one with the smallest XOR value.
 *
 * ── k-buckets ────────────────────────────────────────────────────────────────
 *
 *   Each peer maintains 256 buckets, one per bit position.
 *   Bucket i holds peers whose ID differs from ours in bit position i
 *   (i.e. the most-significant differing bit is at position i).
 *
 *   Each bucket holds at most K_BUCKET_SIZE peers (default: 20).
 *   When a bucket is full and a new peer arrives:
 *     - Ping the least-recently-seen peer in the bucket
 *     - If it responds → keep it, discard the new peer
 *     - If it doesn't  → replace it with the new peer
 *
 *   This gives the routing table a preference for long-lived peers
 *   (they are more likely to still be online).
 *
 *   SWAP POINT — bucket size:
 *     Change K_BUCKET_SIZE below. Real Kademlia uses k=20.
 *     Smaller k → less memory, less redundancy.
 *     Larger k  → more redundancy, better lookup success rate.
 *
 * ── Lookup algorithm ─────────────────────────────────────────────────────────
 *
 *   findClosest(targetId, count) returns the `count` locally-known peers
 *   closest to targetId by XOR distance.
 *
 *   A full iterative lookup (used in dht.js) repeatedly calls findClosest
 *   on progressively closer peers until convergence.
 */

import { createHash } from 'crypto';

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Maximum number of peers stored per k-bucket.
 * SWAP THIS to change redundancy vs. memory trade-off.
 */
export const K_BUCKET_SIZE = 20;

/**
 * Number of parallel lookups during iterative find (alpha parameter).
 * Real Kademlia uses alpha=3.
 * SWAP THIS to tune lookup speed vs. network load.
 */
export const ALPHA = 3;

// ── ID normalisation ──────────────────────────────────────────────────────────

/**
 * toId(input) → Buffer (32 bytes)
 *
 * Normalises any peer ID string or CID string to a 32-byte Buffer
 * for XOR distance calculations.
 *
 * We SHA-256 hash the input string so all IDs live in the same
 * 256-bit space regardless of their original format.
 *
 * @param {string|Buffer} input
 * @returns {Buffer} 32-byte ID
 */
export function toId(input) {
  if (Buffer.isBuffer(input) && input.length === 32) return input;
  return createHash('sha256').update(input.toString()).digest();
}

// ── XOR distance ──────────────────────────────────────────────────────────────

/**
 * xorDistance(a, b) → Buffer (32 bytes)
 *
 * Computes the XOR distance between two 32-byte IDs.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {Buffer}
 */
export function xorDistance(a, b) {
  const result = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) result[i] = a[i] ^ b[i];
  return result;
}

/**
 * compareDistance(a, b, target) → -1 | 0 | 1
 *
 * Compares which of a or b is closer to target in XOR space.
 * Returns -1 if a is closer, 1 if b is closer, 0 if equal.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {Buffer} target
 * @returns {number}
 */
export function compareDistance(a, b, target) {
  const da = xorDistance(a, target);
  const db = xorDistance(b, target);
  return da.compare(db); // Buffer.compare: -1 if da < db
}

/**
 * bucketIndex(localId, peerId) → number (0–255)
 *
 * Returns which k-bucket a peer belongs in, based on the position
 * of the most significant differing bit between localId and peerId.
 *
 * @param {Buffer} localId
 * @param {Buffer} peerId
 * @returns {number} bucket index 0–255
 */
export function bucketIndex(localId, peerId) {
  const dist = xorDistance(localId, peerId);
  // Find the first non-zero byte
  for (let i = 0; i < 32; i++) {
    if (dist[i] !== 0) {
      // Find the most significant set bit in this byte
      let bit = 7;
      let byte = dist[i];
      while (byte > 1) { byte >>= 1; bit--; }
      return i * 8 + (7 - bit);
    }
  }
  return 255; // identical IDs (shouldn't happen for distinct peers)
}

// ── RoutingTable ──────────────────────────────────────────────────────────────

/**
 * RoutingTable — stores known peers organised by XOR distance
 *
 * Each entry in a bucket is a PeerInfo object:
 *   { id: Buffer(32), peerId: string, ip: string, port: number, lastSeen: number }
 */
export class RoutingTable {
  /**
   * @param {string|Buffer} localId — this node's peer ID (string or 32-byte Buffer)
   */
  constructor(localId) {
    this.localId = toId(localId);
    // 256 buckets, each an array of PeerInfo (most recently seen last)
    this.buckets = Array.from({ length: 256 }, () => []);
  }

  /**
   * add(peerInfo) — add or refresh a peer in the routing table
   *
   * If the peer is already known, move it to the end of its bucket (most recently seen).
   * If the bucket is full, drop the least recently seen entry to make room.
   * (A production implementation would ping the LRS entry first.)
   *
   * @param {{ peerId: string, ip: string, port: number }} peerInfo
   */
  add(peerInfo) {
    const id  = toId(peerInfo.peerId);

    // Don't add ourselves
    if (id.equals(this.localId)) return;

    const idx    = bucketIndex(this.localId, id);
    const bucket = this.buckets[idx];

    // Refresh if already present
    const existing = bucket.findIndex(p => p.peerId === peerInfo.peerId);
    if (existing !== -1) {
      bucket.splice(existing, 1);
    } else if (bucket.length >= K_BUCKET_SIZE) {
      // Bucket full — evict least recently seen (index 0)
      // SWAP POINT: ping LRS entry before evicting (real Kademlia behaviour)
      bucket.shift();
    }

    bucket.push({ ...peerInfo, id, lastSeen: Date.now() });
  }

  /**
   * remove(peerId) — remove a peer from the routing table
   *
   * @param {string} peerId
   */
  remove(peerId) {
    const id  = toId(peerId);
    const idx = bucketIndex(this.localId, id);
    this.buckets[idx] = this.buckets[idx].filter(p => p.peerId !== peerId);
  }

  /**
   * findClosest(targetId, count) → PeerInfo[]
   *
   * Returns the `count` peers closest to targetId by XOR distance,
   * sorted nearest first.
   *
   * This is the core routing table query. The iterative lookup in dht.js
   * calls this repeatedly on progressively closer peers.
   *
   * @param {string|Buffer} targetId
   * @param {number}        [count=K_BUCKET_SIZE]
   * @returns {Array<{peerId:string, ip:string, port:number, id:Buffer}>}
   */
  findClosest(targetId, count = K_BUCKET_SIZE) {
    const target = toId(targetId);

    // Collect all known peers
    const all = this.buckets.flat();

    // Sort by XOR distance to target
    all.sort((a, b) => compareDistance(a.id, b.id, target));

    return all.slice(0, count);
  }

  /**
   * size() → number — total number of known peers
   */
  size() {
    return this.buckets.reduce((sum, b) => sum + b.length, 0);
  }

  /**
   * all() → PeerInfo[] — all known peers (unsorted)
   */
  all() {
    return this.buckets.flat();
  }
}
