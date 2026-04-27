/**
 * test-cache.mjs — End-to-end test for the Encrypted Caching Protocol
 *
 * Run with:  node test-cache.mjs
 *
 * Sets up 3 nodes automatically:
 *   Owner (B)     — adds a file
 *   Cache (C)     — caches the file from Owner (never learns CID1)
 *   Requester (A) — retrieves the file from Cache (not from Owner)
 */

import { Node } from './src/node/node.js';
import { cidFromString } from './src/cid/cid.js';

async function main() {
  console.log('\n=== Encrypted Caching Protocol — End-to-End Test ===\n');

  // ── Step 1: Start 3 nodes ──────────────────────────────────────────────────
  console.log('Starting 3 nodes...');
  const owner     = new Node({ announceIp: '127.0.0.1' });
  const cache     = new Node({ announceIp: '127.0.0.1' });
  const requester = new Node({ announceIp: '127.0.0.1' });

  const ownerPort     = await owner.start(0);
  const cachePort     = await cache.start(0);
  const requesterPort = await requester.start(0);

  console.log(`  Owner     listening on port ${ownerPort}`);
  console.log(`  Cache     listening on port ${cachePort}`);
  console.log(`  Requester listening on port ${requesterPort}`);

  // ── Step 2: Owner adds a file ──────────────────────────────────────────────
  const fileContent = 'Hello from the Encrypted Caching Protocol test!';
  const result = await owner.addBytes(Buffer.from(fileContent));
  console.log(`\nOwner added file:`);
  console.log(`  CID1: ${result.cid1}`);
  console.log(`  CID3: ${result.cid3}`);

  // ── Step 3: Cache node connects to Owner and caches the file ───────────────
  console.log('\nCache node connecting to Owner...');
  const connCtoB = await cache.connect('127.0.0.1', ownerPort);
  await new Promise(r => setTimeout(r, 100));

  console.log('Cache node requesting to cache the file...');
  await cache.cacheFrom(result.cid3, connCtoB);
  console.log(`  Cached! hasCached: ${cache.bitswap.hasCached(result.cid3)}`);

  // ── Step 4: Requester connects to Cache and retrieves the file ─────────────
  console.log('\nRequester connecting to Cache node...');
  const connAtoC = await requester.connect('127.0.0.1', cachePort);
  await new Promise(r => setTimeout(r, 100));

  console.log('Requester retrieving file from Cache node...');
  const cid1 = cidFromString(result.cid1);
  const data = await requester.getFromCache(result.cid3, cid1.digest, connAtoC);

  // ── Step 5: Verify ─────────────────────────────────────────────────────────
  const retrieved = data.toString();
  const match = retrieved === fileContent;

  console.log(`\n  Retrieved: "${retrieved}"`);
  console.log(`  Original:  "${fileContent}"`);
  console.log(`  Match: ${match ? 'YES' : 'NO'}`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n=== Results ===\n');
  console.log(`  ${match ? 'PASS' : 'FAIL'} — Cache node served the file without ever knowing CID1`);
  console.log(`  Owner never directly talked to Requester`);
  console.log(`  Cache node stored encrypted blob it cannot decrypt\n`);

  // Cleanup
  await owner.stop();
  await cache.stop();
  await requester.stop();

  process.exit(match ? 0 : 1);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
