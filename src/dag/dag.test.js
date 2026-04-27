/**
 * dag.test.js — Tests for the Merkle DAG module
 *
 * Run with:  node src/dag/dag.test.js
 *
 * Tests:
 *   1. Small file (≤ 1 chunk) → single leaf node, no links
 *   2. Large file (> 1 chunk) → root node with leaf links
 *   3. exportData() perfectly reconstructs the original bytes
 *   4. Merkle property — changing 1 byte changes the root CID
 *   5. Identical chunks in different files share the same CID (deduplication)
 *   6. serialize/deserialize round-trip for a DAGNode
 *   7. Tree structure inspection with printTree()
 */

import { DAGNode, Link, serialize, deserialize } from './node.js';
import { importData, exportData, printTree }     from './dag.js';
import { CHUNK_SIZE }                             from './chunker.js';
import { CID }                                    from '../cid/cid.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗  ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(a, b, message) {
  if (a !== b) throw new Error(message || `Expected "${a}" === "${b}"`);
}

function assertNotEqual(a, b, message) {
  if (a === b) throw new Error(message || `Expected values to differ`);
}

// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Merkle DAG Tests ──────────────────────────────────────────\n');

// 1. Small file → single node
test('Small file produces a single leaf node with no links', () => {
  const { root, blocks } = importData('hello world');
  assertEqual(root.links.length, 0,    'Expected no links on a small file root');
  assertEqual(blocks.size, 1,          'Expected exactly 1 block');
  assert(root.data.length > 0,         'Root data should not be empty');
});

// 2. Large file → root + leaves
test('Large file produces a root node linking multiple leaves', () => {
  // Use distinct content per chunk to prevent deduplication collapsing the map.
  // If all chunks were identical they'd share one CID — intentional dedup behaviour,
  // but it would make blocks.size unpredictable for this structural test.
  const chunk1 = Buffer.alloc(CHUNK_SIZE, 0x41); // 'A'
  const chunk2 = Buffer.alloc(CHUNK_SIZE, 0x42); // 'B'
  const chunk3 = Buffer.alloc(100,        0x43); // 'C'
  const bigData = Buffer.concat([chunk1, chunk2, chunk3]);

  const { root, blocks } = importData(bigData);

  assertEqual(root.links.length, 3,    'Expected 3 links (2 full chunks + 1 partial)');
  assertEqual(blocks.size, 4,          'Expected 4 blocks (root + 3 distinct leaves)');
  assertEqual(root.data.length, 0,     'Root of multi-chunk file should have no data');
});

// 3. Export reconstructs original bytes
test('exportData() reconstructs the original file exactly', () => {
  const original = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(100));
  const { root, blocks } = importData(original);
  const recovered = exportData(root, blocks);

  assert(original.equals(recovered), 'Recovered data does not match original');
});

// 4. Large file export round-trip
test('exportData() round-trips a multi-chunk file', () => {
  const original = Buffer.alloc(CHUNK_SIZE * 3 + 777, 0xab);
  const { root, blocks } = importData(original);
  const recovered = exportData(root, blocks);

  assert(original.equals(recovered), 'Multi-chunk round-trip failed');
});

// 5. Merkle property — 1-byte change → different root CID
test('Changing 1 byte changes the root CID (Merkle property)', () => {
  const data1 = Buffer.alloc(CHUNK_SIZE + 100, 0x00);
  const data2 = Buffer.from(data1);
  data2[CHUNK_SIZE] = 0x01; // flip one byte in the second chunk

  const { root: root1 } = importData(data1);
  const { root: root2 } = importData(data2);

  assertNotEqual(root1.cid.string, root2.cid.string, 'Root CIDs should differ after 1-byte change');
});

// 6. Deduplication — identical chunks share the same CID
test('Identical chunks in different files share the same leaf CID', () => {
  const sharedChunk = Buffer.alloc(CHUNK_SIZE, 0xcc);
  const file1 = Buffer.concat([sharedChunk, Buffer.alloc(100, 0x01)]);
  const file2 = Buffer.concat([sharedChunk, Buffer.alloc(100, 0x02)]);

  const { blocks: blocks1 } = importData(file1);
  const { blocks: blocks2 } = importData(file2);

  // The first chunk CID should appear in both block maps
  const cids1 = new Set(blocks1.keys());
  const cids2 = new Set(blocks2.keys());
  const shared = [...cids1].filter(c => cids2.has(c));

  assert(shared.length >= 1, 'Expected at least 1 shared chunk CID between files with identical first chunk');
});

// 7. serialize / deserialize round-trip
test('DAGNode serialize/deserialize round-trip preserves data and links', () => {
  const child = new DAGNode(Buffer.from('child data'), []);
  const link  = child.asLink('child-0');
  const parent = new DAGNode(Buffer.from('parent'), [link]);

  const bytes       = serialize(parent);
  const { data, links } = deserialize(bytes);

  assert(data.equals(parent.data),        'Data changed after round-trip');
  assertEqual(links.length, 1,            'Link count changed after round-trip');
  assertEqual(links[0].name, 'child-0',  'Link name changed after round-trip');
  assert(
    links[0].cid.digest.equals(child.cid.digest),
    'Link CID digest changed after round-trip'
  );
  assertEqual(links[0].size, child.size,  'Link size changed after round-trip');
});

// 8. Empty file
test('Empty file produces a single node with empty data', () => {
  const { root, blocks } = importData(Buffer.alloc(0));
  assertEqual(root.links.length, 0, 'Empty file should have no links');
  assertEqual(root.data.length,  0, 'Empty file node should have empty data');
  assertEqual(blocks.size, 1,       'Empty file should produce exactly 1 block');
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────────\n`);

// Print tree structure for a 3-chunk file
console.log('── Tree structure for a 3-chunk file ────────────────────────\n');
const demo = Buffer.alloc(CHUNK_SIZE * 2 + 500, 0x41); // fill with 'A'
const { root: demoRoot, blocks: demoBlocks } = importData(demo);
printTree(demoRoot, demoBlocks);
console.log();
console.log(`  Root CID : ${demoRoot.cid.string}`);
console.log(`  Total size : ${demoRoot.size} bytes`);
console.log(`  Blocks : ${demoBlocks.size}`);
console.log();
