/**
 * standalone.js — Run a single IPFS privacy node as its own process
 *
 * Each machine runs this script independently. Nodes discover and
 * retrieve content from each other over a real TCP network.
 *
 * Usage:
 *   node src/node/standalone.js [options]
 *
 * Options:
 *   --port    <n>        TCP listen port              (default: 4002)
 *   --data    <path>     Block store directory         (default: ./ipfs-data)
 *   --ip      <addr>     Announce IP for DHT           (default: auto-detect LAN IP)
 *   --connect <ip:port>  Bootstrap peer — repeatable   (e.g. --connect 192.168.1.10:4001)
 *   --name    <label>    Label shown in logs           (default: Node)
 *
 * Interactive commands (type after startup):
 *   add <filepath>            Add a file. Prints CID¹, CID³, and the h1 hex digest.
 *   get <cid3> <h1hex>        Retrieve a file by CID³ + h1 hex. Saves to ./received/
 *   ls  <dircid>              List directory entries.
 *   info                      Print node statistics.
 *   peers                     List connected peer IDs.
 *   connect <ip:port>         Connect to a peer at runtime.
 *   help                      Show this command list.
 *   exit / quit               Shut down.
 *
 * Example — two terminals on the same machine:
 *   Terminal 1:  node src/node/standalone.js --port 4001 --name Alice
 *   Terminal 2:  node src/node/standalone.js --port 4002 --name Bob --connect 127.0.0.1:4001
 *
 * Example — two machines on a LAN:
 *   Machine A:   node src/node/standalone.js --port 4001 --ip 192.168.1.10
 *   Machine B:   node src/node/standalone.js --port 4001 --ip 192.168.1.20 --connect 192.168.1.10:4001
 */

import fs              from 'fs';
import path            from 'path';
import os              from 'os';
import readline        from 'readline';
import http            from 'http';
import { timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';

import { Node }        from './node.js';
import { tripleHash }  from '../cid/cid.js';

// ── Arg parser ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args    = argv.slice(2);
  const opts    = { port: 4002, data: './ipfs-data', ip: null, connect: [], name: 'Node', apiToken: null };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port'       && args[i+1]) { opts.port      = parseInt(args[++i], 10); }
    else if (a === '--data'      && args[i+1]) { opts.data      = args[++i]; }
    else if (a === '--ip'        && args[i+1]) { opts.ip        = args[++i]; }
    else if (a === '--connect'   && args[i+1]) { opts.connect.push(args[++i]); }
    else if (a === '--name'      && args[i+1]) { opts.name      = args[++i]; }
    else if (a === '--api-token' && args[i+1]) { opts.apiToken  = args[++i]; }
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
        .filter(l => l.startsWith(' *')).map(l => l.slice(3)).join('\n'));
      process.exit(0);
    }
  }
  return opts;
}

// ── Auto-detect LAN IP ────────────────────────────────────────────────────────

function detectLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ── Colours ───────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  purple: '\x1b[35m',
  red:    '\x1b[31m',
  grey:   '\x1b[90m',
};

function c(colour, text) { return `${C[colour]}${text}${C.reset}`; }

// ── REPL commands ─────────────────────────────────────────────────────────────

async function cmdAdd(node, args) {
  const filePath = args[0];
  if (!filePath) { console.log('Usage: add <filepath>'); return; }
  if (!fs.existsSync(filePath)) { console.log(c('red', `File not found: ${filePath}`)); return; }

  console.log(c('dim', `  Adding ${filePath}…`));
  const bytes = fs.readFileSync(filePath);
  const { cid1, cid2, cid3 } = await node.addBytes(bytes, { name: path.basename(filePath) });
  const { h1 } = tripleHash(bytes);
  const h1hex  = h1.toString('hex');

  console.log();
  console.log(`  ${c('dim','CID¹')} ${c('cyan', cid1)}`);
  console.log(`  ${c('dim','CID²')} ${c('purple', cid2)}  ${c('grey','← secret, do not share')}`);
  console.log(`  ${c('dim','CID³')} ${c('cyan', cid3)}`);
  console.log(`  ${c('dim','h1  ')} ${c('yellow', h1hex)}  ${c('grey','← share this with the requester')}`);
  console.log();
  console.log(c('green', '  ✓ File added and announced to DHT'));
  console.log();
  console.log(c('dim', '  Give the other node:'));
  console.log(`    get ${cid3} ${h1hex}`);
  console.log();
}

