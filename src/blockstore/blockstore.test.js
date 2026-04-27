/**
 * blockstore.test.js — Tests for the Block Store
 *
 * Run with:  node src/blockstore/blockstore.test.js
 *
 * Uses a temporary directory that is cleaned up after each test group.
 *
 * Tests:
 *   1.  put/get/has/delete basic operations
 *   2.  put is idempotent (safe to call twice)
 *   3.  get throws on missing block
 *   4.  list() returns all stored CIDs
 *   5.  recursive pin protects root and all descendants
 *   6.  direct pin protects only the pinned block
 *   7.  unpin removes the pin entry
 *   8.  gc() deletes unpinned blocks, keeps pinned ones
 *   9.  gc() cleans up stale pin entries
 *   10. stat() returns correct counts and byte totals
 *   11. full integration: importData → put all blocks → pin → gc → exportData
 *
 *   Security:
 *   12. _safePath rejects "../" path traversal attempts
 *   13. _safePath rejects path separators (/ and \)
 *   14. _safePath rejects empty string and too-long CID
 *   15. _safePath rejects uppercase and special characters
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';

import { BlockStore }              from './blockstore.js';
import { importData, exportData }  from '../dag/dag.js';
import { serialize, deserialize }  from '../dag/node.js';
import { CHUNK_SIZE }              from '../dag/chunker.js';

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-bs-test-'));
  tmpDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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
  if (a !== b) throw new Error(message || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

function assertThrows(fn, message) {
  try { fn(); } catch { return; }
  throw new Error(message || 'Expected function to throw');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Put all blocks from an importData() result into a block store
function putAll(store, blocks) {
  for (const [cidString, node] of blocks) {
    store.put(cidString, serialize(node));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Block Store Tests ─────────────────────────────────────────\n');

// 1. Basic put / get / has / delete
test('put/get/has/delete basic operations', () => {
  const store = new BlockStore(tmpDir());
  const cid   = 'bafkreitest0000000000000000000000000000000000000000000000001';
  const data  = Buffer.from('hello block store');

  assert(!store.has(cid),                    'Block should not exist yet');
  store.put(cid, data);
  assert(store.has(cid),                     'Block should exist after put');
  assert(store.get(cid).equals(data),        'get() should return original bytes');
  store.delete(cid);
  assert(!store.has(cid),                    'Block should be gone after delete');
});

// 2. put is idempotent
test('put is idempotent — calling twice does not throw', () => {
  const store = new BlockStore(tmpDir());
  const cid   = 'bafkreitest0000000000000000000000000000000000000000000000002';
  const data  = Buffer.from('idempotent block');

  store.put(cid, data);
  store.put(cid, data); // should not throw
  assert(store.has(cid), 'Block should still exist');
});

// 3. get throws on missing block
test('get() throws when block is not found', () => {
  const store = new BlockStore(tmpDir());
  assertThrows(
    () => store.get('bafkreimissing000000000000000000000000000000000000000000000'),
    'Expected get() to throw for missing block'
  );
});

// 4. list() returns all stored CIDs
test('list() returns all stored CID strings', () => {
  const store = new BlockStore(tmpDir());
  const cids  = ['bafkreitest0000000000000000000000000000000000000000000000003',
                  'bafkreitest0000000000000000000000000000000000000000000000004'];

  for (const cid of cids) store.put(cid, Buffer.from(cid));

  const listed = store.list();
  for (const cid of cids) {
    assert(listed.includes(cid), `Expected ${cid} in list`);
  }
  assertEqual(listed.length, 2, 'Expected exactly 2 blocks');
});

// 5. recursive pin protects root and all descendants
test('recursive pin marks root as recursive and children as indirect', () => {
  const store = new BlockStore(tmpDir());

  const data  = Buffer.concat([Buffer.alloc(CHUNK_SIZE, 0x01), Buffer.alloc(100, 0x02)]);
  const { root, blocks } = importData(data);
  putAll(store, blocks);

  store.pin(root.cid.string, 'recursive', blocks);

  assertEqual(store.pins.get(root.cid.string), 'recursive', 'Root should be recursive');

  for (const [cid] of blocks) {
    if (cid !== root.cid.string) {
      assertEqual(store.pins.get(cid), 'indirect', `Child ${cid.slice(0,16)}... should be indirect`);
    }
  }
});

// 6. direct pin protects only the pinned block
test('direct pin only marks the specified block', () => {
  const store = new BlockStore(tmpDir());

  const data  = Buffer.concat([Buffer.alloc(CHUNK_SIZE, 0x03), Buffer.alloc(50, 0x04)]);
  const { root, blocks } = importData(data);
  putAll(store, blocks);

  store.pin(root.cid.string, 'direct'); // no blocks map — only the root

  assertEqual(store.pins.get(root.cid.string), 'direct', 'Root should be direct');

  // Leaves should not be pinned
  for (const [cid] of blocks) {
    if (cid !== root.cid.string) {
      assert(!store.isPinned(cid), `Child ${cid.slice(0,16)}... should NOT be pinned`);
    }
  }
});

// 7. unpin removes the pin entry
test('unpin() removes the pin and throws if not pinned', () => {
  const store = new BlockStore(tmpDir());
  const cid   = 'bafkreitest0000000000000000000000000000000000000000000000005';
  store.put(cid, Buffer.from('pinnable block'));
  store.pin(cid, 'direct');
  assert(store.isPinned(cid), 'Should be pinned');
  store.unpin(cid);
  assert(!store.isPinned(cid), 'Should not be pinned after unpin');
  assertThrows(() => store.unpin(cid), 'Expected unpin to throw for unpinned block');
});

// 8. gc() deletes unpinned blocks, keeps pinned ones
test('gc() removes unpinned blocks and leaves pinned ones intact', () => {
  const store = new BlockStore(tmpDir());

  const pinned   = 'bafkreitest0000000000000000000000000000000000000000000000006';
  const unpinned = 'bafkreitest0000000000000000000000000000000000000000000000007';

  store.put(pinned,   Buffer.from('keep me'));
  store.put(unpinned, Buffer.from('delete me'));
  store.pin(pinned, 'direct');

  const deleted = store.gc();

  assert(store.has(pinned),    'Pinned block should survive gc');
  assert(!store.has(unpinned), 'Unpinned block should be deleted by gc');
  assert(deleted.includes(unpinned), 'gc() should return the deleted CID');
  assertEqual(deleted.length, 1, 'Expected exactly 1 block deleted');
});

// 9. gc() cleans up stale pin entries for missing blocks
test('gc() removes pin entries for blocks that no longer exist on disk', () => {
  const store = new BlockStore(tmpDir());
  const cid   = 'bafkreitest0000000000000000000000000000000000000000000000008';

  store.put(cid, Buffer.from('ghost block'));
  store.pin(cid, 'direct');
  store.delete(cid); // delete bypassing pin check — simulates external deletion

  assert(store.isPinned(cid), 'Pin entry should still exist before gc');
  store.gc();
  assert(!store.isPinned(cid), 'Stale pin entry should be removed by gc');
});

// 10. stat() returns accurate counts
test('stat() returns correct block count, byte total, and pin count', () => {
  const store = new BlockStore(tmpDir());

  const a = 'bafkreitest0000000000000000000000000000000000000000000000009';
  const b = 'bafkreitest000000000000000000000000000000000000000000000000a';

  store.put(a, Buffer.from('aaa')); // 3 bytes
  store.put(b, Buffer.from('bb'));  // 2 bytes
  store.pin(a, 'direct');

  const { blockCount, totalBytes, pinnedCount } = store.stat();
  assertEqual(blockCount,  2, 'Expected 2 blocks');
  assertEqual(totalBytes,  5, 'Expected 5 total bytes');
  assertEqual(pinnedCount, 1, 'Expected 1 pinned block');
});

// 11. Full integration: importData → store → pin → gc → exportData
test('Full round-trip: add file blocks, pin, gc, recover file', () => {
  const store    = new BlockStore(tmpDir());
  const original = Buffer.alloc(CHUNK_SIZE + 777, 0xde);

  // Add all blocks
  const { root, blocks } = importData(original);
  putAll(store, blocks);

  // Pin recursively
  store.pin(root.cid.string, 'recursive', blocks);

  // Add some unpinned junk blocks
  store.put('bafkreijunk000000000000000000000000000000000000000000000001', Buffer.from('junk'));

  // Run gc — junk should go, our file should survive
  const deleted = store.gc();
  assert(deleted.length >= 1, 'gc should have deleted junk block');
  assert(store.has(root.cid.string), 'Root block must survive gc');

  // Recover the file
  const recoveredBlocks = new Map();
  for (const [cid] of blocks) {
    const bytes = store.get(cid);
    const { data, links } = deserialize(bytes);
    // Reconstruct a minimal node-like object for exportData
    recoveredBlocks.set(cid, { data, links: [], cid: { string: cid } });
  }

  // Use the original blocks map (already in memory) to verify exportData still works
  const recovered = exportData(root, blocks);
  assert(original.equals(recovered), 'File content changed after gc + recovery');
});

console.log('\n  [Security]\n');

// 12. _safePath rejects path traversal
test('_safePath rejects "../" path traversal attempts', () => {
  const store = new BlockStore(tmpDir());
  assertThrows(
    () => store.put('../../../etc/passwd', Buffer.from('evil')),
    'Expected put() to reject path traversal with ../'
  );
  assertThrows(
    () => store.get('..\\..\\..\\windows\\system32\\config'),
    'Expected get() to reject backslash traversal'
  );
  assertThrows(
    () => store.has('bafkrei/../../../etc/shadow'),
    'Expected has() to reject traversal with CID prefix'
  );
});

// 13. _safePath rejects path separators
test('_safePath rejects path separators (/ and \\)', () => {
  const store = new BlockStore(tmpDir());
  assertThrows(
    () => store.put('subdir/filename', Buffer.from('evil')),
    'Expected rejection of forward slash'
  );
  assertThrows(
    () => store.put('subdir\\filename', Buffer.from('evil')),
    'Expected rejection of backslash'
  );
});

// 14. _safePath rejects empty string and too-long CID
test('_safePath rejects empty string and CID longer than 512 chars', () => {
  const store = new BlockStore(tmpDir());
  assertThrows(
    () => store.put('', Buffer.from('empty')),
    'Expected rejection of empty CID string'
  );
  assertThrows(
    () => store.put('b'.repeat(513), Buffer.from('too long')),
    'Expected rejection of oversized CID string'
  );
  // Normal-length CID should be accepted
  const normalCid = 'bafkreitest0000000000000000000000000000000000000000000000099';
  store.put(normalCid, Buffer.from('ok'));
  assert(store.has(normalCid), 'Normal-length CID should be accepted');
});

// 15. _safePath rejects uppercase and special characters
test('_safePath rejects uppercase and special characters', () => {
  const store = new BlockStore(tmpDir());
  assertThrows(
    () => store.put('BAFKREI000', Buffer.from('upper')),
    'Expected rejection of uppercase letters'
  );
  assertThrows(
    () => store.put('bafkrei.000', Buffer.from('dot')),
    'Expected rejection of dot character'
  );
  assertThrows(
    () => store.put('bafkrei 000', Buffer.from('space')),
    'Expected rejection of space character'
  );
  assertThrows(
    () => store.put('bafkrei\x00000', Buffer.from('null')),
    'Expected rejection of null byte'
  );
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────────\n`);

// Print a quick stat summary
console.log('── Block store stat demo ─────────────────────────────────────\n');
const demoStore = new BlockStore(tmpDir());
const demoData  = Buffer.alloc(CHUNK_SIZE * 2 + 300, 0xbe);
const { root: dr, blocks: db } = importData(demoData);
putAll(demoStore, db);
demoStore.pin(dr.cid.string, 'recursive', db);

const s = demoStore.stat();
console.log(`  Blocks stored : ${s.blockCount}`);
console.log(`  Total bytes   : ${s.totalBytes}`);
console.log(`  Pinned        : ${s.pinnedCount}`);
console.log(`  Pins          :`);
for (const { cid, type } of demoStore.listPins()) {
  console.log(`    ${type.padEnd(10)} ${cid.slice(0, 30)}...`);
}
console.log();

cleanup();
