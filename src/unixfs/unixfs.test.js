/**
 * unixfs.test.js — Tests for the UnixFS layer
 *
 * Run with:  node src/unixfs/unixfs.test.js
 *
 * Tests:
 *   1.  UnixFSNode serialize/deserialize round-trip (FILE)
 *   2.  UnixFSNode serialize/deserialize round-trip (DIRECTORY)
 *   3.  UnixFSNode serialize/deserialize round-trip (SYMLINK)
 *   4.  addBytes() stores blocks and returns a CID
 *   5.  cat() recovers exact bytes for a small file
 *   6.  cat() recovers exact bytes for a multi-chunk file
 *   7.  stat() returns correct metadata (name, filesize, mtime, mode)
 *   8.  addFile() reads a real file from disk
 *   9.  addDirectory() adds a directory with multiple files
 *   10. ls() lists directory entries with correct names and types
 *   11. cat() throws on a directory CID
 *   12. ls() throws on a file CID
 *   13. Identical files produce the same root CID (deterministic, no mtime)
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';

import { UnixFSNode, NodeType, serialize as serializeUnixFS, deserialize as deserializeUnixFS } from './unixfs.js';
import { addBytes, addFile, addDirectory }  from './importer.js';
import { cat, ls, stat }                    from './exporter.js';
import { BlockStore }                       from '../blockstore/blockstore.js';
import { CHUNK_SIZE }                       from '../dag/chunker.js';

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-unixfs-'));
  tmpDirs.push(d);
  return d;
}

function cleanup() {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

function freshStore() { return new BlockStore(tmpDir()); }

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗  ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function assert(cond, msg)   { if (!cond)    throw new Error(msg  || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`); }
function assertThrows(fn, msg)  {
  try { fn(); } catch { return; }
  throw new Error(msg || 'Expected function to throw');
}

// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── UnixFS Tests ──────────────────────────────────────────────\n');

// 1. FILE node round-trip
test('UnixFSNode FILE serialize/deserialize round-trip', () => {
  const node = new UnixFSNode(NodeType.FILE, {
    filesize: 1234,
    mtime:    1700000000000,
    mode:     0o644,
    name:     'hello.txt',
    data:     Buffer.from('hello world'),
  });
  const buf      = serializeUnixFS(node);
  const restored = deserializeUnixFS(buf);

  assertEqual(restored.type,             NodeType.FILE,       'type mismatch');
  assertEqual(restored.filesize,         1234,                'filesize mismatch');
  assertEqual(restored.mtime,            1700000000000,       'mtime mismatch');
  assertEqual(restored.mode,             0o644,               'mode mismatch');
  assertEqual(restored.name,             'hello.txt',         'name mismatch');
  assert(restored.data.equals(Buffer.from('hello world')),    'data mismatch');
});

// 2. DIRECTORY node round-trip
test('UnixFSNode DIRECTORY serialize/deserialize round-trip', () => {
  const node     = new UnixFSNode(NodeType.DIRECTORY, { name: 'mydir' });
  const restored = deserializeUnixFS(serializeUnixFS(node));
  assertEqual(restored.type, NodeType.DIRECTORY, 'type mismatch');
  assertEqual(restored.name, 'mydir',            'name mismatch');
  assert(restored.isDirectory(),                 'isDirectory() returned false');
});

// 3. SYMLINK node round-trip
test('UnixFSNode SYMLINK serialize/deserialize round-trip', () => {
  const node     = new UnixFSNode(NodeType.SYMLINK, {
    name: 'link.txt',
    data: Buffer.from('../other.txt'),
  });
  const restored = deserializeUnixFS(serializeUnixFS(node));
  assertEqual(restored.type, NodeType.SYMLINK,   'type mismatch');
  assertEqual(restored.name, 'link.txt',         'name mismatch');
  assert(restored.data.equals(Buffer.from('../other.txt')), 'target mismatch');
  assert(restored.isSymlink(),                   'isSymlink() returned false');
});

// 4. addBytes() stores blocks and returns a valid CID string
test('addBytes() stores blocks and returns a CID string', () => {
  const store = freshStore();
  const cid   = addBytes(Buffer.from('hello world'), store, { name: 'test.txt' });

  assert(typeof cid === 'string',  'Expected a CID string');
  assert(cid.startsWith('b'),      'CID should start with base32 prefix "b"');
  assert(store.has(cid),           'Root block should be in the store');
  assert(store.isPinned(cid),      'Root should be pinned');
});

// 5. cat() recovers exact bytes — small file
test('cat() recovers exact bytes for a small file', () => {
  const store    = freshStore();
  const original = Buffer.from('The quick brown fox jumps over the lazy dog');
  const cid      = addBytes(original, store, { name: 'fox.txt' });
  const recovered = cat(cid, store);

  assert(original.equals(recovered), 'Recovered bytes do not match original');
});

// 6. cat() recovers exact bytes — multi-chunk file
test('cat() recovers exact bytes for a multi-chunk file', () => {
  const store    = freshStore();
  const original = Buffer.alloc(CHUNK_SIZE * 2 + 1234, 0xab);
  const cid      = addBytes(original, store, { name: 'big.bin' });
  const recovered = cat(cid, store);

  assert(original.equals(recovered), 'Multi-chunk recovery failed');
});

// 7. stat() returns correct metadata
test('stat() returns name, filesize, mtime, mode', () => {
  const store  = freshStore();
  const data   = Buffer.from('metadata test');
  const mtime  = 1700000000000;
  const cid    = addBytes(data, store, { name: 'meta.txt', mtime, mode: 0o755 });
  const info   = stat(cid, store);

  assertEqual(info.name,     'meta.txt',    'name mismatch');
  assertEqual(info.filesize, data.length,   'filesize mismatch');
  assertEqual(info.mtime,    mtime,         'mtime mismatch');
  assertEqual(info.mode,     0o755,         'mode mismatch');
});

// 8. addFile() reads a real file from disk
test('addFile() reads a real file from disk and cat() recovers it', () => {
  const storeDir = tmpDir();
  const store    = new BlockStore(storeDir);

  // Write a temp file
  const fileDir  = tmpDir();
  const filePath = path.join(fileDir, 'sample.txt');
  const content  = Buffer.from('This is a real file on disk.\n'.repeat(50));
  fs.writeFileSync(filePath, content);

  const cid       = addFile(filePath, store);
  const recovered = cat(cid, store);

  assert(content.equals(recovered), 'addFile + cat round-trip failed');

  // Check stat has the right name
  const info = stat(cid, store);
  assertEqual(info.name, 'sample.txt', 'addFile should capture filename');
});

// 9. addDirectory() adds a directory with multiple files
test('addDirectory() adds a directory with multiple files', () => {
  const store  = freshStore();
  const dirPath = tmpDir();

  // Create test files
  fs.writeFileSync(path.join(dirPath, 'a.txt'), Buffer.from('file a content'));
  fs.writeFileSync(path.join(dirPath, 'b.txt'), Buffer.from('file b content'));
  fs.mkdirSync(path.join(dirPath, 'sub'));
  fs.writeFileSync(path.join(dirPath, 'sub', 'c.txt'), Buffer.from('file c in subdir'));

  const dirCid = addDirectory(dirPath, store);

  assert(typeof dirCid === 'string', 'Expected a CID string for directory');
  assert(store.has(dirCid),          'Directory root should be in store');
});

// 10. ls() lists directory entries
test('ls() lists directory entries with correct names and types', () => {
  const store   = freshStore();
  const dirPath = tmpDir();

  fs.writeFileSync(path.join(dirPath, 'readme.txt'), Buffer.from('hello'));
  fs.writeFileSync(path.join(dirPath, 'data.bin'),   Buffer.from('binary'));
  fs.mkdirSync(path.join(dirPath, 'assets'));
  fs.writeFileSync(path.join(dirPath, 'assets', 'img.png'), Buffer.from('fake png'));

  const dirCid  = addDirectory(dirPath, store);
  const entries = ls(dirCid, store);
  const names   = entries.map(e => e.name).sort();

  assert(names.includes('readme.txt'), 'Expected readme.txt in listing');
  assert(names.includes('data.bin'),   'Expected data.bin in listing');
  assert(names.includes('assets'),     'Expected assets/ in listing');

  const assetsEntry = entries.find(e => e.name === 'assets');
  assertEqual(assetsEntry.type, 'directory', 'assets should be type directory');

  const readmeEntry = entries.find(e => e.name === 'readme.txt');
  assertEqual(readmeEntry.type, 'file', 'readme.txt should be type file');
});

// 11. cat() throws on a directory CID
test('cat() throws a helpful error when called on a directory', () => {
  const store   = freshStore();
  const dirPath = tmpDir();
  fs.writeFileSync(path.join(dirPath, 'x.txt'), Buffer.from('x'));
  const dirCid = addDirectory(dirPath, store);
  assertThrows(() => cat(dirCid, store), 'Expected cat() to throw on directory CID');
});

// 12. ls() throws on a file CID
test('ls() throws a helpful error when called on a file', () => {
  const store = freshStore();
  const cid   = addBytes(Buffer.from('not a dir'), store);
  assertThrows(() => ls(cid, store), 'Expected ls() to throw on file CID');
});

// 13. Identical content + no mtime → same CID
test('Identical content with mtime=0 produces the same CID every time', () => {
  const store1 = freshStore();
  const store2 = freshStore();
  const data   = Buffer.from('deterministic content');

  const cid1 = addBytes(data, store1, { name: 'f.txt', mtime: 0, mode: 0o644 });
  const cid2 = addBytes(data, store2, { name: 'f.txt', mtime: 0, mode: 0o644 });

  assertEqual(cid1, cid2, 'Same content + same metadata should produce same CID');
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ─────────────────────────────────\n`);

// Demo: add a small directory tree and show the listing
console.log('── Directory tree demo ───────────────────────────────────────\n');
const demoStore = freshStore();
const demoDir   = tmpDir();
fs.writeFileSync(path.join(demoDir, 'hello.txt'),  Buffer.from('Hello, IPFS!'));
fs.writeFileSync(path.join(demoDir, 'world.txt'),  Buffer.from('World content here'));
fs.mkdirSync(path.join(demoDir, 'docs'));
fs.writeFileSync(path.join(demoDir, 'docs', 'readme.md'), Buffer.from('# README\nThis is a test.'));

const rootCid = addDirectory(demoDir, demoStore);
console.log(`  Directory CID : ${rootCid}\n`);
console.log('  Contents:');
for (const entry of ls(rootCid, demoStore)) {
  const icon = entry.type === 'directory' ? '📁' : '📄';
  console.log(`    ${icon}  ${entry.name.padEnd(20)} ${entry.cid.slice(0, 24)}...`);
}
console.log();

cleanup();
