/**
 * bench.mjs — Measure protocol execution times for the research paper.
 * Runs each operation 20 times on localhost and reports averages.
 */

import { Node } from './src/node/node.js';
import { cidFromString, CID } from './src/cid/cid.js';
import { hash } from './src/cid/crypto.js';
import { randomAesKey } from './src/libp2p/crypto.js';

const RUNS = 20;

async function measure(label, fn) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  console.log(`  ${label.padEnd(45)} avg=${avg.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`);
  return avg;
}

async function main() {
  console.log('');
  console.log('=== Protocol Benchmark (20 runs each) ===');
  console.log('');

  // Create two nodes
  const nodeA = new Node({ announceIp: '127.0.0.1' });
  const nodeB = new Node({ announceIp: '127.0.0.1' });
  const portB = await nodeB.start(0);

  // 1. TCP handshake (mutual auth)
  await measure('TCP handshake (mutual auth)', async () => {
    const portTemp = await nodeA.start(0);
    const conn = await nodeA.connect('127.0.0.1', portB);
    conn.close();
    await nodeA.stop();
  });

  // Re-start A and connect permanently
  const portA = await nodeA.start(0);
  const connAB = await nodeA.connect('127.0.0.1', portB);
  await new Promise(r => setTimeout(r, 50));

  // 2. File add + triple hash + DHT publish
  let addResult;
  await measure('File add + triple hash + DHT publish', async () => {
    const content = Buffer.from('Benchmark test content ' + Math.random());
    addResult = await nodeB.addBytes(content, { name: 'bench.txt' });
  });

  // Prepare CIDs for retrieval
  const cid1 = cidFromString(addResult.cid1);
  const h1 = cid1.digest;
  const h2 = hash(h1);
  const h3 = hash(h2);
  const cid3 = new CID(h3);

  // 3. Privacy retrieval (4-step)
  await measure('Privacy retrieval (4-step, small file)', async () => {
    const K = randomAesKey();
    await nodeA.bitswap.requestPrivate(cid3.string, h1, K, connAB);
  });

  // 4. Decoy request (4-step)
  await measure('Decoy request (4-step, discarded)', async () => {
    await nodeA.bitswap.sendDecoy(cid3.string, connAB);
  });

  // 5. Cache population
  // Need a third node for caching
  const nodeC = new Node({ announceIp: '127.0.0.1' });
  const portC = await nodeC.start(0);
  const connCB = await nodeC.connect('127.0.0.1', portB);
  await new Promise(r => setTimeout(r, 50));

  await measure('Cache population (from owner)', async () => {
    // Re-register owned object each time since cache uses it
    const content = Buffer.from('Cache bench content ' + Math.random());
    const res = await nodeB.addBytes(content, { name: 'cachebench.txt' });
    const c1 = cidFromString(res.cid1);
    const ch3 = hash(hash(c1.digest));
    const cc3 = new CID(ch3);
    await nodeC.bitswap.requestCache(cc3.string, connCB);
  });

  // 6. Cache retrieval — set up a cached object for A to retrieve from C
  const cacheContent = Buffer.from('Cached content for retrieval benchmark');
  const cacheRes = await nodeB.addBytes(cacheContent, { name: 'cacheget.txt' });
  const cacheCid1 = cidFromString(cacheRes.cid1);
  const cacheH1 = cacheCid1.digest;
  const cacheH3 = hash(hash(cacheH1));
  const cacheCid3 = new CID(cacheH3);
  await nodeC.bitswap.requestCache(cacheCid3.string, connCB);

  // A connects to C
  const connAC = await nodeA.connect('127.0.0.1', portC);
  await new Promise(r => setTimeout(r, 50));

  await measure('Cache retrieval (from cache node)', async () => {
    const K = randomAesKey();
    await nodeA.bitswap.requestFromCache(cacheCid3.string, cacheH1, K, connAC);
  });

  // 7. DHT iterative lookup
  await measure('DHT provider lookup (3 nodes)', async () => {
    await nodeA.dht.findProviders(cid3.string, 5000);
  });

  // 8. Large file transfer
  const largeContent = Buffer.alloc(1024 * 1024, 0x42); // 1 MB
  const largeRes = await nodeB.addBytes(largeContent, { name: 'large.bin' });
  const largeCid1 = cidFromString(largeRes.cid1);
  const largeH1 = largeCid1.digest;
  const largeH3 = hash(hash(largeH1));
  const largeCid3 = new CID(largeH3);

  await measure('Privacy retrieval (4-step, 1 MB file)', async () => {
    const K = randomAesKey();
    await nodeA.bitswap.requestPrivate(largeCid3.string, largeH1, K, connAB);
  });

  console.log('');
  console.log('Done.');

  await nodeA.stop();
  await nodeB.stop();
  await nodeC.stop();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