async function cmdGet(node, args) {
  const [cid3, h1hex] = args;
  if (!cid3 || !h1hex) { console.log('Usage: get <cid3> <h1hex>'); return; }

  let h1;
  try { h1 = Buffer.from(h1hex, 'hex'); }
  catch { console.log(c('red', '  Invalid h1 hex')); return; }
  if (h1.length !== 32) { console.log(c('red', `  h1 must be 32 bytes (64 hex chars), got ${h1.length}`)); return; }

  console.log(c('dim', `  Retrieving ${cid3.slice(0, 20)}…`));
  try {
    const data = await node.get(cid3, h1);

    // Save to ./received/
    const outDir  = './received';
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, cid3.slice(0, 32));
    fs.writeFileSync(outFile, data);

    console.log(c('green', `  ✓ Received ${data.length} bytes`));
    console.log(`    Saved to ${c('cyan', outFile)}`);
  } catch (err) {
    console.log(c('red', `  ✗ ${err.message}`));
  }
  console.log();
}

async function cmdLs(node, args) {
  const cid = args[0];
  if (!cid) { console.log('Usage: ls <dircid>'); return; }
  try {
    const entries = await node.ls(cid);
    if (entries.length === 0) { console.log(c('dim', '  (empty directory)')); return; }
    for (const e of entries) {
      console.log(`  ${c('cyan', e.name.padEnd(30))} ${c('dim', e.size + ' bytes')}`);
    }
  } catch (err) {
    console.log(c('red', `  ✗ ${err.message}`));
  }
  console.log();
}

function cmdInfo(node) {
  const i = node.info();
  console.log();
  console.log(`  ${c('dim','Peer ID    ')} ${c('cyan', i.peerId)}`);
  console.log(`  ${c('dim','Multiaddr  ')} ${node.multiaddr()}`);
  console.log(`  ${c('dim','Blocks     ')} ${i.blocks}  (${i.storageBytes} bytes stored)`);
  console.log(`  ${c('dim','Pinned     ')} ${i.pinnedBlocks}`);
  console.log(`  ${c('dim','Connections')} ${i.connections}`);
  console.log(`  ${c('dim','DHT peers  ')} ${i.dhtPeers}`);
  console.log(`  ${c('dim','Providers  ')} ${i.dhtProviders}`);
  console.log();
}

function cmdPeers(node) {
  const conns = [...node.transport.connections.entries()];
  if (conns.length === 0) {
    console.log(c('dim', '  No connected peers.'));
  } else {
    for (const [peerId, conn] of conns) {
      console.log(`  ${c('green', '●')} ${peerId}`);
    }
  }
  console.log();
}

async function cmdConnect(node, args) {
  const addr = args[0];
  if (!addr) { console.log('Usage: connect <ip:port>'); return; }
  const [ip, portStr] = addr.split(':');
  const port = parseInt(portStr, 10);
  if (!ip || isNaN(port)) { console.log(c('red', '  Invalid address — use ip:port')); return; }
  try {
    await node.connect(ip, port);
    console.log(c('green', `  ✓ Connected to ${ip}:${port}`));
  } catch (err) {
    console.log(c('red', `  ✗ ${err.message}`));
  }
  console.log();
}

function cmdHelp() {
  console.log();
  console.log(`  ${c('bold','Commands:')}
  ${c('cyan','add')} <filepath>         Add a file — prints CID³ and h1 hex to share
  ${c('cyan','get')} <cid3> <h1hex>     Retrieve a file — saved to ./received/
  ${c('cyan','ls')}  <dircid>           List directory entries
  ${c('cyan','info')}                   Node statistics
  ${c('cyan','peers')}                  Connected peers
  ${c('cyan','connect')} <ip:port>      Connect to a peer
  ${c('cyan','help')}                   Show this list
  ${c('cyan','exit')} / ${c('cyan','quit')}           Shut down
`);
}

// ── Node HTTP API ─────────────────────────────────────────────────────────────
//
// Each standalone node exposes a small HTTP API on port + 100.
// The multi.html dashboard connects to these APIs from the browser.

