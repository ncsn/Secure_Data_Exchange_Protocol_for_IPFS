/**
 * node.js — DAG Node definition
 *
 * A DAG (Directed Acyclic Graph) node is the fundamental unit of data in IPFS.
 * Every file, directory, and chunk is represented as a DAG node.
 *
 * Structure of a node:
 *
 *   ┌─────────────────────────────────────┐
 *   │  data  : Buffer  (raw chunk bytes)  │
 *   │  links : Link[]  (children)         │
 *   │  cid   : CID     (this node's addr) │
 *   └─────────────────────────────────────┘
 *
 * A Link points to a child node:
 *
 *   ┌──────────────────────────────────────────┐
 *   │  name  : string  (e.g. "chunk-0")        │
 *   │  cid   : CID     (address of child)      │
 *   │  size  : number  (total bytes in subtree) │
 *   └──────────────────────────────────────────┘
 *
 * The Merkle property:
 *   A node's CID is derived from its serialised content (data + links).
 *   Changing any descendant changes its CID, which changes every ancestor's
 *   CID all the way up to the root. Tampering is always detectable.
 *
 * Serialisation format (used when computing the CID of a node):
 *
 *   [ 4-byte-BE data_length | data | for each link: encoded_link ]
 *
 *   encoded_link:
 *   [ 1-byte name_length | name_bytes | 32-byte cid_digest | 8-byte-BE size ]
 *
 *   SWAP POINT: This is a simplified binary format for learning purposes.
 *   In real IPFS, nodes are serialised as Protocol Buffers (dag-pb format).
 *   To switch to protobuf serialisation:
 *     1. Install the 'protobufjs' or '@ipld/dag-pb' npm package.
 *     2. Replace the serialize() function below with a protobuf encoder.
 *     3. Update the MULTICODEC in cid.js from 0x55 (raw) to 0x70 (dag-pb).
 */

import { CID } from '../cid/cid.js';
import { hash, toMultihash } from '../cid/crypto.js';

// ── Link ─────────────────────────────────────────────────────────────────────

export class Link {
  /**
   * @param {string} name  — human-readable label (e.g. "chunk-0", "file.txt")
   * @param {CID}    cid   — content address of the linked node
   * @param {number} size  — total byte size of the linked subtree
   */
  constructor(name, cid, size) {
    this.name = name;
    this.cid  = cid;
    this.size = size;
  }
}

// ── DAGNode ──────────────────────────────────────────────────────────────────

export class DAGNode {
  /**
   * @param {Buffer} data    — raw bytes stored in this node (may be empty)
   * @param {Link[]} links   — ordered list of child links
   */
  constructor(data = Buffer.alloc(0), links = []) {
    this.data  = data;
    this.links = links;

    // Serialise then hash to get this node's CID.
    // The CID commits to both the data and all child CIDs — the Merkle property.
    const serialised = serialize(this);
    const digest     = hash(serialised);
    this.cid         = new CID(digest);

    // Total size = own data + all children's sizes
    this.size = data.length + links.reduce((sum, l) => sum + l.size, 0);
  }

  /**
   * Returns a Link pointing to this node, for use in a parent node.
   *
   * @param {string} name — label for this link
   * @returns {Link}
   */
  asLink(name) {
    return new Link(name, this.cid, this.size);
  }
}

// ── Serialisation ─────────────────────────────────────────────────────────────

/**
 * serialize(node) → Buffer
 *
 * Converts a DAGNode into a deterministic byte sequence used for hashing.
 *
 * Layout:
 *   [ uint32-BE: data.length ]
 *   [ data bytes            ]
 *   for each link (in order):
 *     [ uint8:    name.length in bytes ]
 *     [ name bytes (UTF-8)            ]
 *     [ 32 bytes: child CID digest    ]
 *     [ uint64-BE: link.size          ]  ← encoded as two uint32s (hi, lo)
 *
 * SWAP POINT: Replace this with a protobuf encoder for real dag-pb
 * compatibility. The structure above is intentionally simple so every
 * byte is easy to inspect and understand.
 *
 * @param {DAGNode} node
 * @returns {Buffer}
 */
export function serialize(node) {
  const parts = [];

  // data length prefix + data
  const dataLen = Buffer.alloc(4);
  dataLen.writeUInt32BE(node.data.length, 0);
  parts.push(dataLen, node.data);

  // each link
  for (const link of node.links) {
    const nameBytes = Buffer.from(link.name, 'utf8');

    // name length (1 byte — max 255 char name)
    const nameLen = Buffer.alloc(1);
    nameLen.writeUInt8(nameBytes.length, 0);

    // size as two 32-bit big-endian words (covers files up to 2^53 bytes)
    const sizeBuf = Buffer.alloc(8);
    const hi = Math.floor(link.size / 0x100000000);
    const lo = link.size >>> 0;
    sizeBuf.writeUInt32BE(hi, 0);
    sizeBuf.writeUInt32BE(lo, 4);

    parts.push(nameLen, nameBytes, link.cid.digest, sizeBuf);
  }

  return Buffer.concat(parts);
}

/**
 * deserialize(buf) → { data, links: Array<{name, cidDigest, size}> }
 *
 * Reverses serialize(). Returns proper Link objects with full CID instances
 * so any code reading from the block store gets fully-formed links it can
 * traverse immediately (link.cid.string works without extra reconstruction).
 *
 * @param {Buffer} buf
 * @returns {{ data: Buffer, links: Link[] }}
 */
export function deserialize(buf) {
  let offset = 0;

  // read data
  const dataLen = buf.readUInt32BE(offset); offset += 4;
  const data    = buf.slice(offset, offset + dataLen); offset += dataLen;

  // read links
  const links = [];
  while (offset < buf.length) {
    const nameLen   = buf.readUInt8(offset); offset += 1;
    const name      = buf.slice(offset, offset + nameLen).toString('utf8'); offset += nameLen;
    const cidDigest = buf.slice(offset, offset + 32); offset += 32;
    const hi        = buf.readUInt32BE(offset); offset += 4;
    const lo        = buf.readUInt32BE(offset); offset += 4;
    const size      = hi * 0x100000000 + lo;
    // Reconstruct a proper CID from the stored digest so callers can use
    // link.cid.string directly without any extra reconstruction step.
    links.push(new Link(name, new CID(cidDigest), size));
  }

  return { data, links };
}
