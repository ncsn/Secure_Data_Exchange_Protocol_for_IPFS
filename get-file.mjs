#!/usr/bin/env node

/**
 * get-file.mjs — CLI tool to retrieve a file using the privacy protocol
 *
 * Usage:
 *   node get-file.mjs <CID1> <host> <port> [output-path]
 *
 * Example:
 *   node get-file.mjs bafkrei... 127.0.0.1 4001
 *   node get-file.mjs bafkrei... localhost 4001 ./myfile.bin
 */

import fs from 'fs';
import path from 'path';
import { Node } from './src/node/node.js';
import { cidFromString } from './src/cid/cid.js';
import { hash } from './src/cid/crypto.js';
import { CID } from './src/cid/cid.js';

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length < 3) {
  console.log('Usage: node get-file.mjs <CID1> <host> <port> [output-path]');
  console.log('');
  console.log('  CID1        The private CID (starts with "b", ~59 chars)');
  console.log('  host        IP or hostname of the owner/provider node');
  console.log('  port        TCP port of the owner/provider node');
  console.log('  output-path Optional output file path (default: ./retrieved-<cid>.bin)');
  process.exit(1);
}

const [cid1String, host, portStr, outputArg] = args;
const port = parseInt(portStr, 10);

if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${portStr}`);
  process.exit(1);
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('IPFS Privacy Protocol — CLI File Retrieval');
  console.log('==========================================');
  console.log('');

  // Parse CID1
  let cid1;
  try {
    cid1 = cidFromString(cid1String);
  } catch (e) {
    console.error(`Invalid CID1: ${e.message}`);
    process.exit(1);
  }

  const h1 = cid1.digest;          // H(OBJ)
  const h2 = hash(h1);             // H(H(OBJ))
  const h3 = hash(h2);             // H(H(H(OBJ)))
  const cid3 = new CID(h3);

  console.log(`  CID1:  ${cid1String.slice(0, 40)}...`);
  console.log(`  CID3:  ${cid3.string.slice(0, 40)}... (derived)`);
  console.log(`  Peer:  ${host}:${port}`);
  console.log('');

  // Create a temporary node
  const node = new Node({ announceIp: '127.0.0.1' });
  const listenPort = await node.start(0);
  console.log(`  Local node started on port ${listenPort}`);
  console.log(`  Peer ID: ${node.id}`);
  console.log('');

  // Connect to the target peer
  console.log(`  Connecting to ${host}:${port}...`);
  try {
    await node.connect(host, port);
  } catch (e) {
    console.error(`  Failed to connect: ${e.message}`);
    await node.stop();
    process.exit(1);
  }
  console.log('  Connected!');
  console.log('');

  // Small delay for handler registration
  await new Promise(r => setTimeout(r, 100));

  // Retrieve the file using the 4-step privacy protocol
  console.log('  Starting 4-step privacy handshake...');
  console.log('    Step 1: WANT_HAVE(CID3) →');

  let bytes;
  try {
    bytes = await node.get(cid3.string, h1);
  } catch (e) {
    console.error(`  Retrieval failed: ${e.message}`);
    await node.stop();
    process.exit(1);
  }

  console.log('    Step 2: ← PRIVACY_CHALLENGE (signature verified)');
  console.log('    Step 3: PRIVACY_RESPONSE (encrypted CID1 + K) →');
  console.log('    Step 4: ← PRIVACY_BLOCK (decrypted and verified)');
  console.log('');
  console.log(`  Retrieved ${bytes.length} bytes`);

  // Verify integrity
  const verifyHash = hash(bytes);
  const verified = Buffer.from(verifyHash).equals(Buffer.from(h1));
  console.log(`  Integrity: ${verified ? 'PASS — H(data) matches CID1' : 'FAIL — hash mismatch!'}`);

  // Save to file
  const outputPath = outputArg || `./retrieved-${cid1String.slice(1, 13)}.bin`;
  fs.writeFileSync(outputPath, bytes);
  console.log(`  Saved to: ${path.resolve(outputPath)}`);

  // Try to show content if it looks like text
  if (bytes.length < 2000) {
    try {
      const text = bytes.toString('utf8');
      if (/^[\x20-\x7E\r\n\t]+$/.test(text.slice(0, 200))) {
        console.log('');
        console.log('  Content preview:');
        console.log('  ─────────────────────────────────────────');
        for (const line of text.split('\n').slice(0, 10)) {
          console.log(`  ${line}`);
        }
        if (text.split('\n').length > 10) console.log('  ...');
        console.log('  ─────────────────────────────────────────');
      }
    } catch {}
  }

  console.log('');
  console.log('Done.');

  await node.stop();
  process.exit(0);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
