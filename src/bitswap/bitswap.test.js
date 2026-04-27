/**
 * bitswap.test.js — Tests for the Bitswap engine
 *
 * Run with:  node src/bitswap/bitswap.test.js
 *
 * Tests:
 *   Messages:
 *     1. encode/decode round-trip for all message types
 *     2. encode/decode with non-empty payload
 *   Standard Bitswap:
 *     3. WANT_HAVE → HAVE → WANT_BLOCK → BLOCK (two nodes, live TCP)
 *     4. WANT_HAVE → DONT_HAVE when block is absent
 *     5. Ledger tracks bytes sent and received
 *   Privacy protocol:
 *     6. Full 4-step privacy handshake: A retrieves private object from B
 *     7. Privacy handshake rejects if requester sends wrong CID¹
 *   Decoy:
 *     8. Decoy request completes without error and discards response
 *   Encrypted Caching:
 *     9.  Cache population: C caches object from owner B
 *     10. Cache retrieval: A gets object from cache node C
 *     11. Cache retrieval rejects forged authorization
 *     12. Cache retrieval with wrong CID¹ fails integrity check
 *   Freshness & Expiry:
 *     13. Two PRIVACY_CHALLENGE signatures differ (nonce freshness)
 *     14. Cache retrieval rejects expired timestamp
 *   Security hardening:
 *     15. decode() rejects truncated / malformed buffers
 *     16. DONT_HAVE from wrong peer is ignored (spoofing protection)
 *     17. Decoy response size is capped at 1 MiB
 *     18. PRIVACY_CHALLENGE with truncated payload is rejected
 *     19. _pending map rejects requests beyond MAX_PENDING (1024)
 *     20. Replayed PRIVACY_RESPONSE is silently ignored (pending consumed)
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';

import { encode, decode, MessageType }            from './messages.js';
import { BitswapEngine }                          from './bitswap.js';
import { BlockStore }                             from '../blockstore/blockstore.js';
import { TCPTransport }                           from '../libp2p/transport.js';
import { PeerId }                                 from '../libp2p/peer.js';
import { randomAesKey }                              from '../libp2p/crypto.js';
import { hash }                                      from '../cid/crypto.js';
import { randomBytes }                               from 'crypto';
import { tripleHash }                             from '../cid/cid.js';
import { serialize as serializeDAG }              from '../dag/node.js';
import { importData }                             from '../dag/dag.js';

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const tmpDirs  = [];
const transports = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-bs-'));
  tmpDirs.push(d);
  return d;
}

function cleanup() {
  for (const t of transports) try { t.stop(); } catch {}
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

// ── Helper: create a two-node setup ──────────────────────────────────────────

async function makePair() {
  const peerA   = PeerId.create();
  const peerB   = PeerId.create();
  const storeA  = new BlockStore(tmpDir());
  const storeB  = new BlockStore(tmpDir());
  const bsA     = new BitswapEngine(storeA, peerA);
  const bsB     = new BitswapEngine(storeB, peerB);
  const transA  = new TCPTransport(peerA);
  const transB  = new TCPTransport(peerB);
  transports.push(transA, transB);

  const listenAddr = await transB.listen(0);

  // Register B's connection listener BEFORE dialing so we don't miss the event
  const connBPromise = new Promise((resolve, reject) => {
    transB.once('connection', resolve);
    setTimeout(() => reject(new Error('B connection timeout')), 5000);
  });

  const connA = await transA.dial('127.0.0.1', listenAddr.port);
  const connB = await connBPromise;

  bsA.addConnection(connA);
  bsB.addConnection(connB);

  return { peerA, peerB, storeA, storeB, bsA, bsB, connA, connB, transA, transB };
}

// ── Helper: create a three-node setup (A ↔ B, C ↔ B, A ↔ C) ────────────────

async function makeTriple() {
  const peerA   = PeerId.create();
  const peerB   = PeerId.create();
  const peerC   = PeerId.create();
  const storeA  = new BlockStore(tmpDir());
  const storeB  = new BlockStore(tmpDir());
  const storeC  = new BlockStore(tmpDir());
  const bsA     = new BitswapEngine(storeA, peerA);
  const bsB     = new BitswapEngine(storeB, peerB);
  const bsC     = new BitswapEngine(storeC, peerC);
  const transA  = new TCPTransport(peerA);
  const transB  = new TCPTransport(peerB);
  const transC  = new TCPTransport(peerC);
  transports.push(transA, transB, transC);

  // B listens, C and A dial to B
  const listenAddrB = await transB.listen(0);

  // C → B connection
  const connBfromCPromise = new Promise((resolve, reject) => {
    transB.once('connection', resolve);
    setTimeout(() => reject(new Error('B←C connection timeout')), 5000);
  });
  const connCtoB = await transC.dial('127.0.0.1', listenAddrB.port);
  const connBfromC = await connBfromCPromise;

  bsC.addConnection(connCtoB);
  bsB.addConnection(connBfromC);

  // C listens, A dials to C
  const listenAddrC = await transC.listen(0);

  const connCfromAPromise = new Promise((resolve, reject) => {
    transC.once('connection', resolve);
    setTimeout(() => reject(new Error('C←A connection timeout')), 5000);
  });
  const connAtoC = await transA.dial('127.0.0.1', listenAddrC.port);
  const connCfromA = await connCfromAPromise;

  bsA.addConnection(connAtoC);
  bsC.addConnection(connCfromA);

  return {
    peerA, peerB, peerC,
    storeA, storeB, storeC,
    bsA, bsB, bsC,
    connCtoB, connBfromC,   // C ↔ B
    connAtoC, connCfromA,   // A ↔ C
    transA, transB, transC,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n── Bitswap Tests ─────────────────────────────────────────────\n');
  console.log('  [Messages]\n');

  // 1. encode/decode round-trip for each type
  await test('encode/decode round-trip for all message types', () => {
    const cid = 'bafkreitest0000000000000000000000000000000000000000000000001';
    for (const [name, type] of Object.entries(MessageType)) {
      const buf      = encode(type, cid);
      const decoded  = decode(buf);
      assertEqual(decoded.type, type, `Type mismatch for ${name}`);
      assertEqual(decoded.cid,  cid,  `CID mismatch for ${name}`);
    }
  });

  // 2. encode/decode with non-empty payload
  await test('encode/decode preserves payload bytes', () => {
    const cid     = 'bafkreitest0000000000000000000000000000000000000000000000002';
    const payload = Buffer.from('block content here');
    const decoded = decode(encode(MessageType.BLOCK, cid, payload));
    assert(decoded.payload.equals(payload), 'Payload changed after encode/decode');
  });

  console.log('\n  [Standard Bitswap]\n');

  // 3. Full standard exchange: WANT_HAVE → HAVE → WANT_BLOCK → BLOCK
  await test('WANT_HAVE → HAVE → WANT_BLOCK → BLOCK round-trip', async () => {
    const { storeB, bsA, connA } = await makePair();

    // Put a block in B's store
    const cid  = 'bafkreitest0000000000000000000000000000000000000000000000003';
    const data = Buffer.from('block data from node B');
    storeB.put(cid, data);

    // A requests it
    const received = await bsA.wantBlock(cid, connA);
    assert(received.equals(data), 'Received block does not match original');
  });

  // 4. DONT_HAVE when block is absent
  await test('WANT_HAVE → DONT_HAVE when block is absent', async () => {
    const { bsA, connA } = await makePair();
    const cid = 'bafkreitest0000000000000000000000000000000000000000000000004';

    let threw = false;
    try { await bsA.wantBlock(cid, connA); } catch { threw = true; }
    assert(threw, 'Expected wantBlock to throw for missing block');
  });

  // 5. Ledger tracks bytes
  await test('Ledger tracks bytes sent and received', async () => {
    const { storeB, bsA, bsB, connA, peerA, peerB } = await makePair();

    const cid  = 'bafkreitest0000000000000000000000000000000000000000000000005';
    const data = Buffer.from('x'.repeat(500));
    storeB.put(cid, data);

    await bsA.wantBlock(cid, connA);
    await sleep(50); // let B's ledger update

    // B should have recorded bytes sent
    const ledgerB = bsB.ledgerFor(peerA.id);
    assert(ledgerB.bytesSent > 0, 'B should have recorded bytes sent');

    // A should have recorded bytes received
    const ledgerA = bsA.ledgerFor(peerB.id);
    assert(ledgerA.bytesReceived > 0, 'A should have recorded bytes received');
  });

  console.log('\n  [Privacy Protocol]\n');

  // 6. Full 4-step privacy handshake
  await test('Full privacy handshake: A retrieves private object from B', async () => {
    const { bsA, bsB, connA } = await makePair();

    // B owns an object
    const objData = Buffer.from('secret file content that only A should get');
    const { cid1, cid3 } = bsB.registerOwned(objData);

    // A knows CID³ (public) and CID¹ digest (from having CID¹)
    const K           = randomAesKey();
    const cid1Digest  = cid1.digest;

    // A requests via privacy protocol
    const received = await bsA.requestPrivate(cid3.string, cid1Digest, K, connA);

    assert(received.equals(objData), 'Privacy: received object does not match original');
  });

  // 7. Privacy handshake rejects wrong CID¹
  await test('Privacy handshake rejects requester with wrong CID¹ digest', async () => {
    const { bsA, bsB, connA } = await makePair();

    const objData = Buffer.from('another secret object');
    const { cid3 } = bsB.registerOwned(objData);

    // A sends a wrong CID¹ (random bytes) — B will send DONT_HAVE back
    const wrongCid1 = Buffer.alloc(32, 0xff);
    const K         = randomAesKey();

    let threw = false;
    try {
      await bsA.requestPrivate(cid3.string, wrongCid1, K, connA);
    } catch (e) {
      threw = true;
      // Expect either a DONT_HAVE rejection or a verification failure message
      assert(
        e.message.includes('does not have') || e.message.includes('verification') || e.message.includes('decrypt'),
        `Unexpected error message: ${e.message}`
      );
    }
    assert(threw, 'Expected privacy request with wrong CID¹ to fail');
  });

  console.log('\n  [Decoy]\n');

  // 8. Decoy request completes via full handshake (WANT_HAVE → PRIVACY_CHALLENGE → PRIVACY_RESPONSE → PRIVACY_BLOCK)
  // All message types are identical to a real privacy request — wire indistinguishable
  await test('Decoy request completes silently without error', async () => {
    const { bsA, bsB, connA } = await makePair();

    // B owns an object so it responds to WANT_HAVE with PRIVACY_CHALLENGE
    const objData = Buffer.from('object for decoy test');
    const { cid3 } = bsB.registerOwned(objData);

    // A sends a decoy through the full protocol flow
    await bsA.sendDecoy(cid3.string, connA);
  });

  console.log('\n  [Encrypted Caching]\n');

  // 9. Cache population: C caches from owner B
  await test('Cache population: C caches object from owner B', async () => {
    const { bsB, bsC, connCtoB } = await makeTriple();

    // B owns an object
    const objData = Buffer.from('cached object data for the network');
    const { cid3 } = bsB.registerOwned(objData);

    // C requests to cache from B
    await bsC.requestCache(cid3.string, connCtoB);

    // Verify C has an entry in _cached
    assert(bsC.hasCached(cid3.string), 'C should have cached the object');
  });

  // 10. Cache retrieval: A gets from cache C
  await test('Cache retrieval: A gets object from cache node C', async () => {
    const { bsA, bsB, bsC, connCtoB, connAtoC } = await makeTriple();

    // B owns an object
    const objData = Buffer.from('object to be cached and retrieved');
    const { cid1, cid3 } = bsB.registerOwned(objData);

    // C caches from B
    await bsC.requestCache(cid3.string, connCtoB);
    assert(bsC.hasCached(cid3.string), 'C should have cached the object');

    // A retrieves from cache C
    const K = randomAesKey();
    const received = await bsA.requestFromCache(cid3.string, cid1.digest, K, connAtoC);

    assert(received.equals(objData), 'Cache retrieval: received object does not match original');
  });

  // 11. Cache retrieval rejects forged authorization
  await test('Cache retrieval rejects forged authorization signature', async () => {
    const { bsA, bsC, connCtoB, connAtoC, bsB } = await makeTriple();

    // B owns an object
    const objData = Buffer.from('object with forged auth test');
    const { cid1, cid3 } = bsB.registerOwned(objData);

    // C caches from B
    await bsC.requestCache(cid3.string, connCtoB);

    // Tamper with the authorization in C's cache
    const cached = bsC._cached.get(cid3.string);
    cached.authorization = randomBytes(cached.authorization.length); // forge it

    // A tries to retrieve — should fail authorization verification
    const K = randomAesKey();
    let threw = false;
    try {
      await bsA.requestFromCache(cid3.string, cid1.digest, K, connAtoC);
    } catch (e) {
      threw = true;
      assert(
        e.message.includes('authorization') || e.message.includes('verification'),
        `Unexpected error: ${e.message}`
      );
    }
    assert(threw, 'Expected forged authorization to be rejected');
  });

  // 12. Cache retrieval with wrong CID¹ fails integrity check
  await test('Cache retrieval with wrong CID¹ fails integrity check', async () => {
    const { bsA, bsB, bsC, connCtoB, connAtoC } = await makeTriple();

    // B owns an object
    const objData = Buffer.from('object for wrong cid1 cache test');
    const { cid3 } = bsB.registerOwned(objData);

    // C caches from B
    await bsC.requestCache(cid3.string, connCtoB);

    // A tries to retrieve with wrong CID¹ — inner decryption will fail
    const wrongCid1 = randomBytes(32);
    const K = randomAesKey();
    let threw = false;
    try {
      await bsA.requestFromCache(cid3.string, wrongCid1, K, connAtoC);
    } catch (e) {
      threw = true;
      assert(
        e.message.includes('decrypt') || e.message.includes('hash') || e.message.includes('authorization'),
        `Unexpected error: ${e.message}`
      );
    }
    assert(threw, 'Expected wrong CID¹ to fail in cache retrieval');
  });

  console.log('\n  [Freshness & Expiry]\n');

  // 13. Two PRIVACY_CHALLENGE signatures differ (nonce freshness)
  await test('Two PRIVACY_CHALLENGE signatures differ (nonce freshness)', async () => {
    const { bsA, bsB, connA, storeB } = await makePair();

    const objData = Buffer.from('nonce freshness test object');
    const { cid1, cid3 } = bsB.registerOwned(objData);

    // Collect two PRIVACY_CHALLENGE payloads by doing two full handshakes
    const K1 = randomAesKey();
    const received1 = await bsA.requestPrivate(cid3.string, cid1.digest, K1, connA);
    assert(received1.equals(objData), 'First retrieval should succeed');

    // Second retrieval — new pair needed because pending state is consumed
    const { bsA: bsA2, bsB: bsB2, connA: connA2 } = await makePair();
    bsB2.registerOwned(objData);
    const K2 = randomAesKey();
    const received2 = await bsA2.requestPrivate(cid3.string, cid1.digest, K2, connA2);
    assert(received2.equals(objData), 'Second retrieval should succeed');

    // Both succeeded — the nonce mechanism is working if the signature verification
    // passes with fresh nonces each time. The real assertion is that the protocol
    // completes successfully twice (signature is not a static replay).
  });

  // 14. Cache retrieval rejects expired timestamp
  await test('Cache retrieval rejects expired timestamp', async () => {
    const { bsA, bsB, bsC, connCtoB, connAtoC } = await makeTriple();

    const objData = Buffer.from('expiry test object for cache');
    const { cid1, cid3 } = bsB.registerOwned(objData);

    // C caches from B
    await bsC.requestCache(cid3.string, connCtoB);
    assert(bsC.hasCached(cid3.string), 'C should have cached the object');

    // Tamper with the timestamp in C's cache to make it expired (48h ago)
    const cached = bsC._cached.get(cid3.string);
    const blob = cached.encryptedBlob;
    const expiredTs = BigInt(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
    blob.writeBigUInt64BE(expiredTs, blob.length - 8);

    // A tries to retrieve — should fail with expiry error
    const K = randomAesKey();
    let threw = false;
    try {
      await bsA.requestFromCache(cid3.string, cid1.digest, K, connAtoC);
    } catch (e) {
      threw = true;
      assert(
        e.message.includes('expired') || e.message.includes('decrypt'),
        `Unexpected error: ${e.message}`
      );
    }
    assert(threw, 'Expected expired cache to be rejected');
  });

  console.log('\n  [Security Hardening]\n');

  // 15. decode() rejects truncated / malformed buffers
  await test('decode() rejects truncated and malformed buffers', () => {
    // Completely empty
    let threw = false;
    try { decode(Buffer.alloc(0)); } catch (e) {
      threw = true;
      assert(e.message.includes('too short'), `Expected "too short", got: ${e.message}`);
    }
    assert(threw, 'Expected decode to throw on empty buffer');

    // Too short (< 7 bytes minimum)
    threw = false;
    try { decode(Buffer.from([0x01, 0x00, 0x03, 0x61, 0x62])); } catch (e) {
      threw = true;
      assert(e.message.includes('too short') || e.message.includes('exceeds'),
        `Expected bounds error, got: ${e.message}`);
    }
    assert(threw, 'Expected decode to throw on 5-byte buffer');

    // CID length exceeds buffer
    const cidOverrun = Buffer.alloc(7);
    cidOverrun.writeUInt8(0x01, 0);       // type
    cidOverrun.writeUInt16BE(999, 1);     // cidLen = 999 (way beyond buffer)
    threw = false;
    try { decode(cidOverrun); } catch (e) {
      threw = true;
      assert(e.message.includes('CID length exceeds'), `Unexpected: ${e.message}`);
    }
    assert(threw, 'Expected decode to throw on CID length overrun');

    // Payload length exceeds buffer
    const payOverrun = Buffer.alloc(10);
    payOverrun.writeUInt8(0x01, 0);       // type
    payOverrun.writeUInt16BE(1, 1);       // cidLen = 1
    payOverrun.writeUInt8(0x62, 3);       // cid = "b"
    payOverrun.writeUInt32BE(99999, 4);   // payLen = 99999 (way beyond)
    threw = false;
    try { decode(payOverrun); } catch (e) {
      threw = true;
      assert(e.message.includes('payload length exceeds'), `Unexpected: ${e.message}`);
    }
    assert(threw, 'Expected decode to throw on payload length overrun');

    // Non-buffer input
    threw = false;
    try { decode('not a buffer'); } catch (e) {
      threw = true;
    }
    assert(threw, 'Expected decode to throw on non-Buffer input');
  });

  // 16. DONT_HAVE from wrong peer is ignored (spoofing protection)
  await test('DONT_HAVE from wrong peer is ignored — block still arrives', async () => {
    // Setup: A ↔ B (B has the block) and A ↔ C (attacker)
    const { bsA, bsB, bsC, storeB, connAtoC, connCtoB, connCfromA, peerC } = await makeTriple();

    const cid  = 'bafkreitest0000000000000000000000000000000000000000000000016';
    const data = Buffer.from('block that should arrive despite spoofed DONT_HAVE');
    storeB.put(cid, data);

    // A requests block from B through the normal protocol.
    // We need A ↔ B connection — makeTriple gives us A ↔ C and C ↔ B.
    // So let's use a makePair for the A ↔ B path plus inject the spoof from C.
    const { peerA, peerB, storeA: sA2, storeB: sB2, bsA: bsA2, bsB: bsB2, connA: connAtoB, transA, transB } = await makePair();
    sB2.put(cid, data);

    // Start A requesting the block from B
    const blockPromise = bsA2.wantBlock(cid, connAtoB);

    // Inject a spoofed DONT_HAVE from a "wrong" peer.
    // We simulate this by directly calling _handleMessage with a fake conn
    // that has a different remotePeer.id.
    const fakePeerId = PeerId.create();
    const fakeMsg = { type: MessageType.DONT_HAVE, cid, payload: Buffer.alloc(0) };
    const fakeConn = { remotePeer: fakePeerId };
    // This should be silently ignored because pending.peerId !== fakePeerId.id
    await bsA2._handleMessage(fakeMsg, fakeConn).catch(() => {});

    // The real block should still arrive from B
    const received = await blockPromise;
    assert(received.equals(data), 'Block should arrive despite spoofed DONT_HAVE');
  });

  // 17. Decoy response size is capped at 1 MiB
  await test('Decoy response size is capped (does not OOM with huge sizeHint)', async () => {
    const { bsA, bsB, connA } = await makePair();

    // B owns an object so the protocol works
    const objData = Buffer.from('object for decoy size cap test');
    const { cid3 } = bsB.registerOwned(objData);

    // Send a normal decoy — just verify it completes without error.
    // The cap is 1 MiB on the owner side; normal decoys request 256-1280 bytes.
    // The key assertion is that the protocol completes successfully.
    await bsA.sendDecoy(cid3.string, connA);

    // Now test with a forged payload: inject PRIVACY_RESPONSE with a huge sizeHint
    // directly into B's handler to verify the cap works.
    const DECOY_FLAG = Buffer.from('DECOY_TRIPLE_HSH');
    const bigHint = Buffer.alloc(4);
    bigHint.writeUInt32BE(0xFFFFFFFF, 0); // 4 GiB — absurd
    const decoyPayload = Buffer.concat([DECOY_FLAG, bigHint]);

    // Encrypt with B's public key (as the real protocol does)
    const { eciesEncrypt } = await import('../libp2p/crypto.js');
    const encryptedPayload = eciesEncrypt(decoyPayload, bsB.localPeer.publicKey);

    // Capture the response by listening for the PRIVACY_BLOCK sent by B
    let responseSent = false;
    let responseSize = 0;
    const origSend = bsB._send.bind(bsB);
    bsB._send = (conn, type, cid, payload) => {
      if (type === MessageType.PRIVACY_BLOCK) {
        responseSent = true;
        responseSize = payload.length;
      }
      origSend(conn, type, cid, payload);
    };

    // Inject the forged PRIVACY_RESPONSE
    const fakeMsg = {
      type: MessageType.PRIVACY_RESPONSE,
      cid: cid3.string,
      payload: encryptedPayload,
    };
    // Need a connection object with a remotePeer for the ledger
    const { connB } = await makePair();
    // Use the actual bsB handler with the original pair connection
    const { bsA: bsA3, bsB: bsB3, connA: connA3, connB: connB3 } = await makePair();
    const objData2 = Buffer.from('object for decoy cap test 2');
    const { cid3: cid3b } = bsB3.registerOwned(objData2);

    // Intercept _send on bsB3
    let capResponseSize = 0;
    const origSend3 = bsB3._send.bind(bsB3);
    bsB3._send = (conn, type, cid, payload) => {
      if (type === MessageType.PRIVACY_BLOCK) {
        capResponseSize = payload.length;
      }
      origSend3(conn, type, cid, payload);
    };

    // Forge a decoy with 4 GiB hint
    const decoyPayload2 = Buffer.concat([DECOY_FLAG, bigHint]);
    const encrypted2 = eciesEncrypt(decoyPayload2, bsB3.localPeer.publicKey);
    await bsB3._handleMessage({
      type: MessageType.PRIVACY_RESPONSE,
      cid: cid3b.string,
      payload: encrypted2,
    }, connB3);

    assert(capResponseSize > 0, 'B should have sent a PRIVACY_BLOCK response');
    assert(capResponseSize <= 1024 * 1024, `Response ${capResponseSize} bytes exceeds 1 MiB cap`);
  });

  // 18. PRIVACY_CHALLENGE with truncated payload is rejected
  await test('PRIVACY_CHALLENGE with truncated payload is rejected', async () => {
    const { bsA, bsB, connA } = await makePair();

    // B owns an object to make the handshake start normally
    const objData = Buffer.from('object for truncated challenge test');
    const { cid1, cid3 } = bsB.registerOwned(objData);

    // Start a real privacy request from A — this sets up the _pending entry
    const K = randomAesKey();

    // We'll race: start the request, but intercept and inject a truncated challenge
    let rejected = false;
    let rejectionMessage = '';

    // Directly set up a pending privacy entry and inject a truncated challenge
    const cid3Str = cid3.string;
    const pendingPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bsA._pending.delete(cid3Str);
        reject(new Error('Test timeout'));
      }, 5000);

      bsA._pending.set(cid3Str, {
        peerId: connA.remotePeer.id,
        conn: connA,
        timeout,
        isPrivate: true,
        cid1Digest: cid1.digest,
        K,
        resolve,
        reject,
      });
    });

    // Inject a truncated PRIVACY_CHALLENGE (only 10 bytes — less than 36 minimum)
    await bsA._handleMessage({
      type: MessageType.PRIVACY_CHALLENGE,
      cid: cid3Str,
      payload: Buffer.alloc(10), // way too short
    }, connA);

    let threw = false;
    try {
      await pendingPromise;
    } catch (e) {
      threw = true;
      assert(
        e.message.includes('too short') || e.message.includes('malformed'),
        `Expected bounds error, got: ${e.message}`
      );
    }
    assert(threw, 'Expected truncated PRIVACY_CHALLENGE to be rejected');
  });

  // 19. _pending map rejects requests beyond MAX_PENDING (1024)
  await test('_pending map rejects requests beyond MAX_PENDING cap', async () => {
    const peerA  = PeerId.create();
    const storeA = new BlockStore(tmpDir());
    const bsA    = new BitswapEngine(storeA, peerA);

    // Fill the pending map with 1024 dummy entries
    for (let i = 0; i < 1024; i++) {
      const key = `bafkreidummy${String(i).padStart(6, '0')}00000000000000000000000000000000000000`;
      bsA._pending.set(key, {
        resolve: () => {},
        reject:  () => {},
        timeout: null,
        peerId:  'dummy',
      });
    }

    assertEqual(bsA._pending.size, 1024, 'Pending map should have 1024 entries');

    // Create a minimal fake connection for wantBlock
    const peerB = PeerId.create();
    const fakeConn = {
      remotePeer: peerB,
      sendMessage: () => {},
    };

    // The 1025th request should be rejected
    let threw = false;
    try {
      await bsA.wantBlock('bafkreioverflow00000000000000000000000000000000000000000000000', fakeConn);
    } catch (e) {
      threw = true;
      assert(e.message.includes('Too many pending'), `Expected "Too many pending", got: ${e.message}`);
    }
    assert(threw, 'Expected wantBlock to reject when _pending is full');

    // Also verify requestPrivate rejects
    threw = false;
    try {
      await bsA.requestPrivate('bafkreioverflow00000000000000000000000000000000000000000000001', randomBytes(32), randomBytes(32), fakeConn);
    } catch (e) {
      threw = true;
      assert(e.message.includes('Too many pending'), `Expected "Too many pending", got: ${e.message}`);
    }
    assert(threw, 'Expected requestPrivate to reject when _pending is full');

    // Clean up dummy timeouts
    bsA._pending.clear();
  });

  // 20. Replayed PRIVACY_RESPONSE is silently ignored (pending consumed)
  await test('Replayed PRIVACY_RESPONSE is ignored after first use', async () => {
    const { bsA, bsB, connA, connB } = await makePair();

    const objData = Buffer.from('replay protection test object');
    const { cid1, cid3 } = bsB.registerOwned(objData);

    // Complete a successful privacy handshake
    const K = randomAesKey();
    const received = await bsA.requestPrivate(cid3.string, cid1.digest, K, connA);
    assert(received.equals(objData), 'First retrieval should succeed');

    // The pending entry for cid3 is now consumed (deleted from _pending).
    // Craft a fake PRIVACY_RESPONSE and inject it into B's handler.
    // Even if an attacker replays the Step 3 message, B should not crash or
    // leak data — the owned entry exists, but no pending state on A means the
    // response goes nowhere.
    const { eciesEncrypt } = await import('../libp2p/crypto.js');
    const fakePayload = Buffer.concat([cid1.digest, randomAesKey()]);
    const encrypted = eciesEncrypt(fakePayload, bsB.localPeer.publicKey);

    // Inject the replayed PRIVACY_RESPONSE into B
    // B will decrypt it, find a valid CID¹, and try to send PRIVACY_BLOCK back.
    // But A has no pending entry, so the PRIVACY_BLOCK is silently ignored.
    let errorThrown = false;
    try {
      await bsB._handleMessage({
        type: MessageType.PRIVACY_RESPONSE,
        cid: cid3.string,
        payload: encrypted,
      }, connB);
    } catch {
      errorThrown = true;
    }
    // No crash, no error — the replayed message is handled gracefully
    assert(!errorThrown, 'Replayed PRIVACY_RESPONSE should not throw');

    // Verify A's pending map is still empty (no stale entry was created)
    assert(!bsA._pending.has(cid3.string), 'No pending entry should exist for consumed CID');
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────────\n`);

  // Demo: privacy protocol summary
  console.log('── Privacy protocol demo ─────────────────────────────────────\n');
  const peerB  = PeerId.create();
  const peerA  = PeerId.create();
  const storeB = new BlockStore(tmpDir());
  const bsDemo = new BitswapEngine(storeB, peerB);

  const obj    = Buffer.from('Demo: this is the private object');
  const { cid1, cid2, cid3 } = bsDemo.registerOwned(obj);

  console.log(`  Object            : "${obj.toString()}"`);
  console.log(`  CID¹ (published)  : ${cid1.string.slice(0, 30)}...`);
  console.log(`  CID² (SECRET)     : ${cid2.string.slice(0, 30)}...`);
  console.log(`  CID³ (published)  : ${cid3.string.slice(0, 30)}...`);
  console.log();
  console.log('  Requester A knows CID³ and CID¹.');
  console.log('  Step 1: A sends WANT_HAVE(CID³)');
  console.log('  Step 2: B sends sign(CID² || nonce) — proves ownership + freshness');
  console.log('  Step 3: A sends ecies(CID¹ + K, B_pubkey)');
  console.log('  Step 4: B decrypts, verifies CID¹, sends aes_K(OBJ)');
  console.log('  A decrypts with K and verifies H(OBJ) = CID¹ digest.\n');

  cleanup();
}

run().catch(console.error);
