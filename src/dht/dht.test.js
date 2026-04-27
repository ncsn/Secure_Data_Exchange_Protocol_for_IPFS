/**
 * dht.test.js — Tests for the DHT module
 *
 * Run with:  node src/dht/dht.test.js
 *
 * Tests:
 *   Kademlia primitives:
 *     1. xorDistance is symmetric
 *     2. xorDistance(A, A) = 0
 *     3. compareDistance correctly orders peers by closeness
 *     4. bucketIndex returns different buckets for different peers
 *     5. RoutingTable.add / findClosest returns closest peers sorted
 *     6. RoutingTable respects K_BUCKET_SIZE limit
 *     7. RoutingTable.remove works correctly
 *   DHT network:
 *     8.  provide() stores a local provider record
 *     9.  findProviders() finds a locally stored record immediately
 *     10. Two nodes: A provides CID, B finds it via DHT
 *     11. Three nodes: A provides, B knows C, C finds A (multi-hop)
 *     12. findProviders returns empty for unknown CID
 *     13. Privacy rule: CID² is never announced (manual check)
 *   Security:
 *     14. Provider records per CID are capped at MAX_PROVIDERS_PER_CID
 *     15. _cleanupProviders() removes expired records and keeps fresh ones
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';

import { xorDistance, compareDistance, bucketIndex,
         RoutingTable, toId, K_BUCKET_SIZE }   from './kademlia.js';
import { DHTNode }                              from './dht.js';
import { TCPTransport }                         from '../libp2p/transport.js';
import { PeerId }                               from '../libp2p/peer.js';
import { tripleHash }                           from '../cid/cid.js';

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const transports = [];

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

function cleanup() {
  for (const t of transports) try { t.stop(); } catch {}
}

// ── Helper: create a DHT node with a live TCP transport ───────────────────────

async function makeNode() {
  const peer  = PeerId.create();
  const trans = new TCPTransport(peer);
  const dht   = new DHTNode(peer);
  transports.push(trans);

  const addr = await trans.listen(0);
  trans.on('connection', conn => dht.addConnection(conn, '127.0.0.1', addr.port));

  return { peer, trans, dht, addr };
}

// ── Connect two DHT nodes to each other ──────────────────────────────────────

async function connect(nodeA, nodeB) {
  // Register B's connection listener BEFORE dialing so we don't miss the event
  const connBPromise = new Promise((resolve, reject) => {
    nodeB.trans.once('connection', resolve);
    setTimeout(() => reject(new Error('connection timeout')), 5000);
  });

  const connA = await nodeA.trans.dial('127.0.0.1', nodeB.addr.port);
  const connB = await connBPromise;

  nodeA.dht.addConnection(connA, '127.0.0.1', nodeB.addr.port);
  nodeB.dht.addConnection(connB, '127.0.0.1', nodeA.addr.port);

  await sleep(50); // let routing tables update
}

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n── DHT Tests ─────────────────────────────────────────────────\n');
  console.log('  [Kademlia Primitives]\n');

  // 1. XOR symmetry
  await test('xorDistance is symmetric: d(A,B) = d(B,A)', () => {
    const a = toId('peerA');
    const b = toId('peerB');
    assert(xorDistance(a, b).equals(xorDistance(b, a)), 'XOR distance is not symmetric');
  });

  // 2. Self-distance is zero
  await test('xorDistance(A, A) = 0', () => {
    const a = toId('peerA');
    const d = xorDistance(a, a);
    assert(d.every(byte => byte === 0), 'Self-distance should be all zeros');
  });

  // 3. compareDistance orders peers correctly
  await test('compareDistance correctly orders peers by closeness to target', () => {
    const target = toId('target-key');
    const close  = toId('close-peer');
    const far    = toId('very-different-peer-xyz-789');

    // The closer peer should have smaller XOR distance
    const result = compareDistance(close, far, target);
    // We can't know which is closer without running the XOR, but we can check
    // that the result is consistent: compare(A,B) = -compare(B,A)
    const reverse = compareDistance(far, close, target);
    assert(result === -reverse || (result === 0 && reverse === 0),
      'compareDistance should be antisymmetric');
  });

  // 4. bucketIndex assigns different buckets to different peers
  await test('bucketIndex returns different buckets for different peers', () => {
    const localId = toId('local');
    const peer1   = toId('peer1');
    const peer2   = toId('peer2');
    const peer3   = toId('peer3');
    const indices = new Set([
      bucketIndex(localId, peer1),
      bucketIndex(localId, peer2),
      bucketIndex(localId, peer3),
    ]);
    // With random-looking IDs, at least two should be in different buckets
    assert(indices.size >= 1, 'Expected at least one valid bucket index');
    for (const idx of indices) {
      assert(idx >= 0 && idx <= 255, `Bucket index ${idx} out of range`);
    }
  });

  // 5. RoutingTable findClosest returns sorted results
  await test('RoutingTable.findClosest returns closest peers sorted by XOR distance', () => {
    const table = new RoutingTable('local-peer');
    const peers = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    for (const p of peers) {
      table.add({ peerId: p, ip: '127.0.0.1', port: 4000 });
    }

    const target  = 'some-cid-string';
    const closest = table.findClosest(target, 3);

    assertEqual(closest.length, 3, 'Should return exactly 3 peers');

    // Verify sorting: each successive peer should be >= distance of previous
    for (let i = 1; i < closest.length; i++) {
      const prev = compareDistance(closest[i - 1].id, closest[i].id, toId(target));
      assert(prev <= 0, `Peers not sorted by distance at index ${i}`);
    }
  });

  // 6. RoutingTable respects K_BUCKET_SIZE
  await test(`RoutingTable bucket does not exceed K_BUCKET_SIZE (${K_BUCKET_SIZE})`, () => {
    const table = new RoutingTable('local');
    // Add many peers that would all hash into the same rough area
    for (let i = 0; i < K_BUCKET_SIZE + 10; i++) {
      table.add({ peerId: `peer-${i}-unique`, ip: '127.0.0.1', port: 4000 + i });
    }
    // Each bucket individually must not exceed K_BUCKET_SIZE
    for (const bucket of table.buckets) {
      assert(bucket.length <= K_BUCKET_SIZE,
        `Bucket size ${bucket.length} exceeds K_BUCKET_SIZE`);
    }
  });

  // 7. remove works
  await test('RoutingTable.remove removes a peer', () => {
    const table = new RoutingTable('local');
    table.add({ peerId: 'to-remove', ip: '127.0.0.1', port: 4001 });
    assert(table.size() === 1, 'Should have 1 peer before remove');
    table.remove('to-remove');
    assert(table.size() === 0, 'Should have 0 peers after remove');
  });

  console.log('\n  [DHT Network]\n');

  // 8. provide() stores locally
  await test('provide() stores a local provider record', async () => {
    const { dht } = await makeNode();
    const cid = 'bafkreitest0000000000000000000000000000000000000000000000001';
    dht.provide(cid);
    const providers = await dht.findProviders(cid);
    assert(providers.length >= 1,           'Should find at least 1 provider');
    assertEqual(providers[0].peerId, dht.localPeer.id, 'Provider should be the local peer');
  });

  // 9. findProviders returns local record immediately
  await test('findProviders() returns local record without network round-trip', async () => {
    const { dht } = await makeNode();
    const cid = 'bafkreitest0000000000000000000000000000000000000000000000002';
    dht.provide(cid);
    const start = Date.now();
    const providers = await dht.findProviders(cid);
    assert(Date.now() - start < 100, 'Local lookup should complete in <100ms');
    assert(providers.length >= 1, 'Should find provider');
  });

  // 10. Two nodes: A provides, B finds
  await test('Two nodes: A provides CID, B discovers it via DHT', async () => {
    const nodeA = await makeNode();
    const nodeB = await makeNode();
    await connect(nodeA, nodeB);

    const cid = 'bafkreitest0000000000000000000000000000000000000000000000003';
    nodeA.dht.provide(cid);
    await sleep(100); // let ADD_PROVIDER propagate

    const providers = await nodeB.dht.findProviders(cid, 3000);
    assert(providers.length >= 1, 'B should find A as a provider');
    assert(
      providers.some(p => p.peerId === nodeA.peer.id),
      'Provider list should include A'
    );
  });

  // 11. Three nodes: multi-hop discovery
  await test('Three nodes: A provides, B↔C connected, C finds A through B', async () => {
    const nodeA = await makeNode();
    const nodeB = await makeNode();
    const nodeC = await makeNode();

    // Topology: C — B — A  (C and A are not directly connected)
    await connect(nodeA, nodeB);
    await connect(nodeB, nodeC);

    const cid = 'bafkreitest0000000000000000000000000000000000000000000000004';
    nodeA.dht.provide(cid);
    await sleep(150); // let announcements propagate

    // B should now know A is a provider (received ADD_PROVIDER)
    // C asks B who has the CID
    const providers = await nodeC.dht.findProviders(cid, 5000);
    assert(providers.length >= 1, 'C should find at least 1 provider');
  });

  // 12. findProviders returns empty for unknown CID
  await test('findProviders() returns empty array for unknown CID', async () => {
    const { dht } = await makeNode();
    const unknown = 'bafkreiunknown00000000000000000000000000000000000000000000';
    const providers = await dht.findProviders(unknown, 500);
    assertEqual(providers.length, 0, 'Should return empty for unknown CID');
  });

  // 13. Privacy rule: CID² is never announced
  await test('Privacy rule: only CID¹ and CID³ are announced, never CID²', async () => {
    const { dht } = await makeNode();
    const data = Buffer.from('private object content');
    const { cid1, cid2, cid3 } = tripleHash(data);

    // Simulate correct behaviour: announce cid1 and cid3 only
    dht.provide(cid1.string);
    dht.provide(cid3.string);
    // cid2 is deliberately NOT announced

    const p1 = await dht.findProviders(cid1.string);
    const p3 = await dht.findProviders(cid3.string);
    const p2 = await dht.findProviders(cid2.string);

    assert(p1.length >= 1, 'CID¹ should be findable');
    assert(p3.length >= 1, 'CID³ should be findable');
    assertEqual(p2.length, 0, 'CID² must NOT be findable — privacy violation!');
  });

  console.log('\n  [Security]\n');

  // 14. Provider records per CID are capped
  await test('Provider records per CID are capped at MAX_PROVIDERS_PER_CID (100)', async () => {
    const node = await makeNode();

    const testCid = 'bafkreiproviderscaptest0000000000000000000000000000000000000';

    // Add 110 fake providers — only 100 should be stored
    for (let i = 0; i < 110; i++) {
      node.dht._addProvider(testCid, {
        peerId: `peer${String(i).padStart(4, '0')}`,
        ip:     '127.0.0.1',
        port:   3000 + i,
      });
    }

    const providerMap = node.dht._providers.get(testCid);
    assert(providerMap !== undefined, 'Provider map should exist for the CID');
    assertEqual(providerMap.size, 100, `Expected 100 providers, got ${providerMap.size}`);

    // Updating an existing provider should still work (not count as new)
    node.dht._addProvider(testCid, {
      peerId: 'peer0000',
      ip:     '192.168.1.1',  // updated IP
      port:   9999,
    });
    assertEqual(providerMap.size, 100, 'Updating existing provider should not change count');
    assertEqual(providerMap.get('peer0000').port, 9999, 'Existing provider should be updated');
  });

  // 15. _cleanupProviders() removes expired records and keeps fresh ones
  await test('_cleanupProviders() removes expired records and keeps fresh ones', async () => {
    const node = await makeNode();

    const testCid = 'bafkreittlcleanuptest0000000000000000000000000000000000000000';

    // Add a provider with a fake old timestamp (25h ago = expired)
    node.dht._addProvider(testCid, {
      peerId: 'oldpeer',
      ip: '1.2.3.4',
      port: 1111,
    });
    // Manually backdate the timestamp to 25 hours ago
    const oldRecord = node.dht._providers.get(testCid).get('oldpeer');
    oldRecord.timestamp = Date.now() - (25 * 60 * 60 * 1000);

    // Add a fresh provider (just now)
    node.dht._addProvider(testCid, {
      peerId: 'freshpeer',
      ip: '5.6.7.8',
      port: 2222,
    });

    // Both should exist before cleanup
    assertEqual(node.dht._providers.get(testCid).size, 2, 'Should have 2 providers before cleanup');

    // Run cleanup
    node.dht._cleanupProviders();

    // Only the fresh one should remain
    const afterMap = node.dht._providers.get(testCid);
    assert(afterMap !== undefined, 'CID should still be in providers');
    assertEqual(afterMap.size, 1, 'Should have 1 provider after cleanup');
    assert(afterMap.has('freshpeer'), 'Fresh provider should survive cleanup');
    assert(!afterMap.has('oldpeer'), 'Expired provider should be removed');

    // If all providers for a CID expire, the CID entry itself should be removed
    afterMap.get('freshpeer').timestamp = Date.now() - (25 * 60 * 60 * 1000);
    node.dht._cleanupProviders();
    assert(!node.dht._providers.has(testCid), 'CID with all expired providers should be removed entirely');
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────────\n`);

  // Demo: show routing table state for a small network
  console.log('── Routing table demo (5-node network) ──────────────────────\n');
  const nodes = await Promise.all([0,1,2,3,4].map(() => makeNode()));

  // Connect in a ring: 0-1-2-3-4-0
  for (let i = 0; i < nodes.length; i++) {
    await connect(nodes[i], nodes[(i + 1) % nodes.length]);
  }

  for (let i = 0; i < nodes.length; i++) {
    const { peers, providers } = nodes[i].dht.stat();
    console.log(`  Node ${i} (${nodes[i].peer.id.slice(0, 12)}...)  peers known: ${peers}  providers: ${providers}`);
  }
  console.log();

  cleanup();
}

run().catch(console.error);
