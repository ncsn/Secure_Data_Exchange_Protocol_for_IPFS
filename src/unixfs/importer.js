/**
 * importer.js — Add files and directories into the DAG + BlockStore
 *
 * The importer is the write path: it reads from the local filesystem,
 * wraps content in UnixFS nodes, chunks and links them into the Merkle DAG,
 * persists every block, and returns the root CID.
 *
 * ── Public API ────────────────────────────────────────────────────────────────
 *
 *   addFile(filePath, store, [opts])   → CID string
 *   addDirectory(dirPath, store, [opts]) → CID string
 *   addBytes(bytes, store, [opts])     → CID string   (in-memory, no fs read)
 *
 * ── How a file is added ───────────────────────────────────────────────────────
 *
 *   1. Read file bytes from disk
 *   2. Build a UnixFSNode(FILE) carrying metadata (name, size, mtime, mode)
 *   3. Chunk the file bytes via the DAG importer
 *      - Single chunk: the UnixFS metadata is embedded in the single leaf node
 *      - Multiple chunks: leaf nodes carry RAW data; root node carries UnixFS metadata
 *   4. Persist all blocks to the block store
 *   5. Pin the root recursively
 *   6. Return the root CID string
 *
 * ── How a directory is added ──────────────────────────────────────────────────
 *
 *   1. Recursively add every child (file or subdirectory)
 *   2. Collect { name → CID } for each child
 *   3. Build a DAGNode whose links are the children and whose data field
 *      contains a serialised UnixFSNode(DIRECTORY)
 *   4. Persist the directory block and pin it
 *   5. Return the directory root CID string
 *
 * SWAP POINT — metadata:
 *   We capture mtime and mode from fs.statSync(). If you want to strip
 *   metadata for privacy (so identical files with different mtimes get the
 *   same CID), set mtime=0 and mode=0 before calling serialize().
 */

import fs   from 'fs';
import path from 'path';

import { DAGNode, Link, serialize as serializeDAG } from '../dag/node.js';
import { importData }                               from '../dag/dag.js';
import { cidFromString }                            from '../cid/cid.js';
import { UnixFSNode, NodeType, serialize as serializeUnixFS } from './unixfs.js';

// ── addBytes ──────────────────────────────────────────────────────────────────

/**
 * addBytes(bytes, store, [opts]) → string (CID)
 *
 * Adds raw bytes as a FILE node. No filesystem reads — useful for tests
 * and in-memory content.
 *
 * @param {Buffer}     bytes
 * @param {BlockStore} store
 * @param {object}     [opts]
 * @param {string}     [opts.name='']    — file name stored in metadata
 * @param {number}     [opts.mtime=0]    — modification time (ms epoch)
 * @param {number}     [opts.mode=0o644] — Unix permission bits
 * @param {boolean}    [opts.pin=true]   — pin the root after adding
 * @returns {string} root CID string
 */
export function addBytes(bytes, store, opts = {}) {
  const {
    name  = '',
    mtime = 0,
    mode  = 0o644,
    pin   = true,
  } = opts;

  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  // Build the DAG (chunks + links)
  const { root, blocks } = importData(buf);

  // Attach UnixFS metadata to the root node.
  // We rebuild the root DAGNode with UnixFS data in its data field.
  const unixfsNode = new UnixFSNode(NodeType.FILE, {
    filesize: buf.length,
    mtime,
    mode,
    name,
    data: root.links.length === 0 ? buf : Buffer.alloc(0),
    // Single-chunk: embed bytes in UnixFS data field.
    // Multi-chunk:  root carries only metadata; leaves carry raw bytes.
  });

  const rootWithMeta = new DAGNode(serializeUnixFS(unixfsNode), root.links);

  // Persist all leaf blocks (raw chunk data)
  for (const [cidString, node] of blocks) {
    if (cidString !== root.cid.string) {
      // Leaf: store as-is (raw bytes, no UnixFS wrapper needed for inner chunks)
      store.put(cidString, serializeDAG(node));
    }
  }

  // Persist the root (with UnixFS metadata)
  store.put(rootWithMeta.cid.string, serializeDAG(rootWithMeta));

  // Rebuild block map with the new root for pinning
  const allBlocks = new Map(blocks);
  allBlocks.delete(root.cid.string);
  allBlocks.set(rootWithMeta.cid.string, rootWithMeta);

  if (pin) {
    store.pin(rootWithMeta.cid.string, 'recursive', allBlocks);
  }

  return rootWithMeta.cid.string;
}

