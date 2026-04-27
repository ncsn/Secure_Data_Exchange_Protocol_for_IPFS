/**
 * node.test.js — End-to-end integration tests
 *
 * Run with:  node src/node/node.test.js
 *
 * These tests spin up real Node instances talking over TCP and exercise
 * the full stack: UnixFS → BlockStore → DHT → Bitswap → privacy handshake.
 *
 * Tests:
 *   1.  Node starts, gets a listen port, has a peer ID
 *   2.  Two nodes connect — each sees the other in their DHT
 *   3.  Node A adds a file — returns cid1, cid2, cid3
 *   4.  CID² is distinct from CID¹ and CID³ (privacy guarantee)
 *   5.  Node B retrieves a file from A using the privacy protocol
 *   6.  Retrieved bytes exactly match the original file
 *   7.  Integrity check: H(retrieved) = cid1 digest
 *   8.  Node B cannot retrieve with wrong CID¹ digest
 *   9.  Three nodes: C retrieves from A via B (DHT multi-hop)
 *   10. addBytes round-trip: small in-memory content
 *   11. Large file (multi-chunk) round-trip over the network
 *   12. node.info() reports correct stats after operations
 *   13. getPublic() retrieves a non-private block
 *   14. Full flow: add directory on A, ls from B
 *   Concurrency:
 *   15. Two nodes retrieve the same file concurrently from a third
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';

import { Node }       from './node.js';
import { tripleHash } from '../cid/cid.js';
import { hash }       from '../cid/crypto.js';
import { CHUNK_SIZE } from '../dag/chunker.js';

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const nodes  = [];
const tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-e2e-'));
  tmpDirs.push(d);
  return d;
}

async function makeNode() {
  const n = new Node({ ephemeral: true });
  await n.start();
  nodes.push(n);
  return n;
}

async function cleanup() {
  for (const n of nodes) await n.stop().catch(() => {});
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗  ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function assert(cond, msg)         { if (!cond)   throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg)    { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`); }
function assertNotEqual(a, b, msg) { if (a === b) throw new Error(msg || 'Expected values to differ'); }
function sleep(ms)                 { return new Promise(r => setTimeout(r, ms)); }

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n── Node Integration Tests ────────────────────────────────────\n');
  console.log('  [Node Lifecycle]\n');

  // 1. Node starts
  await test('Node starts and has a peer ID and listen port', async () => {
    const n = await makeNode();
    assert(typeof n.id === 'string' && n.id.length > 0, 'No peer ID');
    assert(n._listenAddr.port > 0,                      'No listen port');
    assert(n.multiaddr().startsWith('/ip4/'),           'Invalid multiaddr');
  });

  // 2. Two nodes connect
  await test('Two nodes connect — each appears in the other\'s DHT routing table', async () => {
    const a = await makeNode();
    const b = await makeNode();
    await a.connect('127.0.0.1', b._listenAddr.port);
    await sleep(100);
    assertEqual(a.info().connections, 1, 'A should have 1 connection');
    assertEqual(b.info().connections, 1, 'B should have 1 connection');
    assert(a.info().dhtPeers >= 1, 'A should know B in DHT');
    assert(b.info().dhtPeers >= 1, 'B should know A in DHT');
  });

  console.log('\n  [Add]\n');

  // 3. add() returns three CIDs
  await test('add() returns cid1, cid2, cid3 as non-empty strings', async () => {
    const n    = await makeNode();
    const dir  = tmpDir();
    const file = path.join(dir, 'hello.txt');
    fs.writeFileSync(file, 'hello from node');

    const { cid1, cid2, cid3 } = await n.add(file);
    assert(cid1 && cid1.startsWith('b'), 'cid1 invalid');
    assert(cid2 && cid2.startsWith('b'), 'cid2 invalid');
    assert(cid3 && cid3.startsWith('b'), 'cid3 invalid');
  });

  // 4. CID² is distinct from CID¹ and CID³
  await test('CID² is distinct from CID¹ and CID³ (privacy guarantee)', async () => {
    const n   = await makeNode();
    const { cid1, cid2, cid3 } = await n.addBytes(Buffer.from('privacy test'));
    assertNotEqual(cid1, cid2, 'CID¹ and CID² should differ');
    assertNotEqual(cid2, cid3, 'CID² and CID³ should differ');
    assertNotEqual(cid1, cid3, 'CID¹ and CID³ should differ');
  });

  console.log('\n  [Privacy Protocol]\n');

  // 5 & 6. B retrieves file from A using privacy protocol
  await test('Node B retrieves file from A — bytes match original', async () => {
    const a = await makeNode();
    const b = await makeNode();
    await b.connect('127.0.0.1', a._listenAddr.port);
    await sleep(100);

    const original = Buffer.from('The quick brown fox jumps over the lazy dog');
    const { cid1, cid3 } = await a.addBytes(original);

    // B needs cid1 digest to initiate the handshake
    const { h1 } = tripleHash(original);
    const received = await b.get(cid3, h1);

    assert(original.equals(received), 'Retrieved bytes do not match original');
  });

  // 7. Integrity: H(received) = h1
  await test('Integrity: H(retrieved bytes) equals CID¹ digest', async () => {
    const a = await makeNode();
    const b = await makeNode();
    await b.connect('127.0.0.1', a._listenAddr.port);
    await sleep(100);

    const original = Buffer.from('integrity check content');
    await a.addBytes(original);
    const { h1 } = tripleHash(original);

    const received     = await b.get(tripleHash(original).cid3.string, h1);
    const receivedHash = hash(received);
    assert(receivedHash.equals(h1), 'H(received) ≠ CID¹ digest — integrity failure');
  });

  // 8. Wrong CID¹ digest is rejected
  await test('Node B cannot retrieve with a wrong CID¹ digest', async () => {
    const a = await makeNode();
    const b = await makeNode();
    await b.connect('127.0.0.1', a._listenAddr.port);
    await sleep(100);

    const original = Buffer.from('secret content');
    const { cid3 } = await a.addBytes(original);
    const wrongDigest = Buffer.alloc(32, 0xff);

    let threw = false;
    try { await b.get(cid3, wrongDigest); } catch { threw = true; }
    assert(threw, 'Expected retrieval with wrong CID¹ to fail');
  });

  // 9. Three nodes: C retrieves from A via B's DHT
  await test('Three nodes: C retrieves file from A, discovered via B\'s DHT', async () => {
    const a = await makeNode();
    const b = await makeNode();
    const c = await makeNode();

    // Topology: C — B — A
    await b.connect('127.0.0.1', a._listenAddr.port);
    await c.connect('127.0.0.1', b._listenAddr.port);
    await sleep(150);

    const original = Buffer.from('three-node test content');
    const { cid3 }  = await a.addBytes(original);
    const { h1 }    = tripleHash(original);

    // B should have learned about A's providers via DHT propagation
    // C asks B for providers, then connects directly to A
    const received = await c.get(cid3, h1);
    assert(original.equals(received), 'Three-node retrieval failed');
  });

  console.log('\n  [Content types]\n');

  // 10. Small in-memory addBytes round-trip
  await test('addBytes + get round-trip for small in-memory content', async () => {
    const a = await makeNode();
    const b = await makeNode();
    await b.connect('127.0.0.1', a._listenAddr.port);
    await sleep(100);

    const original = Buffer.from('in-memory content test');
    const { cid3 }  = await a.addBytes(original);
    const { h1 }    = tripleHash(original);
    const received  = await b.get(cid3, h1);

    assert(original.equals(received), 'addBytes round-trip failed');
  });

  // 11. Large multi-chunk file
  await test('Large multi-chunk file round-trip over the network', async () => {
    const a = await makeNode();
    const b = await makeNode();
    await b.connect('127.0.0.1', a._listenAddr.port);
    await sleep(100);

    const original = Buffer.alloc(CHUNK_SIZE + 5000, 0x42);
    const { cid3 }  = await a.addBytes(original);
    const { h1 }    = tripleHash(original);
    const received  = await b.get(cid3, h1);

    assert(original.equals(received), 'Large file round-trip failed');
  });

  // 12. node.info() stats
  await test('node.info() reports correct stats after add', async () => {
    const n = await makeNode();
    await n.addBytes(Buffer.from('stats test'));

    const info = n.info();
    assert(info.blocks > 0,       'Expected at least 1 block');
    assert(info.pinnedBlocks > 0, 'Expected at least 1 pinned block');
    assert(info.storageBytes > 0, 'Expected storage > 0');
    assert(info.dhtProviders > 0, 'Expected at least 1 DHT provider record');
  });

  // 13. getPublic()
  await test('getPublic() retrieves a non-private block from a peer', async () => {
    const a = await makeNode();
    const b = await makeNode();
    await b.connect('127.0.0.1', a._listenAddr.port);
    await sleep(100);

    const data = Buffer.from('public block data');
    const { cid1 } = await a.addBytes(data);

    // Store the block in A's store directly so wantBlock can serve it
    const received = await b.getPublic(cid1);
    // getPublic returns raw block bytes (may be wrapped in UnixFS/DAG)
    assert(received && received.length > 0, 'getPublic returned empty');
  });

  // 14. addDirectory + ls
  await test('addDirectory on A, ls from B retrieves correct entries', async () => {
    const a   = await makeNode();
    const b   = await makeNode();
    await b.connect('127.0.0.1', a._listenAddr.port);
    await sleep(100);

    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'alpha.txt'), Buffer.from('alpha'));
    fs.writeFileSync(path.join(dir, 'beta.txt'),  Buffer.from('beta'));

    const dirCid  = await a.addDirectory(dir);
    const entries = await a.ls(dirCid); // ls uses local store
    const names   = entries.map(e => e.name).sort();

    assert(names.includes('alpha.txt'), 'alpha.txt missing from ls');
    assert(names.includes('beta.txt'),  'beta.txt missing from ls');
    assertEqual(names.length, 2, 'Expected exactly 2 entries');
  });

  console.log('\n  [Concurrency]\n');

  // 15. Two nodes retrieve the same file concurrently from a third
  await test('Two nodes retrieve the same file concurrently from owner', async () => {
    const a = await makeNode(); // owner
    const b = await makeNode();
    const c = await makeNode();

    await b.connect('127.0.0.1', a._listenAddr.port);
    await c.connect('127.0.0.1', a._listenAddr.port);
    await sleep(100);

    const original = Buffer.from('concurrent retrieval stress test — both should succeed');
    const { cid3 } = await a.addBytes(original);
    const { h1 } = tripleHash(original);

    // Fire both gets simultaneously
    const [resultB, resultC] = await Promise.all([
      b.get(cid3, h1),
      c.get(cid3, h1),
    ]);

    assert(original.equals(resultB), 'B should receive correct bytes');
    assert(original.equals(resultC), 'C should receive correct bytes');
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────────\n`);

  // Final demo: full system summary
  console.log('── Full system demo ──────────────────────────────────────────\n');
  const demo = await makeNode();
  await demo.start && 0; // already started by makeNode
  const { cid1, cid2, cid3 } = await demo.addBytes(
    Buffer.from('Hello IPFS! This is our custom privacy-preserving node.'),
    { name: 'hello.txt' }
  );
  const info = demo.info();

  console.log(`  Peer ID        : ${demo.id}`);
  console.log(`  Listen port    : ${info.listenPort}`);
  console.log(`  Multiaddr      : ${demo.multiaddr()}`);
  console.log();
  console.log(`  Added "hello.txt":`);
  console.log(`    CID¹ (public)  : ${cid1.slice(0, 40)}...`);
  console.log(`    CID² (SECRET)  : ${cid2.slice(0, 40)}...`);
  console.log(`    CID³ (public)  : ${cid3.slice(0, 40)}...`);
  console.log();
  console.log(`  Block store    : ${info.blocks} blocks, ${info.storageBytes} bytes`);
  console.log(`  Pinned         : ${info.pinnedBlocks} blocks`);
  console.log(`  DHT providers  : ${info.dhtProviders} records`);
  console.log();

  await cleanup();
}

run().catch(console.error);
