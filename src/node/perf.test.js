/**
 * perf.test.js — Performance benchmark (50 iterations)
 *
 * Measures the six operations from the paper's Table II:
 *   1. TCP handshake (peer identification)
 *   2. File add + triple hash + DHT publish
 *   3. Privacy retrieval (4-step)
 *   4. Decoy request (4-step, discarded)
 *   5. Cache population (from owner)
 *   6. Cache retrieval (from cache node)
 *
 * Run with:  node src/node/perf.test.js
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { Node } from './node.js';
import { tripleHash } from '../cid/cid.js';
import { hash } from '../cid/crypto.js';

const ITERATIONS = 50;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeNode() {
  const n = new Node({ ephemeral: true });
  await n.start();
  return n;
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  return {
    avg: avg.toFixed(1),
    min: sorted[0].toFixed(1),
    max: sorted[sorted.length - 1].toFixed(1),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n══ Performance Benchmark (50 iterations, 3 nodes) ══════════\n');

  // Spin up 3 nodes: Owner (B), Cache (C), Requester (A)
  const owner     = await makeNode();
  const cache     = await makeNode();
  const requester = await makeNode();

  // Connect: requester → owner, cache → owner
  const connReqOwner  = await requester.connect('127.0.0.1', owner._listenAddr.port);
  const connCacheOwner = await cache.connect('127.0.0.1', owner._listenAddr.port);

  // Prepare a test file
  const testContent = Buffer.from('Performance test payload for benchmarking the privacy protocol.');

  // ── 1. TCP Handshake ────────────────────────────────────────────────────────
  const handshakeTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const tempNode = await makeNode();
    const t0 = performance.now();
    await requester.connect('127.0.0.1', tempNode._listenAddr.port);
    handshakeTimes.push(performance.now() - t0);
    await tempNode.stop();
  }

  // ── 2. File add + triple hash + DHT publish ─────────────────────────────────
  const addTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await owner.addBytes(Buffer.from(`bench-payload-${i}-${Date.now()}`));
    addTimes.push(performance.now() - t0);
  }

  // ── 3. Privacy retrieval (4-step) ──────────────────────────────────────────
  // Add a file on owner, then retrieve it from requester
  const { cid3 } = await owner.addBytes(testContent);
  const { h1 } = tripleHash(testContent);
  // Give DHT a moment to propagate
  await new Promise(r => setTimeout(r, 100));

  const retrievalTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await requester.get(cid3, h1);
    retrievalTimes.push(performance.now() - t0);
  }

  // ── 4. Decoy request (4-step, discarded) ──────────────────────────────────
  // Decoys need multiple CID³ entries in the requester's registry with the owner as provider.
  // We add files on the owner and manually register them in the requester's registry.
  for (let i = 0; i < 5; i++) {
    const { cid3: dc3 } = await owner.addBytes(Buffer.from(`decoy-seed-file-${i}-${Date.now()}`));
    // Manually populate requester's registry (normally done via DHT cid:seen events)
    if (!requester._cidRegistry.has(dc3)) requester._cidRegistry.set(dc3, new Set());
    requester._cidRegistry.get(dc3).add(owner.id);
  }
  await new Promise(r => setTimeout(r, 100));

  const decoyTimes = [];
  let decoyFailures = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    try {
      const result = await requester.sendDecoy();
      const elapsed = performance.now() - t0;
      if (result && result.ok) {
        decoyTimes.push(elapsed);
      } else {
        decoyFailures++;
      }
    } catch {
      decoyFailures++;
    }
  }

  // ── 5. Cache population (from owner) ──────────────────────────────────────
  // Connect cache → owner for cache protocol
  const cacheTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    // Add a fresh file each time so cache doesn't already have it
    const { cid3: c3 } = await owner.addBytes(Buffer.from(`cache-bench-${i}-${Date.now()}`));
    await new Promise(r => setTimeout(r, 50));
    const t0 = performance.now();
    await cache.cacheFrom(c3, connCacheOwner);
    cacheTimes.push(performance.now() - t0);
  }

  // ── 6. Cache retrieval (from cache node) ──────────────────────────────────
  // Connect requester → cache
  const connReqCache = await requester.connect('127.0.0.1', cache._listenAddr.port);
  // Cache a known file
  const cacheTestContent = Buffer.from('cache-retrieval-test');
  const { cid3: cid3c } = await owner.addBytes(cacheTestContent);
  const { h1: h1c } = tripleHash(cacheTestContent);
  await new Promise(r => setTimeout(r, 50));
  await cache.cacheFrom(cid3c, connCacheOwner);

  const cacheRetrievalTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await requester.get(cid3c, h1c);
    cacheRetrievalTimes.push(performance.now() - t0);
  }

  // ── Results ────────────────────────────────────────────────────────────────
  console.log('┌────────────────────────────────────────┬────────┬────────┬────────┐');
  console.log('│ Operation                              │ Avg    │ Min    │ Max    │');
  console.log('├────────────────────────────────────────┼────────┼────────┼────────┤');

  const results = [
    ['TCP handshake (peer identification)', handshakeTimes],
    ['File add + triple hash + DHT publish', addTimes],
    ['Privacy retrieval (4-step)', retrievalTimes],
    ['Decoy request (4-step, discarded)', decoyTimes],
    ['Cache population (from owner)', cacheTimes],
    ['Cache retrieval (from cache node)', cacheRetrievalTimes],
  ];

  for (const [name, times] of results) {
    if (times.length === 0) {
      console.log(`│ ${name.padEnd(38)} │  N/A   │  N/A   │  N/A   │`);
      continue;
    }
    const s = stats(times);
    console.log(`│ ${name.padEnd(38)} │ ${(s.avg + ' ms').padStart(6)} │ ${(s.min + ' ms').padStart(6)} │ ${(s.max + ' ms').padStart(6)} │`);
  }

  console.log('└────────────────────────────────────────┴────────┴────────┴────────┘');
  console.log(`\n  Iterations: ${ITERATIONS} | Nodes: 3 (localhost)\n`);

  // Cleanup
  await owner.stop();
  await cache.stop();
  await requester.stop();
}

run().catch(e => { console.error(e); process.exit(1); });
