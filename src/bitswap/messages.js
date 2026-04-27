/**
 * messages.js — Bitswap message types and wire serialisation
 *
 * Every message exchanged between two Bitswap peers is one of these types.
 * The standard types mirror real IPFS Bitswap 1.2.0.
 * The PRIVACY_* types are our extensions for the triple-hash protocol.
 *
 * ── Standard Bitswap message flow ────────────────────────────────────────────
 *
 *   Requester A                        Owner B
 *       │                                  │
 *       │── WANT_HAVE(cid) ───────────────►│  "Do you have this block?"
 *       │◄─ HAVE(cid) ────────────────────│  "Yes"
 *       │   or DONT_HAVE(cid)             │  "No"
 *       │                                  │
 *       │── WANT_BLOCK(cid) ─────────────►│  "Send me the block"
 *       │◄─ BLOCK(cid, data) ─────────────│  "Here it is"
 *       │                                  │
 *       │── CANCEL(cid) ─────────────────►│  "Never mind" (got it elsewhere)
 *
 * ── Privacy protocol message flow ────────────────────────────────────────────
 *
 *   Requester A                        Owner B
 *       │                                  │
 *       │── WANT_HAVE(cid3) ─────────────►│  Step 1: search by CID³
 *       │◄─ PRIVACY_CHALLENGE(sig_cid2) ──│  Step 2: B signs CID² → proves ownership
 *       │                                  │         A verifies sig with B's public key
 *       │── PRIVACY_RESPONSE(             │  Step 3: A encrypts CID¹+K with B's pubkey
 *       │     ecies(cid1 + K, B_pub)) ───►│         B decrypts → verifies CID¹, gets K
 *       │◄─ PRIVACY_BLOCK(aes_K(OBJ)) ───│  Step 4: B encrypts OBJ with K, sends it
 *       │                                  │         A decrypts with K, verifies hash=CID¹
 *
 * ── Wire format ───────────────────────────────────────────────────────────────
 *
 *   All messages are sent over a Connection using the '/bitswap/1.0' protocol.
 *
 *   Binary layout:
 *     [ 1 byte  : message type ]
 *     [ 2 bytes : CID string length (uint16-BE) ]
 *     [ N bytes : CID string (UTF-8) ]
 *     [ 4 bytes : payload length (uint32-BE) ]
 *     [ M bytes : payload (type-dependent) ]
 *
 * SWAP POINT — message format:
 *   Real Bitswap uses protobuf. Replace encode/decode below with
 *   protobuf serialisation for wire compatibility with go-ipfs/kubo.
 */

// ── Message type constants ────────────────────────────────────────────────────

export const MessageType = Object.freeze({
  // Standard Bitswap
  WANT_HAVE    : 0x01,  // "Do you have CID X?"
  HAVE         : 0x02,  // "Yes, I have CID X"
  DONT_HAVE    : 0x03,  // "No, I don't have CID X"
  WANT_BLOCK   : 0x04,  // "Send me the block for CID X"
  BLOCK        : 0x05,  // "Here is the block for CID X"
  CANCEL       : 0x06,  // "Cancel my request for CID X"

  // Privacy protocol extensions
  PRIVACY_CHALLENGE : 0x10,  // B → A: sign(CID²)  [Step 2]
  PRIVACY_RESPONSE  : 0x11,  // A → B: ecies(CID¹ + K, B_pub)  [Step 3]
  PRIVACY_BLOCK     : 0x12,  // B → A: aes_K(OBJ)  [Step 4]

  // Decoy protocol extension (legacy message types — kept for backwards compat
  // but no longer sent on the wire; decoys now reuse PRIVACY_RESPONSE/PRIVACY_BLOCK
  // for full wire indistinguishability)
  DECOY_REQUEST : 0x20,  // DEPRECATED: decoys now use PRIVACY_RESPONSE (0x11)
  DECOY_BLOCK   : 0x21,  // DEPRECATED: decoy responses now use PRIVACY_BLOCK (0x12)

  // Encrypted caching protocol extension
  CACHE_REQUEST   : 0x30,  // C → B: ecies(K + C_pubkey, B_pub) [cache population Step 3]
  CACHE_RESPONSE  : 0x31,  // B → C: AES_K(encrypt(OBJ,H(CID¹))||ts) + auth [Step 4]
  CACHE_CHALLENGE : 0x32,  // C → A: authorization + B_pub + C_pub [cache retrieval Step 6]
  CACHE_BLOCK     : 0x33,  // C → A: AES_K(cached_blob) [cache retrieval Step 8]
});

// Human-readable names for logging
export const MessageTypeName = Object.freeze(
  Object.fromEntries(Object.entries(MessageType).map(([k, v]) => [v, k]))
);

// ── Encode ────────────────────────────────────────────────────────────────────

/**
 * encode(type, cid, payload) → Buffer
 *
 * Serialises a Bitswap message into bytes for transmission.
 *
 * @param {number} type    — one of MessageType.*
 * @param {string} cid     — CID string this message refers to
 * @param {Buffer} [payload] — type-dependent data (empty for WANT_HAVE etc.)
 * @returns {Buffer}
 */
export function encode(type, cid, payload = Buffer.alloc(0)) {
  const cidBytes     = Buffer.from(cid, 'utf8');
  const buf          = Buffer.alloc(1 + 2 + cidBytes.length + 4 + payload.length);
  let offset         = 0;

  buf.writeUInt8(type, offset);                 offset += 1;
  buf.writeUInt16BE(cidBytes.length, offset);   offset += 2;
  cidBytes.copy(buf, offset);                   offset += cidBytes.length;
  buf.writeUInt32BE(payload.length, offset);    offset += 4;
  payload.copy(buf, offset);

  return buf;
}

/**
 * decode(buf) → { type, cid, payload }
 *
 * Deserialises a Bitswap message from bytes.
 *
 * @param {Buffer} buf
 * @returns {{ type: number, cid: string, payload: Buffer }}
 */
export function decode(buf) {
  // Minimum: 1 (type) + 2 (cidLen) + 0 (cid) + 4 (payLen) = 7 bytes
  if (!Buffer.isBuffer(buf) || buf.length < 7) {
    throw new Error('Bitswap decode: buffer too short');
  }

  let offset     = 0;
  const type     = buf.readUInt8(offset);                                 offset += 1;
  const cidLen   = buf.readUInt16BE(offset);                              offset += 2;

  if (offset + cidLen + 4 > buf.length) {
    throw new Error('Bitswap decode: CID length exceeds buffer');
  }
  const cid      = buf.slice(offset, offset + cidLen).toString('utf8');  offset += cidLen;
  const payLen   = buf.readUInt32BE(offset);                              offset += 4;

  if (offset + payLen > buf.length) {
    throw new Error('Bitswap decode: payload length exceeds buffer');
  }
  const payload  = buf.slice(offset, offset + payLen);

  return { type, cid, payload };
}
