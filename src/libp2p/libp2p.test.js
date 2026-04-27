/**
 * libp2p.test.js — Tests for the libp2p layer
 *
 * Run with:  node src/libp2p/libp2p.test.js
 *
 * Tests:
 *   Crypto:
 *     1. generateKeyPair() produces distinct key pairs
 *     2. sign/verify round-trip
 *     3. verify returns false for wrong key
 *     4. verify returns false for tampered data
 *     5. eciesEncrypt/Decrypt round-trip
 *     6. eciesDecrypt fails with wrong private key
 *     7. aesEncrypt/Decrypt round-trip
 *     8. randomAesKey() produces 32 random bytes
 *   Peer:
 *     9.  PeerId.create() produces unique peer IDs
 *     10. Same public key always produces the same peer ID
 *     11. Multiaddr toString/parse round-trip
 *     12. Multiaddr parse handles address with and without peerId
 *   Network:
 *     13. Two nodes can connect over TCP and complete the handshake
 *     14. After handshake, each node knows the other's peer ID
 *     15. Nodes can exchange protocol messages after connecting
 *   Security:
 *     16. Connection closes when receiving a frame with oversized protocol name
 *     17. Connection closes when receiving a frame with oversized payload
 *     18. Handshake times out when remote peer doesn't respond
 *     19. Handshake rejects invalid nonce signature
 */

import net from 'net';
import { generateKeyPair, sign, verify, eciesEncrypt, eciesDecrypt,
         aesEncrypt, aesDecrypt, randomAesKey } from './crypto.js';
import { PeerId, Multiaddr }                    from './peer.js';
import { TCPTransport, performHandshake, Connection } from './transport.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => { console.log(`  ✓  ${name}`); passed++; })
        .catch(e  => { console.log(`  ✗  ${name}`); console.log(`     ${e.message}`); failed++; });
    }
    console.log(`  ✓  ${name}`); passed++;
  } catch (e) {
    console.log(`  ✗  ${name}`); console.log(`     ${e.message}`); failed++;
  }
  return Promise.resolve();
}

