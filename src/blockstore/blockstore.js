/**
 * blockstore.js — Filesystem-based block store
 *
 * The block store is the local database of a node.
 * Every block this node has ever added or fetched from the network lives here,
 * keyed by its CID. It is the single source of truth for local content.
 *
 * ── Storage layout on disk ───────────────────────────────────────────────────
 *
 *   <rootDir>/
 *     blocks/
 *       bafkreiabc...   ← raw bytes of one block (filename = CID string)
 *       bafkreidef...
 *       ...
 *     pins.json         ← { "<cid>": "recursive" | "direct" | "indirect" }
 *
 * SWAP POINT — storage backend:
 *   We use the filesystem (one file per block) because it requires zero
 *   dependencies and every block is trivially inspectable with a text editor.
 *   For production you would replace the _read/_write/_exists/_delete helpers
 *   at the bottom of this file with a LevelDB or SQLite backend.
 *   The public API (put/get/has/delete/pin/gc) stays identical.
 *
 * ── Pinning ──────────────────────────────────────────────────────────────────
 *
 *   Blocks are stored but not automatically kept forever. Garbage collection
 *   (gc) removes any block that is not reachable from a pinned root.
 *
 *   Pin types:
 *     recursive — pin this CID and every block reachable from it (whole tree).
 *                 Use this when adding a file you want to keep.
 *     direct    — pin exactly this one block, ignore its links.
 *                 Rarely used directly; useful for individual raw blocks.
 *     indirect  — set automatically on every block reachable from a recursive
 *                 pin. Never set manually.
 *
 *   Rule: a block is safe from gc if it has ANY pin entry (recursive, direct,
 *   or indirect).
 *
 * ── Integration with DAGNode ─────────────────────────────────────────────────
 *
 *   The block store stores serialised DAGNode bytes, not DAGNode objects.
 *   Use DAGNode.serialize() before put() and DAGNode.deserialize() after get().
 *   This keeps the block store storage-agnostic — it only deals in Buffers.
 */

import fs   from 'fs';
import path from 'path';

// ── BlockStore class ──────────────────────────────────────────────────────────

export class BlockStore {
  /**
   * @param {string} rootDir — directory where blocks/ and pins.json are stored
   */
  constructor(rootDir) {
    this.rootDir   = rootDir;
    this.blocksDir = path.join(rootDir, 'blocks');
    this.pinsFile  = path.join(rootDir, 'pins.json');

    // Initialise directory structure if it doesn't exist
    fs.mkdirSync(this.blocksDir, { recursive: true });

    // Load pin state from disk, or start with an empty map
    // pins: Map<cidString, 'recursive' | 'direct' | 'indirect'>
    this.pins = this._loadPins();
  }

  // ── Core CRUD ───────────────────────────────────────────────────────────────

  /**
   * put(cidString, bytes) — store a raw block
   *
   * Idempotent: calling put() with the same CID twice is safe.
   * Since blocks are content-addressed, same CID always means same bytes.
   *
   * @param {string} cidString — CID.string of the block
   * @param {Buffer} bytes     — raw serialised block data
   */
  put(cidString, bytes) {
    if (!this.has(cidString)) {
      this._write(cidString, bytes);
    }
  }

  /**
   * get(cidString) → Buffer
   *
   * Retrieves raw block bytes. Throws if the block is not found.
   *
   * @param {string} cidString
   * @returns {Buffer}
   */
  get(cidString) {
    if (!this.has(cidString)) {
      throw new Error(`Block not found: ${cidString}`);
    }
    return this._read(cidString);
  }

  /**
   * has(cidString) → boolean
   *
   * Returns true if the block exists locally.
   *
   * @param {string} cidString
   * @returns {boolean}
   */
  has(cidString) {
    return this._exists(cidString);
  }

  /**
   * delete(cidString) — remove a block from disk
   *
   * Does NOT check pins — use gc() for safe pin-aware deletion.
   * This is a low-level operation; prefer gc() in normal usage.
   *
   * @param {string} cidString
   */
  delete(cidString) {
    if (this.has(cidString)) {
      this._delete(cidString);
    }
  }

  /**
   * list() → string[]
   *
   * Returns all CID strings currently stored in the block store.
   *
   * @returns {string[]}
   */
  list() {
    return fs.readdirSync(this.blocksDir);
  }

  // ── Pinning ─────────────────────────────────────────────────────────────────

  /**
   * pin(cidString, type, blocks) — protect a block (and optionally its tree) from gc
   *
   * @param {string}                        cidString — root CID to pin
   * @param {'recursive'|'direct'}          type      — pin type
   * @param {Map<string,import('../dag/node.js').DAGNode>|null} blocks
   *   — block map from importData(), required for recursive pinning so we can
   *     walk the tree and mark all descendants as indirect.
   *     Pass null for direct pinning.
   */
  pin(cidString, type, blocks = null) {
    if (type === 'recursive') {
      // Mark the root as recursive
      this.pins.set(cidString, 'recursive');

      // Mark every reachable block as indirect
      if (blocks) {
        for (const [cid, node] of blocks) {
          if (cid !== cidString && !this.pins.has(cid)) {
            this.pins.set(cid, 'indirect');
          }
        }
      }
    } else if (type === 'direct') {
      this.pins.set(cidString, 'direct');
    } else {
      throw new Error(`Unknown pin type: ${type}. Use 'recursive' or 'direct'.`);
    }

    this._savePins();
  }