function startNodeApi(node, apiPort, nodeName, announceIp, apiToken = null) {
  const sseClients = new Set();

  function broadcast(type, payload) {
    const line = `data: ${JSON.stringify({ type, payload, ts: Date.now() })}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { sseClients.delete(res); }
    }
  }

  // Keep SSE connections alive
  setInterval(() => {
    for (const res of sseClients) {
      try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
    }
  }, 15_000);

  // Stats broadcast every second
  setInterval(() => {
    try {
      broadcast('stats', {
        ...node.info(),
        peerId:    node.id,
        name:      nodeName,
        multiaddr: node.multiaddr(announceIp),
      });
    } catch {}
  }, 1000);

  // Patch Bitswap _send
  const bs     = node.bitswap;
  const bsOrig = bs._send.bind(bs);
  bs._send = function(conn, type, cid, payload = Buffer.alloc(0)) {
    const { MessageTypeName } = bs.constructor;
    try {
      broadcast('msg', {
        layer:        'bitswap',
        from:         nodeName,
        to:           conn.remotePeer?.id?.slice(0, 10) + '…',
        type:         _bsTypeName(type),
        cid:          cid ? cid.slice(0, 28) + '…' : '',
        payloadBytes: payload.length,
      });
    } catch {}
    return bsOrig(conn, type, cid, payload);
  };

  // Patch DHT _send
  const dht     = node.dht;
  const dhtOrig = dht._send.bind(dht);
  const DHTName = { 1:'FIND_NODE',2:'FIND_NODE_RESP',3:'GET_PROVIDERS',
                    4:'GET_PROVIDERS_RESP',5:'ADD_PROVIDER',6:'PING',7:'PONG' };
  dht._send = function(conn, buf) {
    try {
      broadcast('msg', {
        layer: 'dht',
        from:  nodeName,
        to:    conn.remotePeer?.id?.slice(0, 10) + '…',
        type:  DHTName[buf[0]] || `DHT_0x${buf[0]?.toString(16)}`,
      });
    } catch {}
    return dhtOrig(conn, buf);
  };

  // Connection events
  node.transport.on('connection', conn => {
    broadcast('connection', {
      from:  nodeName,
      to:    conn.remotePeer?.id?.slice(0, 10) + '…',
      event: 'connected',
    });
    conn.on('close', () => broadcast('connection', {
      from:  nodeName,
      to:    conn.remotePeer?.id?.slice(0, 10) + '…',
      event: 'disconnected',
    }));
  });

  // Helper: read POST body
  function readBody(req) {
    return new Promise(resolve => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => resolve(body));
    });
  }

  // Helper: verify Bearer token on mutating requests
  function checkToken(req) {
    if (!apiToken) return true; // no token configured → open
    if (req.method === 'OPTIONS' || req.method === 'GET') return true; // read-only exempt
    const auth  = req.headers['authorization'] || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const provided = Buffer.from(match[1]);
    const expected = Buffer.from(apiToken);
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  const server = http.createServer(async (req, res) => {
    // CORS — required so browser can fetch from file:// or different port
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Token authentication for mutating endpoints
    if (!checkToken(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json',
                           'WWW-Authenticate': 'Bearer realm="ipfs-api"' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }

    const url = req.url;

    // GET /events — SSE stream
    if (req.method === 'GET' && url === '/events') {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      });
      res.write(': connected\n\n');
      // Send immediate snapshot
      res.write(`data: ${JSON.stringify({ type: 'stats', payload: {
        ...node.info(), peerId: node.id, name: nodeName,
        multiaddr: node.multiaddr(announceIp),
      }, ts: Date.now() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // GET /info — node snapshot
    if (req.method === 'GET' && url === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...node.info(),
        peerId:    node.id,
        name:      nodeName,
        multiaddr: node.multiaddr(announceIp),
        peers:     [...node.transport.connections.keys()],
      }));
      return;
    }

    // GET /peers — connected peer IDs
    if (req.method === 'GET' && url === '/peers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ peers: [...node.transport.connections.keys()] }));
      return;
    }

    // POST /add — add content
    if (req.method === 'POST' && url === '/add') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        const body    = JSON.parse(await readBody(req));
        const bytes   = Buffer.from(body.content, 'base64');
        const name    = body.name || 'file';
        const { cid1, cid2, cid3 } = await node.addBytes(bytes, { name });
        const { h1 }  = (await import('../cid/cid.js')).tripleHash(bytes);
        res.end(JSON.stringify({ ok: true, cid1, cid2, cid3, h1hex: h1.toString('hex') }));
      } catch (err) {
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /get — retrieve content
    if (req.method === 'POST' && url === '/get') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        const body  = JSON.parse(await readBody(req));
        const h1    = Buffer.from(body.h1hex, 'hex');
        const data  = await node.get(body.cid3, h1);
        res.end(JSON.stringify({ ok: true, data: data.toString('base64'), bytes: data.length }));
      } catch (err) {
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /connect — dial a peer
    if (req.method === 'POST' && url === '/connect') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        const body = JSON.parse(await readBody(req));
        await node.connect(body.ip, parseInt(body.port, 10));
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(apiPort, '127.0.0.1', () => {});
  return server;
}

// Helper: Bitswap type name without importing messages.js
function _bsTypeName(type) {
  const names = {
    0x01:'WANT_HAVE', 0x02:'HAVE', 0x03:'DONT_HAVE', 0x04:'WANT_BLOCK',
    0x05:'BLOCK', 0x06:'CANCEL', 0x10:'PRIVACY_CHALLENGE',
    0x11:'PRIVACY_RESPONSE', 0x12:'PRIVACY_BLOCK',
    0x20:'DECOY_REQUEST', 0x21:'DECOY_BLOCK',
  };
  return names[type] || `0x${type?.toString(16)}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts      = parseArgs(process.argv);
  const announceIp = opts.ip || detectLanIp();
  const dataDir    = path.resolve(opts.data);

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  console.log();
  console.log(c('bold', '── IPFS Privacy Node ─────────────────────────────────────────'));
  console.log();
  console.log(`  ${c('dim','Name    ')} ${c('yellow', opts.name)}`);
  console.log(`  ${c('dim','Data dir')} ${dataDir}`);
  console.log(c('dim', '  Starting…'));

  const node = new Node({
    dataDir,
    ephemeral:  false,
    host:       '0.0.0.0',
    announceIp,
    listenPort: opts.port,
  });

  await node.start();

  const apiPort   = node._listenAddr.port + 100;
  const apiServer = startNodeApi(node, apiPort, opts.name, announceIp, opts.apiToken);

  console.log();
  console.log(`  ${c('dim','Peer ID  ')} ${c('cyan', node.id)}`);
  console.log(`  ${c('dim','Multiaddr')} ${c('green', node.multiaddr(announceIp))}`);
  console.log(`  ${c('dim','Port     ')} ${node._listenAddr.port}`);
  console.log(`  ${c('dim','API      ')} ${c('blue', `http://localhost:${apiPort}`)}`);
  console.log();

  // Connect to bootstrap peers
  for (const addr of opts.connect) {
    const [ip, portStr] = addr.split(':');
    const port = parseInt(portStr, 10);
    if (!ip || isNaN(port)) {
      console.log(c('red', `  ✗ Invalid --connect address: ${addr}`));
      continue;
    }
    try {
      await node.connect(ip, port);
      await new Promise(r => setTimeout(r, 100));
      console.log(c('green', `  ✓ Connected to ${addr}`));
    } catch (err) {
      console.log(c('red', `  ✗ Could not connect to ${addr}: ${err.message}`));
    }
  }

  if (opts.connect.length > 0) console.log();

  console.log(c('dim', '  Type "help" for available commands.'));
  console.log(c('dim', '─────────────────────────────────────────────────────────────'));
  console.log();

  // ── REPL ──────────────────────────────────────────────────────────────────

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: `${c('yellow', opts.name)}${c('dim', ' >')} `,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const parts  = line.trim().split(/\s+/);
    const cmd    = parts[0]?.toLowerCase();
    const args   = parts.slice(1);

    if (!cmd) { rl.prompt(); return; }

    switch (cmd) {
      case 'add':     await cmdAdd(node, args);     break;
      case 'get':     await cmdGet(node, args);     break;
      case 'ls':      await cmdLs(node, args);      break;
      case 'info':    cmdInfo(node);                break;
      case 'peers':   cmdPeers(node);               break;
      case 'connect': await cmdConnect(node, args); break;
      case 'help':    cmdHelp();                    break;
      case 'exit':
      case 'quit':
        console.log(c('dim', '\n  Shutting down…'));
        apiServer.close();
        await node.stop();
        rl.close();
        process.exit(0);
        break;
      default:
        console.log(c('dim', `  Unknown command: ${cmd}. Type "help" for options.`));
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    apiServer.close();
    await node.stop().catch(() => {});
    process.exit(0);
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', async () => {
    console.log(c('dim', '\n  Shutting down…'));
    apiServer.close();
    await node.stop().catch(() => {});
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