// ── addFile ───────────────────────────────────────────────────────────────────

/**
 * addFile(filePath, store, [opts]) → string (CID)
 *
 * Reads a file from disk and adds it to the block store.
 *
 * @param {string}     filePath — absolute or relative path to the file
 * @param {BlockStore} store
 * @param {object}     [opts]   — same options as addBytes, plus:
 * @param {boolean}    [opts.preserveMeta=true] — capture mtime/mode from disk
 * @returns {string} root CID string
 */
export function addFile(filePath, store, opts = {}) {
  const { preserveMeta = true, ...rest } = opts;

  const stat  = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  const name  = rest.name ?? path.basename(filePath);

  return addBytes(bytes, store, {
    name,
    mtime: preserveMeta ? stat.mtimeMs : 0,
    mode:  preserveMeta ? stat.mode    : 0o644,
    pin:   rest.pin ?? true,
    ...rest,
  });
}

// ── addDirectory ──────────────────────────────────────────────────────────────

/**
 * addDirectory(dirPath, store, [opts]) → string (CID)
 *
 * Recursively adds a directory and all its contents.
 * Returns the CID of the directory root node.
 *
 * @param {string}     dirPath — absolute or relative path to the directory
 * @param {BlockStore} store
 * @param {object}     [opts]
 * @param {boolean}    [opts.pin=true]
 * @returns {string} directory root CID string
 */
export function addDirectory(dirPath, store, opts = {}) {
  const { pin = true } = opts;
  const name = path.basename(dirPath);

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const links   = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    let childCid;

    if (entry.isDirectory()) {
      // Recurse — child dirs are pinned by their parent's recursive pin
      childCid = addDirectory(fullPath, store, { pin: false });
    } else if (entry.isFile()) {
      childCid = addFile(fullPath, store, { pin: false });
    } else if (entry.isSymbolicLink()) {
      childCid = addSymlink(fullPath, entry.name, store);
    } else {
      continue; // skip sockets, devices, etc.
    }

    // Build a proper Link using a real CID object parsed from the string.
    const childBlock = store.get(childCid);
    links.push(new Link(entry.name, cidFromString(childCid), childBlock.length));
  }

  // Build the directory DAGNode:
  // data = serialised UnixFSNode(DIRECTORY), links = children
  const unixfsDir = new UnixFSNode(NodeType.DIRECTORY, { name });
  const dirNode   = new DAGNode(serializeUnixFS(unixfsDir), links);

  store.put(dirNode.cid.string, serializeDAG(dirNode));

  if (pin) {
    // Pin the directory root — children were already stored (not pinned individually)
    store.pin(dirNode.cid.string, 'direct');
  }

  return dirNode.cid.string;
}

// ── addSymlink ────────────────────────────────────────────────────────────────

/**
 * addSymlink(symlinkPath, name, store) → string (CID)
 *
 * Adds a symlink entry. Stores the link target as the UnixFS data field.
 *
 * @param {string}     symlinkPath
 * @param {string}     name
 * @param {BlockStore} store
 * @returns {string} CID string
 */
export function addSymlink(symlinkPath, name, store) {
  const target    = fs.readlinkSync(symlinkPath);
  const unixfsNode = new UnixFSNode(NodeType.SYMLINK, {
    name,
    data: Buffer.from(target, 'utf8'),
  });
  const dagNode = new DAGNode(serializeUnixFS(unixfsNode), []);
  store.put(dagNode.cid.string, serializeDAG(dagNode));
  return dagNode.cid.string;
}