function assert(cond, msg)      { if (!cond)    throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b)  throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`); }
function assertNotEqual(a, b, msg) { if (a === b) throw new Error(msg || 'Expected values to differ'); }

// ── Run all tests sequentially ────────────────────────────────────────────────

async function run() {
  console.log('\n── libp2p Tests ──────────────────────────────────────────────\n');
  console.log('  [Crypto]\n');

  // 1. Key pair generation
  await test('generateKeyPair() produces distinct key pairs', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    assertNotEqual(
      kp1.publicKeyRaw.toString('hex'),
      kp2.publicKeyRaw.toString('hex'),
      'Two key pairs should not be identical'
    );
    assert(kp1.publicKeyRaw.length > 0, 'Public key should have bytes');
  });

  // 2. Sign / verify round-trip
  await test('sign/verify round-trip with same key', () => {
    const { privateKey, publicKey } = generateKeyPair();
    const data = Buffer.from('sign this message');
    const sig  = sign(data, privateKey);
    assert(verify(data, sig, publicKey), 'Signature should verify');
  });

  // 3. Verify fails with wrong key
  await test('verify() returns false with a different public key', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const sig  = sign(Buffer.from('message'), kp1.privateKey);
    assert(!verify(Buffer.from('message'), sig, kp2.publicKey), 'Should not verify with wrong key');
  });

  // 4. Verify fails with tampered data
  await test('verify() returns false when data is tampered', () => {
    const { privateKey, publicKey } = generateKeyPair();
    const sig = sign(Buffer.from('original'), privateKey);
    assert(!verify(Buffer.from('tampered'), sig, publicKey), 'Should not verify tampered data');
  });

  // 5. ECIES encrypt/decrypt round-trip
  await test('eciesEncrypt/Decrypt round-trip', () => {
    const { privateKey, publicKey } = generateKeyPair();
    const plaintext  = Buffer.from('encrypt this secret message');
    const ciphertext = eciesEncrypt(plaintext, publicKey);
    const decrypted  = eciesDecrypt(ciphertext, privateKey);
    assert(plaintext.equals(decrypted), 'Decrypted text should match original');
    assert(!ciphertext.equals(plaintext), 'Ciphertext should differ from plaintext');
  });

  // 6. ECIES decrypt fails with wrong key
  await test('eciesDecrypt() throws with wrong private key', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const ct  = eciesEncrypt(Buffer.from('secret'), kp1.publicKey);
    let threw = false;
    try { eciesDecrypt(ct, kp2.privateKey); } catch { threw = true; }
    assert(threw, 'Should throw when decrypting with wrong key');
  });

  // 7. AES-GCM round-trip
  await test('aesEncrypt/Decrypt round-trip', () => {
    const key       = randomAesKey();
    const plaintext = Buffer.from('aes session data');
    const ct        = aesEncrypt(plaintext, key);
    const pt        = aesDecrypt(ct, key);
    assert(plaintext.equals(pt), 'AES round-trip failed');
  });

  // 8. randomAesKey produces 32 bytes
  await test('randomAesKey() produces 32 random bytes', () => {
    const k1 = randomAesKey();
    const k2 = randomAesKey();
    assertEqual(k1.length, 32, 'Key should be 32 bytes');
    assertNotEqual(k1.toString('hex'), k2.toString('hex'), 'Two keys should differ');
  });

  console.log('\n  [Peer Identity]\n');

  // 9. Unique peer IDs
  await test('PeerId.create() produces unique peer IDs each time', () => {
    const p1 = PeerId.create();
    const p2 = PeerId.create();
    assertNotEqual(p1.id, p2.id, 'Two peers should have different IDs');
    assert(p1.id.length > 0,    'Peer ID should not be empty');
  });

  // 10. Same public key → same peer ID
  await test('Same public key always produces the same peer ID', () => {
    const { publicKey, publicKeyRaw } = generateKeyPair();
    const peer1 = PeerId.fromPublicKey(publicKey, publicKeyRaw);
    const peer2 = PeerId.fromPublicKey(publicKey, publicKeyRaw);
    assertEqual(peer1.id, peer2.id, 'Same key should produce same peer ID');
  });

  // 11. Multiaddr round-trip
  await test('Multiaddr toString/parse round-trip', () => {
    const peer   = PeerId.create();
    const addr   = new Multiaddr('127.0.0.1', 4001, peer.id);
    const parsed = Multiaddr.parse(addr.toString());
    assertEqual(parsed.ip,     '127.0.0.1', 'IP mismatch after parse');
    assertEqual(parsed.port,   4001,         'Port mismatch after parse');
    assertEqual(parsed.peerId, peer.id,      'PeerId mismatch after parse');
  });

  // 12. Multiaddr without peerId
  await test('Multiaddr parses address without peerId component', () => {
    const parsed = Multiaddr.parse('/ip4/192.168.1.5/tcp/5001');
    assertEqual(parsed.ip,     '192.168.1.5', 'IP mismatch');
    assertEqual(parsed.port,   5001,           'Port mismatch');
    assertEqual(parsed.peerId, null,           'PeerId should be null');
  });

  console.log('\n  [Networking]\n');

  // 13–15: TCP connection tests
  const peerA = PeerId.create();
  const peerB = PeerId.create();
  const transA = new TCPTransport(peerA);
  const transB = new TCPTransport(peerB);

  let listenAddr;

  await test('Two nodes connect over TCP and complete the handshake', async () => {
    listenAddr = await transB.listen(0); // port 0 = OS picks a free port

    await new Promise((resolve, reject) => {
      transB.once('connection', () => resolve());
      transA.dial('127.0.0.1', listenAddr.port).catch(reject);
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
  });

  await test('After handshake, each node knows the other peer ID', async () => {
    // Dial again for a fresh connection we can inspect
    const connA = await transA.dial('127.0.0.1', listenAddr.port);

    // Wait for B to see the connection
    await new Promise(resolve => setTimeout(resolve, 100));

    assertEqual(connA.remotePeer.id, peerB.id, 'A should know B\'s peer ID');
  });

  await test('Nodes can exchange protocol messages after connecting', async () => {
    // Register B's listener BEFORE dialing so we don't miss the event
    const connBPromise = new Promise((resolve, reject) => {
      transB.once('connection', resolve);
      setTimeout(() => reject(new Error('No connection from B')), 5000);
    });

    const connA = await transA.dial('127.0.0.1', listenAddr.port);
    const connB = await connBPromise;

    const received = await new Promise((resolve, reject) => {
      connB.onMessage('/test/1.0', (payload) => resolve(payload));
      connA.sendMessage('/test/1.0', Buffer.from('hello from A'));
      setTimeout(() => reject(new Error('Message not received')), 3000);
    });

    assert(received.equals(Buffer.from('hello from A')), 'Message content mismatch');
  });

  console.log('\n  [Security]\n');

  // 16. Oversized protocol name → connection closed
  await test('Connection closes when receiving oversized protocol name (> 512)', async () => {
    // Create fresh pair for this test
    const peerC = PeerId.create();
    const peerD = PeerId.create();
    const transC = new TCPTransport(peerC);
    const transD = new TCPTransport(peerD);

    const addrD = await transD.listen(0);

    const connDPromise = new Promise((resolve, reject) => {
      transD.once('connection', resolve);
      setTimeout(() => reject(new Error('No conn from D')), 5000);
    });

    const connC = await transC.dial('127.0.0.1', addrD.port);
    const connD = await connDPromise;

    // Wait for the close event on D's side after sending an oversized frame
    const closedPromise = new Promise((resolve) => {
      connD.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });

    // Send a raw frame with protoLen = 1000 (> 512 limit)
    // Frame format: [ protoLen(2) | proto(N) | payloadLen(4) | payload(M) ]
    const evilFrame = Buffer.alloc(2 + 4);  // just the header is enough to trigger
    evilFrame.writeUInt16BE(1000, 0);  // protoLen = 1000
    evilFrame.writeUInt32BE(0, 2);     // payloadLen = 0
    // Write raw bytes to the underlying socket (bypass the protocol layer)
    connC.socket.write(evilFrame);

    const wasClosed = await closedPromise;
    assert(wasClosed, 'Connection should be closed after receiving oversized protocol name');

    transC.stop();
    transD.stop();
  });

  // 17. Oversized payload → connection closed
  await test('Connection closes when receiving oversized payload (> 16 MiB)', async () => {
    const peerE = PeerId.create();
    const peerF = PeerId.create();
    const transE = new TCPTransport(peerE);
    const transF = new TCPTransport(peerF);

    const addrF = await transF.listen(0);

    const connFPromise = new Promise((resolve, reject) => {
      transF.once('connection', resolve);
      setTimeout(() => reject(new Error('No conn from F')), 5000);
    });

    const connE = await transE.dial('127.0.0.1', addrF.port);
    const connF = await connFPromise;

    const closedPromise = new Promise((resolve) => {
      connF.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });

    // Valid short protocol name (5 bytes: "/t/1\0") + absurd payload length
    const protoName = Buffer.from('/t/1\0', 'utf8');
    const frame = Buffer.alloc(2 + protoName.length + 4);
    frame.writeUInt16BE(protoName.length, 0);
    protoName.copy(frame, 2);
    frame.writeUInt32BE(0x01000001, 2 + protoName.length);  // ~16.7 MiB > 16 MiB cap
    connE.socket.write(frame);

    const wasClosed = await closedPromise;
    assert(wasClosed, 'Connection should be closed after receiving oversized payload length');

    transE.stop();
    transF.stop();
  });

  // 18. Handshake timeout when remote doesn't respond
  await test('Handshake times out when remote peer does not respond', async () => {
    const peerG = PeerId.create();
    const transG = new TCPTransport(peerG);

    // Start a raw TCP server that accepts connections but never sends handshake data
    const silentServer = net.createServer(() => { /* do nothing */ });
    const silentPort = await new Promise((resolve, reject) => {
      silentServer.listen(0, '127.0.0.1', () => resolve(silentServer.address().port));
      silentServer.on('error', reject);
    });

    let threw = false;
    try {
      await transG.dial('127.0.0.1', silentPort);
    } catch (e) {
      threw = true;
      assert(
        e.message.includes('timeout') || e.message.includes('Timeout') || e.message.includes('Handshake'),
        `Expected timeout error, got: ${e.message}`
      );
    }
    assert(threw, 'Expected dial to throw on handshake timeout');

    silentServer.close();
    transG.stop();
  });

  // 19. Handshake rejects invalid nonce signature
  await test('Handshake rejects invalid nonce signature', async () => {
    const peerH = PeerId.create();
    const peerI = PeerId.create(); // impersonator

    // Start a TCP server that sends a valid Round 1 but a garbage signature in Round 2
    const fakeServer = net.createServer((socket) => {
      const fakeConn = new Connection(socket, peerI);

      // Send Round 1: valid pubkey + nonce
      const pubKeyBytes = Buffer.from(peerI.publicKeyRaw);
      const fakeNonce = Buffer.alloc(32, 0xaa);
      const r1 = Buffer.alloc(2 + pubKeyBytes.length + 32);
      r1.writeUInt16BE(pubKeyBytes.length, 0);
      pubKeyBytes.copy(r1, 2);
      fakeNonce.copy(r1, 2 + pubKeyBytes.length);
      fakeConn.sendMessage('/handshake/1.0', r1);

      // When we receive Round 1 from the dialer, send a garbage signature as Round 2
      fakeConn.onMessage('/handshake/1.0', () => {
        const garbageSig = Buffer.alloc(64, 0xff); // invalid signature
        fakeConn.sendMessage('/handshake/1.0', garbageSig);
      });
    });

    const fakePort = await new Promise((resolve, reject) => {
      fakeServer.listen(0, '127.0.0.1', () => resolve(fakeServer.address().port));
      fakeServer.on('error', reject);
    });

    const transH = new TCPTransport(peerH);
    let threw = false;
    try {
      await transH.dial('127.0.0.1', fakePort);
    } catch (e) {
      threw = true;
      assert(
        e.message.includes('failed') || e.message.includes('Handshake') || e.message.includes('challenge'),
        `Expected handshake failure, got: ${e.message}`
      );
    }
    assert(threw, 'Expected handshake to reject invalid signature');

    fakeServer.close();
    transH.stop();
  });

  // Cleanup
  transA.stop();
  transB.stop();

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────────\n`);

  // Demo: show what the privacy protocol crypto looks like end-to-end
  console.log('── Privacy protocol crypto demo ──────────────────────────────\n');
  const owner     = PeerId.create();   // Node B
  const requester = PeerId.create();   // Node A

  // B signs CID² to prove ownership
  const cid2      = Buffer.from('fake-cid2-digest-here');
  const signature = sign(cid2, owner.privateKey);
  const valid     = verify(cid2, signature, owner.publicKey);
  console.log(`  B signs CID²       : ${signature.slice(0,16).toString('hex')}...`);
  console.log(`  A verifies sig     : ${valid}`);

  // A generates an AES session key K and encrypts (CID¹ + K) with B's public key
  const cid1      = Buffer.from('fake-cid1-digest-here');
  const K         = randomAesKey();
  const encrypted = eciesEncrypt(Buffer.concat([cid1, K]), owner.publicKey);
  const decrypted = eciesDecrypt(encrypted, owner.privateKey);
  const cid1Back  = decrypted.slice(0, cid1.length);
  const KBack     = decrypted.slice(cid1.length);
  console.log(`  A encrypts CID¹+K  : ${encrypted.slice(0,16).toString('hex')}...`);
  console.log(`  B decrypts CID¹    : ${cid1Back.equals(cid1) ? 'OK' : 'FAIL'}`);
  console.log(`  B recovers K       : ${KBack.equals(K) ? 'OK' : 'FAIL'}`);

  // B encrypts OBJ with K, A decrypts
  const obj       = Buffer.from('the actual file content');
  const encObj    = aesEncrypt(obj, KBack);
  const decObj    = aesDecrypt(encObj, K);
  console.log(`  B encrypts OBJ     : ${encObj.slice(0,16).toString('hex')}...`);
  console.log(`  A decrypts OBJ     : ${decObj.equals(obj) ? 'OK' : 'FAIL'}`);
  console.log();
}

run().catch(console.error);
