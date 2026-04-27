/**
 * unixfs.js — UnixFS node types and serialisation
 *
 * UnixFS is the format IPFS uses to represent filesystem objects (files,
 * directories, symlinks) on top of the Merkle DAG. Each DAGNode's data
 * field contains a serialised UnixFS entry that describes what the node is
 * and carries its metadata.
 *
 * ── Node types ────────────────────────────────────────────────────────────────
 *
 *   FILE      — leaf or root of a chunked file. Carries the raw file bytes
 *               (if a single chunk) or is empty with links to chunk leaves.
 *   DIRECTORY — lists named children. Data field carries dir metadata;
 *               links carry { name → child CID }.
 *   SYMLINK   — stores the link target as a UTF-8 string in the data field.
 *   RAW       — raw bytes with no metadata (used for inner chunk leaves).
 *
 * ── Serialisation format ──────────────────────────────────────────────────────
 *
 * We use a simple hand-rolled binary format (no protobuf dependency):
 *
 *   [ 1 byte  : type (0=raw,1=file,2=directory,3=symlink) ]
 *   [ 8 bytes : filesize as uint64-BE (total uncompressed bytes) ]
 *   [ 8 bytes : mtime as uint64-BE (ms since Unix epoch, 0 if unknown) ]
 *   [ 4 bytes : mode as uint32-BE (Unix permission bits, 0 if unknown) ]
 *   [ 2 bytes : name length as uint16-BE ]
 *   [ N bytes : name (UTF-8) ]
 *   [ 4 bytes : data length as uint32-BE ]
 *   [ M bytes : data (raw file bytes for FILE/RAW, target for SYMLINK, empty for DIR) ]
 *
 * SWAP POINT — serialisation:
 *   Real IPFS uses Protocol Buffers (dag-pb) for this. To switch:
 *     1. Install @ipld/dag-pb and multiformats npm packages.
 *     2. Replace serialize() and deserialize() below with protobuf encode/decode.
 *     3. Update MULTICODEC in cid.js from 0x55 (raw) to 0x70 (dag-pb).
 *   Everything above this layer (importer, exporter) stays the same.
 */

// ── Node type constants ───────────────────────────────────────────────────────

export const NodeType = Object.freeze({
  RAW:       0,
  FILE:      1,
  DIRECTORY: 2,
  SYMLINK:   3,
});

// ── UnixFSNode class ──────────────────────────────────────────────────────────

export class UnixFSNode {
  /**
   * @param {number} type       — one of NodeType.*
   * @param {object} [opts]
   * @param {number} [opts.filesize=0]  — total uncompressed file size in bytes
   * @param {number} [opts.mtime=0]     — modification time (ms since epoch)
   * @param {number} [opts.mode=0]      — Unix permission bits (e.g. 0o644)
   * @param {string} [opts.name='']     — entry name (used in directory listings)
   * @param {Buffer} [opts.data]        — payload: file bytes, symlink target, etc.
   */
  constructor(type, { filesize = 0, mtime = 0, mode = 0, name = '', data = Buffer.alloc(0) } = {}) {
    this.type     = type;
    this.filesize = filesize;
    this.mtime    = mtime;
    this.mode     = mode;
    this.name     = name;
    this.data     = data;
  }

  isFile()      { return this.type === NodeType.FILE      || this.type === NodeType.RAW; }
  isDirectory() { return this.type === NodeType.DIRECTORY; }
  isSymlink()   { return this.type === NodeType.SYMLINK;   }
}

// ── Serialisation ─────────────────────────────────────────────────────────────

/**
 * serialize(unixfsNode) → Buffer
 *
 * Converts a UnixFSNode into bytes for storage in a DAGNode's data field.
 *
 * @param {UnixFSNode} node
 * @returns {Buffer}
 */
export function serialize(node) {
  const nameBytes = Buffer.from(node.name, 'utf8');
  const dataBytes = node.data;

  // Total buffer size:
  // 1 (type) + 8 (filesize) + 8 (mtime) + 4 (mode)
  // + 2 (nameLen) + nameBytes.length
  // + 4 (dataLen) + dataBytes.length
  const buf = Buffer.alloc(1 + 8 + 8 + 4 + 2 + nameBytes.length + 4 + dataBytes.length);
  let offset = 0;

  buf.writeUInt8(node.type, offset);          offset += 1;

  // filesize as two 32-bit words (JS numbers are 64-bit floats, safe up to 2^53)
  const fsHi = Math.floor(node.filesize / 0x100000000);
  const fsLo = node.filesize >>> 0;
  buf.writeUInt32BE(fsHi, offset);            offset += 4;
  buf.writeUInt32BE(fsLo, offset);            offset += 4;

  // mtime
  const mtHi = Math.floor(node.mtime / 0x100000000);
  const mtLo = node.mtime >>> 0;
  buf.writeUInt32BE(mtHi, offset);            offset += 4;
  buf.writeUInt32BE(mtLo, offset);            offset += 4;

  buf.writeUInt32BE(node.mode, offset);       offset += 4;
  buf.writeUInt16BE(nameBytes.length, offset);offset += 2;
  nameBytes.copy(buf, offset);                offset += nameBytes.length;
  buf.writeUInt32BE(dataBytes.length, offset);offset += 4;
  dataBytes.copy(buf, offset);

  return buf;
}

/**
 * deserialize(buf) → UnixFSNode
 *
 * Reconstructs a UnixFSNode from its serialised bytes.
 *
 * @param {Buffer} buf
 * @returns {UnixFSNode}
 */
export function deserialize(buf) {
  let offset = 0;

  const type    = buf.readUInt8(offset);                        offset += 1;
  const fsHi    = buf.readUInt32BE(offset);                     offset += 4;
  const fsLo    = buf.readUInt32BE(offset);                     offset += 4;
  const filesize = fsHi * 0x100000000 + fsLo;
  const mtHi    = buf.readUInt32BE(offset);                     offset += 4;
  const mtLo    = buf.readUInt32BE(offset);                     offset += 4;
  const mtime   = mtHi * 0x100000000 + mtLo;
  const mode    = buf.readUInt32BE(offset);                     offset += 4;
  const nameLen = buf.readUInt16BE(offset);                     offset += 2;
  const name    = buf.slice(offset, offset + nameLen).toString('utf8'); offset += nameLen;
  const dataLen = buf.readUInt32BE(offset);                     offset += 4;
  const data    = buf.slice(offset, offset + dataLen);

  return new UnixFSNode(type, { filesize, mtime, mode, name, data });
}
