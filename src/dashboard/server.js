/**
 * server.js — IPFS Dashboard HTTP server
 *
 * Starts three ephemeral nodes (A → B → C), wires them together,
 * serves a browser dashboard at http://localhost:3000, and streams
 * real-time events (stats, protocol messages, connections) via SSE.
 *
 * Start with:  node src/dashboard/server.js
 */

import http            from 'http';
import fs              from 'fs';
import path            from 'path';
import { fileURLToPath } from 'url';
import { exec }        from 'child_process';

import { Node }              from '../node/node.js';
import { tripleHash }        from '../cid/cid.js';
import { MessageType,
         MessageTypeName,
         encode }            from '../bitswap/messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = 3000;

// ── SSE broadcast ─────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(type, payload) {
  const line = `data: ${JSON.stringify({ type, payload, ts: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}

// Keep connections alive (browsers drop SSE after ~30s of silence)
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
  }
}, 15_000);

// ── Nodes ─────────────────────────────────────────────────────────────────────

const nodeA = new Node({ ephemeral: true });
const nodeB = new Node({ ephemeral: true });
const nodeC = new Node({ ephemeral: true });
const nodeD = new Node({ ephemeral: true });
const nodes = [nodeA, nodeB, nodeC, nodeD];
const labels = ['A', 'B', 'C', 'D'];

// Built after all nodes are started
let peerLabel; // Map<peerId string, label>

// ── Demo state ────────────────────────────────────────────────────────────────

let demoState = null; // { cid1, cid2, cid3, h1, content }

// ── Monkey-patches ────────────────────────────────────────────────────────────

function patchNodes() {
  peerLabel = new Map(nodes.map((n, i) => [n.id, labels[i]]));

  nodes.forEach((node, i) => {
    const label = labels[i];

    // -- Bitswap: intercept outgoing messages ---------------------------------
    const bs     = node.bitswap;
    const bsOrig = bs._send.bind(bs);
    bs._send = function(conn, type, cid, payload = Buffer.alloc(0)) {
      const to = peerLabel.get(conn.remotePeer?.id) || conn.remotePeer?.id?.slice(0, 8) || '?';
      broadcast('msg', {
        layer:        'bitswap',
        from:         label,
        to,
        type:         MessageTypeName[type] || `0x${type.toString(16)}`,
        cid:          cid ? cid.slice(0, 28) + '…' : '',
        payloadBytes: payload.length,
      });
      return bsOrig(conn, type, cid, payload);
    };

    // -- DHT: intercept outgoing messages -------------------------------------
    const dht     = node.dht;
    const dhtOrig = dht._send.bind(dht);
    const DHTName = {
      1: 'FIND_NODE', 2: 'FIND_NODE_RESP', 3: 'GET_PROVIDERS',
      4: 'GET_PROVIDERS_RESP', 5: 'ADD_PROVIDER', 6: 'PING', 7: 'PONG',
    };
    dht._send = function(conn, buf) {
      const typeVal = buf[0];
      const to = peerLabel.get(conn.remotePeer?.id) || conn.remotePeer?.id?.slice(0, 8) || '?';
      broadcast('msg', {
        layer: 'dht',
        from:  label,
        to,
        type:  DHTName[typeVal] || `DHT_0x${typeVal.toString(16)}`,
      });
      return dhtOrig(conn, buf);
    };

    // -- Transport: connection events -----------------------------------------
    node.transport.on('connection', conn => {
      const to = peerLabel.get(conn.remotePeer?.id) || conn.remotePeer?.id?.slice(0, 8) || '?';
      broadcast('connection', { from: label, to, event: 'connected' });
      conn.on('close', () => {
        broadcast('connection', { from: label, to, event: 'disconnected' });
      });
    });
  });
}

// ── Stats broadcast ───────────────────────────────────────────────────────────

function broadcastStats() {
  const statsPayload = nodes.map((n, i) => ({
    label:        labels[i],
    peerId:       n.id.slice(0, 12) + '…',
    listenPort:   n._listenAddr?.port || null,
    blocks:       0,
    storageBytes: 0,
    pinnedBlocks: 0,
    dhtPeers:     0,
    dhtProviders: 0,
    connections:  0,
    ...n.info(),
  }));
  broadcast('stats', { nodes: statsPayload });
}

// ── HTTP request handler ──────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

const htmlPath   = path.join(__dirname, 'index.html');
let   cachedHtml = null;

function serveHtml(res) {
  if (!cachedHtml) cachedHtml = fs.readFileSync(htmlPath);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(cachedHtml);
}

async function handleAction(name, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });

  if (name === 'add-to-a') {
    const content = Buffer.from(`Hello from Node A — ${new Date().toISOString()}`);
    const { h1 }  = tripleHash(content);
    const { cid1, cid2, cid3 } = await nodeA.addBytes(content, { name: 'demo.txt' });
    demoState = { cid1, cid2, cid3, h1, content };
    broadcast('step', {
      step:   'add-to-a',
      cid1:   cid1.slice(0, 28) + '…',
      cid2:   cid2.slice(0, 28) + '…',
      cid3:   cid3.slice(0, 28) + '…',
      bytes:  content.length,
    });
    res.end(JSON.stringify({ ok: true, cid1, cid3 }));
    return;
  }

  if (name === 'retrieve-from-c') {
    if (!demoState) {
      res.end(JSON.stringify({ ok: false, error: 'Add a file first (Step 1)' }));
      return;
    }
    try {
      const received = await nodeC.get(demoState.cid3, demoState.h1);
      const match    = demoState.content.equals(received);
      broadcast('step', {
        step:  'retrieve-from-c',
        bytes: received.length,
        match,
      });
      res.end(JSON.stringify({ ok: true, bytes: received.length, match }));
    } catch (err) {
      broadcast('step', { step: 'retrieve-from-c', error: err.message });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (name === 'retrieve-from-d') {
    if (!demoState) {
      res.end(JSON.stringify({ ok: false, error: 'Add a file first (Step 1)' }));
      return;
    }
    try {
      const received = await nodeD.get(demoState.cid3, demoState.h1);
      const match    = demoState.content.equals(received);
      broadcast('step', {
        step:  'retrieve-from-d',
        bytes: received.length,
        match,
      });
      res.end(JSON.stringify({ ok: true, bytes: received.length, match }));
    } catch (err) {
      broadcast('step', { step: 'retrieve-from-d', error: err.message });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (name === 'send-decoy') {
    if (!demoState) {
      res.end(JSON.stringify({ ok: false, error: 'Add a file first (Step 1)' }));
      return;
    }
    // Pick any connection from D (the farthest node) that leads toward A
    const conn = [...nodeD.transport.connections.values()][0];
    if (!conn) {
      res.end(JSON.stringify({ ok: false, error: 'Node C has no connections yet — retrieve first' }));
      return;
    }
    // Send DECOY_REQUEST directly — bypasses the timing gap in sendDecoy()
    const decoyPayload = Buffer.alloc(4);
    decoyPayload.writeUInt32BE(256, 0);
    conn.sendMessage('/bitswap/1.0', encode(MessageType.DECOY_REQUEST, demoState.cid3, decoyPayload));
    broadcast('step', { step: 'send-decoy' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.end(JSON.stringify({ ok: false, error: `Unknown action: ${name}` }));
}

const server = http.createServer(async (req, res) => {
  const url    = req.url;
  const method = req.method;

  // CORS headers (for any testing tools)
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET / → serve dashboard HTML
  if (method === 'GET' && url === '/') {
    serveHtml(res);
    return;
  }

  // GET /events → SSE stream
  if (method === 'GET' && url === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    // Send current stats immediately
    broadcastStats();
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // POST /action/:name → demo action
  if (method === 'POST' && url.startsWith('/action/')) {
    const name = url.slice('/action/'.length);
    await handleAction(name, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n── IPFS Dashboard ────────────────────────────────────────────\n');
  console.log('  Starting nodes…');

  await nodeA.start();
  await nodeB.start();
  await nodeC.start();
  await nodeD.start();

  console.log(`  Node A  ${nodeA.id.slice(0, 16)}…  port ${nodeA._listenAddr.port}`);
  console.log(`  Node B  ${nodeB.id.slice(0, 16)}…  port ${nodeB._listenAddr.port}`);
  console.log(`  Node C  ${nodeC.id.slice(0, 16)}…  port ${nodeC._listenAddr.port}`);
  console.log(`  Node D  ${nodeD.id.slice(0, 16)}…  port ${nodeD._listenAddr.port}`);

  // Wire: A ↔ B ↔ C ↔ D  (linear chain, so multi-hop routing is exercised)
  await nodeA.connect('127.0.0.1', nodeB._listenAddr.port);
  await nodeB.connect('127.0.0.1', nodeC._listenAddr.port);
  await nodeC.connect('127.0.0.1', nodeD._listenAddr.port);
  await new Promise(r => setTimeout(r, 100)); // let routing tables settle

  console.log('  Topology: A — B — C — D  (connected)');

  // Install patches now that all peer IDs are known
  patchNodes();

  // Stats broadcast every second
  setInterval(broadcastStats, 1000);

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Dashboard → http://localhost:${PORT}\n`);
    // Open browser (Windows)
    exec(`start http://localhost:${PORT}`);
  });

  // Clean shutdown
  process.on('SIGINT', async () => {
    console.log('\n  Shutting down…');
    for (const n of nodes) await n.stop().catch(() => {});
    server.close(() => process.exit(0));
  });
}

main().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
