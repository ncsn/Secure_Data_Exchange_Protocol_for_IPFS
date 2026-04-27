/**
 * chunker.js — Split a Buffer into fixed-size chunks
 *
 * This is the first step in adding a file to the DAG.
 * Large files cannot be stored as a single block — they must be split
 * so that:
 *   - Individual blocks stay small enough to transfer efficiently over Bitswap
 *   - Identical regions of different files can be deduplicated (same chunk → same CID)
 *   - Partial file retrieval is possible (fetch only the chunks you need)
 *
 * Current strategy: fixed-size chunking (every chunk is exactly CHUNK_SIZE
 * bytes, except possibly the last one).
 *
 * SWAP POINT — chunking strategy:
 *   The chunking strategy directly affects deduplication efficiency.
 *   Fixed-size chunking is simple but poor at deduplication across edits
 *   (inserting one byte shifts all subsequent chunk boundaries).
 *
 *   Alternatives to implement here later:
 *     - Rabin fingerprinting (content-defined chunking) — much better dedup,
 *       used by the real IPFS. Boundaries are placed where a rolling hash
 *       of the content matches a pattern.
 *     - Buzhash CDC — similar to Rabin but faster in practice.
 *     - Fixed-size with overlap — simple improvement for some use cases.
 *
 *   To switch strategy: replace the chunk() function body below.
 *   The rest of the DAG and block store code does not care how chunks
 *   are produced — it only receives an array of Buffers.
 *
 * SWAP POINT — chunk size:
 *   256 KB (262144 bytes) is the IPFS default.
 *   Smaller chunks → more blocks, more DHT entries, better dedup granularity.
 *   Larger chunks → fewer blocks, less overhead, worse dedup.
 */

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Maximum size of a single chunk in bytes.
 * SWAP THIS to tune the block size.
 * IPFS default: 262144 (256 KB)
 */
export const CHUNK_SIZE = 262144; // 256 KB

// ── Chunker ───────────────────────────────────────────────────────────────────

/**
 * chunk(data) → Buffer[]
 *
 * Splits a Buffer into an array of chunks, each at most CHUNK_SIZE bytes.
 * The last chunk may be smaller.
 *
 * Example:
 *   chunk(700 KB file) → [256 KB, 256 KB, 188 KB]
 *
 * @param {Buffer} data — full file content
 * @returns {Buffer[]} ordered array of chunks
 */
export function chunk(data) {
  if (data.length === 0) return [Buffer.alloc(0)];

  const chunks = [];
  let offset = 0;

  while (offset < data.length) {
    const end = Math.min(offset + CHUNK_SIZE, data.length);
    // slice() returns a view (no copy) — efficient for large files
    chunks.push(data.slice(offset, end));
    offset = end;
  }

  return chunks;
}