  /**
   * unpin(cidString) — remove a pin entry
   *
   * This does NOT delete the block immediately. Run gc() afterwards to
   * reclaim space. Indirect pins that were set by a recursive pin are
   * NOT automatically removed here — gc() handles that cleanly.
   *
   * @param {string} cidString
   */
  unpin(cidString) {
    if (!this.pins.has(cidString)) {
      throw new Error(`Not pinned: ${cidString}`);
    }
    this.pins.delete(cidString);
    this._savePins();
  }

  /**
   * isPinned(cidString) → boolean
   *
   * @param {string} cidString
   * @returns {boolean}
   */
  isPinned(cidString) {
    return this.pins.has(cidString);
  }

  /**
   * listPins() → Array<{ cid: string, type: string }>
   *
   * @returns {Array<{cid: string, type: string}>}
   */
  listPins() {
    return [...this.pins.entries()].map(([cid, type]) => ({ cid, type }));
  }

  // ── Garbage Collection ───────────────────────────────────────────────────────

  /**
   * gc() → string[]
   *
   * Garbage collection — deletes every block that has no pin entry.
   * Returns the list of CID strings that were deleted.
   *
   * Safe to call at any time. Pinned blocks are never touched.
   *
   * Algorithm:
   *   1. List all blocks on disk
   *   2. Delete any block whose CID is not in the pins map
   *
   * SWAP POINT: For a more sophisticated GC (e.g. mark-and-sweep that
   * re-derives indirect pins by walking the live tree), replace this method.
   * The current approach relies on indirect pins being correctly maintained
   * during pin() and unpin() calls.
   *
   * @returns {string[]} list of deleted CID strings
   */
  gc() {
    const all     = this.list();
    const deleted = [];

    for (const cidString of all) {
      if (!this.isPinned(cidString)) {
        this.delete(cidString);
        deleted.push(cidString);
      }
    }

    // Clean up any pin entries that point to blocks we no longer have
    for (const [cid] of this.pins) {
      if (!this.has(cid)) {
        this.pins.delete(cid);
      }
    }
    this._savePins();

    return deleted;
  }

  // ── Stats ────────────────────────────────────────────────────────────────────

  /**
   * stat() → { blockCount, totalBytes, pinnedCount }
   *
   * @returns {{ blockCount: number, totalBytes: number, pinnedCount: number }}
   */
  stat() {
    const all        = this.list();
    const totalBytes = all.reduce((sum, cid) => {
      try {
        const filePath = path.join(this.blocksDir, cid);
        return sum + fs.statSync(filePath).size;
      } catch { return sum; }
    }, 0);

    return {
      blockCount:  all.length,
      totalBytes,
      pinnedCount: this.pins.size,
    };
  }

  // ── Low-level filesystem helpers ─────────────────────────────────────────────
  // SWAP POINT: Replace these four methods to use a different storage backend
  // (LevelDB, SQLite, in-memory Map for testing, etc.).
  // The public API above never touches the filesystem directly.

  /** SECURITY: validate CID string to prevent path traversal */
  _safePath(cidString) {
    // CID strings must be base32-lower multibase: 'b' prefix + lowercase alphanumeric
    // Reject anything with path separators, dots, or non-CID characters
    if (typeof cidString !== 'string' || cidString.length === 0 || cidString.length > 512) {
      throw new Error('Invalid CID string: bad length');
    }
    if (!/^[a-z0-9]+$/.test(cidString)) {
      throw new Error('Invalid CID string: contains illegal characters');
    }
    const resolved = path.join(this.blocksDir, cidString);
    // Belt-and-suspenders: ensure the resolved path is inside blocksDir
    if (!resolved.startsWith(this.blocksDir)) {
      throw new Error('Invalid CID string: path traversal detected');
    }
    return resolved;
  }

  _write(cidString, bytes) {
    fs.writeFileSync(this._safePath(cidString), bytes);
  }

  _read(cidString) {
    return fs.readFileSync(this._safePath(cidString));
  }

  _exists(cidString) {
    return fs.existsSync(this._safePath(cidString));
  }

  _delete(cidString) {
    fs.unlinkSync(this._safePath(cidString));
  }

  // ── Pin persistence ──────────────────────────────────────────────────────────

  _loadPins() {
    try {
      const raw = fs.readFileSync(this.pinsFile, 'utf8');
      return new Map(Object.entries(JSON.parse(raw)));
    } catch {
      return new Map(); // file doesn't exist yet — start fresh
    }
  }

  _savePins() {
    const obj = Object.fromEntries(this.pins);
    fs.writeFileSync(this.pinsFile, JSON.stringify(obj, null, 2));
  }
}
