/**
 * dag.js — Build and traverse a Merkle DAG from raw file data
 *
 * This module sits on top of the chunker and DAGNode primitives.
 * It provides two high-level operations:
 *
 *   importData(data)  → { root: DAGNode, blocks: Map<cidString, DAGNode> }
 *   exportData(root, blocks) → Buffer
 *
 * ── Tree shape ────────────────────────────────────────────────────────────────
 *
 * Small file (≤ 1 chunk):
 *
 *   [Root/Leaf]   ← single node, data = file bytes
 *
 * Large file (> 1 chunk):
 *
 *   [Root Node]            ← data = empty, links = [chunk-0, chunk-1, ...]
 *      │   │   │
 *   [L0] [L1] [L2]        ← leaf nodes, data = raw chunk bytes
 *
 * Very large files could use a multi-level tree (trie), but for now we
 * use a flat two-level structure (root + leaves). This is sufficient for
 * files up to CHUNK_SIZE * 255 ≈ 65 MB with 1-byte name lengths.
 *
 * SWAP POINT — tree shape:
 *   For very large files you may want a balanced tree where internal nodes
 *   also have a maximum fanout (e.g. 174 links per node, the IPFS default).
 *   Replace buildTree() below to implement that.
 *
 * ── Block map ─────────────────────────────────────────────────────────────────
 *
 * importData() returns a flat Map of ALL nodes (root + all leaves) keyed by
 * CID string. This map is handed to the Block Store (Step 3) for persistence.
 * It is also used by exportData() to reassemble the file without a block store.
 */

import { DAGNode, Link } from './node.js';
import { chunk }         from './chunker.js';

// ── Import (file → DAG) ───────────────────────────────────────────────────────

/**
 * importData(data) → { root: DAGNode, blocks: Map<string, DAGNode> }
 *
 * Converts raw file bytes into a Merkle DAG.
 *
 * Steps:
 *   1. Split data into chunks
 *   2. Wrap each chunk in a leaf DAGNode (computes its CID automatically)
 *   3. If more than one chunk, create a root node that links all leaves
 *   4. Return the root node and a flat map of all nodes (for the block store)
 *
 * @param {Buffer|string} data — raw file content
 * @returns {{ root: DAGNode, blocks: Map<string, DAGNode> }}
 */
export function importData(data) {
  const buf    = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const chunks = chunk(buf);
  const blocks = new Map(); // cid.string → DAGNode

  // ── Step 1: create a leaf node for each chunk ──────────────────────────────
  const leaves = chunks.map((chunkData, i) => {
    const leaf = new DAGNode(chunkData, []); // no links — this is raw content
    blocks.set(leaf.cid.string, leaf);
    return leaf;
  });

  // ── Step 2: if only one chunk, the leaf is also the root ───────────────────
  if (leaves.length === 1) {
    return { root: leaves[0], blocks };
  }

  // ── Step 3: build root node linking all leaves ─────────────────────────────
  const root = buildRoot(leaves);
  blocks.set(root.cid.string, root);

  return { root, blocks };
}

/**
 * buildRoot(leaves) → DAGNode
 *
 * Creates a parent node whose links point to all leaf nodes in order.
 * The root carries no data of its own — it is purely a structural node.
 *
 * SWAP POINT: Replace this function to implement a balanced multi-level tree
 * for very large files (limit fanout per node, recurse until single root).
 *
 * @param {DAGNode[]} leaves
 * @returns {DAGNode}
 */
function buildRoot(leaves) {
  const links = leaves.map((leaf, i) =>
    leaf.asLink(`chunk-${i}`) // name is informational; not required by the protocol
  );
  return new DAGNode(Buffer.alloc(0), links); // root has empty data
}

// ── Export (DAG → file) ───────────────────────────────────────────────────────

/**
 * exportData(root, blocks) → Buffer
 *
 * Reassembles the original file bytes from the DAG.
 *
 * Algorithm:
 *   - If the root has no links → the root IS the file (single-chunk case)
 *   - Otherwise → concatenate the data of each linked leaf in order
 *
 * This is a recursive traversal, so it works for any tree depth.
 * In practice our tree is only 2 levels deep (root + leaves).
 *
 * @param {DAGNode}              root   — the root DAG node
 * @param {Map<string, DAGNode>} blocks — all nodes keyed by cid.string
 * @returns {Buffer}
 */
export function exportData(root, blocks) {
  return collectData(root, blocks);
}

function collectData(node, blocks) {
  // Leaf node: return its data directly
  if (node.links.length === 0) {
    return node.data;
  }

  // Internal node: recurse into each child and concatenate
  const parts = node.links.map(link => {
    const child = blocks.get(link.cid.string);
    if (!child) {
      throw new Error(`Missing block: ${link.cid.string}`);
    }
    return collectData(child, blocks);
  });

  return Buffer.concat(parts);
}

// ── Inspection helpers ────────────────────────────────────────────────────────

/**
 * printTree(root, blocks, indent) — pretty-print the DAG tree to console
 *
 * Useful for debugging and understanding the structure.
 *
 * @param {DAGNode}              root
 * @param {Map<string, DAGNode>} blocks
 * @param {string}               indent
 */
export function printTree(root, blocks, indent = '') {
  const isLeaf = root.links.length === 0;
  const label  = isLeaf ? `[leaf  ${root.data.length}B]` : `[root  ${root.links.length} links]`;
  console.log(`${indent}${label}  CID: ${root.cid.string.slice(0, 20)}...`);

  for (const link of root.links) {
    const child = blocks.get(link.cid.string);
    if (child) {
      printTree(child, blocks, indent + '  │  ');
    } else {
      console.log(`${indent}  │  [missing block: ${link.cid.string.slice(0, 20)}...]`);
    }
  }
}
