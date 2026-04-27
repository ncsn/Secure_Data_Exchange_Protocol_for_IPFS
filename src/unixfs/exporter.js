/**
 * exporter.js — Retrieve files and directories from the DAG + BlockStore
 *
 * The exporter is the read path: given a CID and a BlockStore, it reconstructs
 * the original file bytes or directory listing.
 *
 * ── Public API ────────────────────────────────────────────────────────────────
 *
 *   cat(cidString, store)  → Buffer          (file bytes)
 *   ls(cidString, store)   → Entry[]         (directory listing)
 *   stat(cidString, store) → UnixFSNode      (metadata only)
 *   getNode(cidString, store) → { unixfs, dagNode } (raw access)
 *
 * ── Entry format returned by ls() ────────────────────────────────────────────
 *
 *   {
 *     name    : string   — entry name
 *     cid     : string   — CID string of the child
 *     size    : number   — byte size stored in the link
 *     type    : string   — 'file' | 'directory' | 'symlink' | 'raw'
 *   }
 */

import { deserialize as deserializeDAG } from '../dag/node.js';
import { deserialize as deserializeUnixFS, NodeType } from './unixfs.js';

// ── cat ───────────────────────────────────────────────────────────────────────

/**
 * cat(cidString, store) → Buffer
 *
 * Retrieves and reassembles the file bytes for a given CID.
 * Works for both single-chunk and multi-chunk files.
 *
 * @param {string}     cidString
 * @param {BlockStore} store
 * @returns {Buffer}
 */
export function cat(cidString, store) {
  const { unixfs, dagNode } = getNode(cidString, store);

  if (unixfs.isDirectory()) {
    throw new Error(`${cidString.slice(0, 20)}... is a directory — use ls() instead`);
  }

  if (unixfs.isSymlink()) {
    throw new Error(`${cidString.slice(0, 20)}... is a symlink to: ${unixfs.data.toString('utf8')}`);
  }

  // Single-chunk file: data is embedded in the UnixFS node
  if (dagNode.links.length === 0) {
    return unixfs.data;
  }

  // Multi-chunk file: follow each link and concatenate leaf data.
  // Leaf nodes are plain DAGNodes whose data field contains raw chunk bytes
  // (no UnixFS wrapper — only the root carries UnixFS metadata).
  const parts = dagNode.links.map(link => {
    const childBytes        = store.get(link.cid.string);
    const { data: rawData } = deserializeDAG(childBytes);
    return rawData;
  });

  return Buffer.concat(parts);
}

// ── ls ────────────────────────────────────────────────────────────────────────

/**
 * ls(cidString, store) → Entry[]
 *
 * Lists the contents of a directory node.
 *
 * @param {string}     cidString
 * @param {BlockStore} store
 * @returns {Array<{name:string, cid:string, size:number, type:string}>}
 */
export function ls(cidString, store) {
  const { unixfs, dagNode } = getNode(cidString, store);

  if (!unixfs.isDirectory()) {
    throw new Error(`${cidString.slice(0, 20)}... is not a directory — use cat() instead`);
  }

  return dagNode.links.map(link => {
    // Try to read the child's type from its UnixFS metadata
    let type = 'unknown';
    try {
      const childBytes  = store.get(link.cid.string);
      const { data }    = deserializeDAG(childBytes);
      const childUnixFS = deserializeUnixFS(data);
      type = typeString(childUnixFS.type);
    } catch { /* block not local — that's ok, just show unknown */ }

    return {
      name: link.name,
      cid:  link.cid.string,
      size: link.size,
      type,
    };
  });
}

// ── stat ──────────────────────────────────────────────────────────────────────

/**
 * stat(cidString, store) → UnixFSNode
 *
 * Returns the UnixFS metadata for a CID without fetching its content.
 *
 * @param {string}     cidString
 * @param {BlockStore} store
 * @returns {import('./unixfs.js').UnixFSNode}
 */
export function stat(cidString, store) {
  const { unixfs } = getNode(cidString, store);
  return unixfs;
}

// ── getNode ───────────────────────────────────────────────────────────────────

/**
 * getNode(cidString, store) → { unixfs: UnixFSNode, dagNode: object }
 *
 * Low-level: fetches and deserialises both the DAG node and its UnixFS wrapper.
 * Used internally by cat/ls/stat, and available for advanced use.
 *
 * @param {string}     cidString
 * @param {BlockStore} store
 * @returns {{ unixfs: UnixFSNode, dagNode: { data: Buffer, links: Array } }}
 */
export function getNode(cidString, store) {
  const raw    = store.get(cidString);
  const dagNode = deserializeDAG(raw);
  const unixfs  = deserializeUnixFS(dagNode.data);
  return { unixfs, dagNode };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function typeString(type) {
  switch (type) {
    case NodeType.FILE:      return 'file';
    case NodeType.DIRECTORY: return 'directory';
    case NodeType.SYMLINK:   return 'symlink';
    case NodeType.RAW:       return 'raw';
    default:                 return 'unknown';
  }
}
