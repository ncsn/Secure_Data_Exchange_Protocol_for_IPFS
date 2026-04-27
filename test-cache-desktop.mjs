/**
 * test-cache-desktop.mjs — Start a peer node that owns a file,
 * so the Desktop app can cache from it.
 *
 * Run this FIRST, then in the Desktop app:
 *   1. Start Node
 *   2. Go to Peers tab → connect to 127.0.0.1 port 4005
 *   3. Go to Cache tab → paste the CID3 printed below → select the peer → click Cache
 *   4. Go to Get File tab → paste the CID1 printed below → click Retrieve
 *
 * This peer owns a file. The Desktop app caches it and can serve it to others.
 */

import { Node } from './src/node/node.js';

const node = new Node({ announceIp: '127.0.0.1' });
const port = await node.start(4010);

console.log(`\n=== Peer Node (Owner) ===`);
console.log(`Listening on port: ${port}`);
console.log(`Peer ID: ${node.id}\n`);

// Add a file
const content = 'Hello from the peer node! This file will be cached by the Desktop app.';
const result = await node.addBytes(Buffer.from(content), { name: 'hello.txt' });

console.log(`File added:`);
console.log(`  CID1: ${result.cid1}`);
console.log(`  CID3: ${result.cid3}`);
console.log(`\n--- Copy these into the Desktop app ---`);
console.log(`  Cache tab  → paste CID3: ${result.cid3}`);
console.log(`  Get File   → paste CID1: ${result.cid1}`);
console.log(`\nWaiting for connections... (press Ctrl+C to stop)\n`);

// Keep alive
setInterval(() => {}, 60000);
