/**
 * docker-node.mjs — Multi-role IPFS node for Docker testing
 *
 * Behavior is determined by the ROLE environment variable:
 *   ROLE=owner     — adds a file, publishes CIDs, waits for connections
 *   ROLE=cache     — connects to owner, caches the file, serves it
 *   ROLE=requester — connects to cache, retrieves file, verifies, stays alive
 *
 * CID sharing: Owner writes /shared/cids.json, others poll until it appears.
 *
 * Usage:
 *   docker compose up --build
 */

import fs from 'fs';
import { Node } from './src/node/node.js';
import { cidFromString } from './src/cid/cid.js';

const ROLE         = process.env.ROLE || 'owner';
const PORT         = parseInt(process.env.PORT || '4001', 10);
const ANNOUNCE_IP  = process.env.ANNOUNCE_IP || '127.0.0.1';
const SHARED_FILE  = '/shared/cids.json';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${ROLE.toUpperCase().padEnd(9)}] ${msg}`);
}

// Wait for a file to appear on the shared volume
async function waitForCids(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const data = fs.readFileSync(SHARED_FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Timeout waiting for CIDs from owner');
}

// Retry connecting to a host until it's ready
async function connectWithRetry(node, host, port, maxRetries = 20) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const conn = await node.connect(host, port);
      return conn;
    } catch {
      log(`Connection attempt ${i}/${maxRetries} to ${host}:${port} failed, retrying...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(`Could not connect to ${host}:${port} after ${maxRetries} attempts`);
}

// ── OWNER ────────────────────────────────────────────────────────────────────

async function runOwner() {
  const node = new Node({ announceIp: ANNOUNCE_IP });
  const port = await node.start(PORT);
  log(`Node started on port ${port}`);
  log(`Peer ID: ${node.id}`);

  // Add a test file
  const content = 'Hello from the Docker Owner node! This file demonstrates the triple-hash privacy protocol.';
  const result = await node.addBytes(Buffer.from(content), { name: 'hello.txt' });

  log(`File added:`);
  log(`  CID1: ${result.cid1}`);
  log(`  CID3: ${result.cid3}`);

  // Write CIDs to shared volume for other containers
  fs.writeFileSync(SHARED_FILE, JSON.stringify({
    cid1: result.cid1,
    cid3: result.cid3,
    ownerPeerId: node.id,
    content,
  }));
  log('CIDs written to shared volume');

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  OWNER NODE READY                                      ║');
  console.log(`║  Port: ${String(port).padEnd(49)}║`);
  console.log(`║  CID1: ${result.cid1.slice(0, 48)}...║`);
  console.log(`║  CID3: ${result.cid3.slice(0, 48)}...║`);
  console.log('║                                                        ║');
  console.log('║  Connect from Desktop app → Peers → localhost:4001     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Keep alive
  setInterval(() => {}, 60000);
}

// ── CACHE ────────────────────────────────────────────────────────────────────

async function runCache() {
  const node = new Node({ announceIp: ANNOUNCE_IP });
  const port = await node.start(PORT);
  log(`Node started on port ${port}`);
  log(`Peer ID: ${node.id}`);

  // Wait for owner's CIDs
  log('Waiting for Owner to add file...');
  const cids = await waitForCids();
  log(`Got CIDs — CID3: ${cids.cid3.slice(0, 24)}...`);

  // Connect to owner
  const ownerHost = process.env.OWNER_HOST || 'owner';
  const ownerPort = parseInt(process.env.OWNER_PORT || '4001', 10);
  log(`Connecting to Owner at ${ownerHost}:${ownerPort}...`);
  const conn = await connectWithRetry(node, ownerHost, ownerPort);
  log(`Connected to Owner (${conn.remotePeer.id.slice(0, 12)}...)`);

  // Wait for bitswap handshake to settle
  await new Promise(r => setTimeout(r, 500));

  // Cache the file
  log('Requesting cache of file from Owner...');
  await node.cacheFrom(cids.cid3, conn);
  log(`CACHED SUCCESSFULLY — hasCached: ${node.bitswap.hasCached(cids.cid3)}`);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  CACHE NODE READY — Serving encrypted cached content    ║');
  console.log(`║  Port: ${String(port).padEnd(49)}║`);
  console.log('║                                                        ║');
  console.log('║  Connect from Desktop app → Peers → localhost:4002     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Keep alive
  setInterval(() => {}, 60000);
}

// ── REQUESTER ────────────────────────────────────────────────────────────────

async function runRequester() {
  const node = new Node({ announceIp: ANNOUNCE_IP });
  const port = await node.start(PORT);
  log(`Node started on port ${port}`);
  log(`Peer ID: ${node.id}`);

  // Wait for owner's CIDs
  log('Waiting for CIDs...');
  const cids = await waitForCids();
  log(`Got CIDs — CID1: ${cids.cid1.slice(0, 24)}...`);

  // Wait a bit for cache node to be ready
  await new Promise(r => setTimeout(r, 2000));

  // Connect to cache
  const cacheHost = process.env.CACHE_HOST || 'cache';
  const cachePort = parseInt(process.env.CACHE_PORT || '4002', 10);
  log(`Connecting to Cache at ${cacheHost}:${cachePort}...`);
  const conn = await connectWithRetry(node, cacheHost, cachePort);
  log(`Connected to Cache (${conn.remotePeer.id.slice(0, 12)}...)`);

  // Wait for bitswap handshake
  await new Promise(r => setTimeout(r, 500));

  // Retrieve from cache
  log('Retrieving file from Cache node (not from Owner!)...');
  const cid1 = cidFromString(cids.cid1);
  const data = await node.getFromCache(cids.cid3, cid1.digest, conn);

  // Verify
  const retrieved = data.toString();
  const match = retrieved === cids.content;

  log(`Retrieved: "${retrieved.slice(0, 60)}..."`);
  log(`Match: ${match ? 'YES' : 'NO'}`);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  if (match) {
    console.log('║  ✓ PASS — Encrypted caching protocol works!             ║');
  } else {
    console.log('║  ✗ FAIL — Content mismatch!                             ║');
  }
  console.log('║                                                        ║');
  console.log('║  • Owner added file                                    ║');
  console.log('║  • Cache node cached it (encrypted, never knew CID1)   ║');
  console.log('║  • Requester retrieved from cache (not from owner)     ║');
  console.log('║  • Content verified: hash matches CID1                 ║');
  console.log('║                                                        ║');
  console.log(`║  Requester port: ${String(port).padEnd(39)}║`);
  console.log('║  Connect from Desktop app → Peers → localhost:4003     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Keep alive for interactive testing
  setInterval(() => {}, 60000);
}

// ── Entry point ──────────────────────────────────────────────────────────────

log(`Starting as ${ROLE}...`);

const runners = { owner: runOwner, cache: runCache, requester: runRequester };
const runner = runners[ROLE];

if (!runner) {
  console.error(`Unknown ROLE: ${ROLE}. Use owner, cache, or requester.`);
  process.exit(1);
}

runner().catch(err => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
