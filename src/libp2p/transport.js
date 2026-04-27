/**
 * transport.js — TCP transport with protocol multiplexing
 *
 * This module handles the raw network layer:
 *   - Listening for incoming connections
 *   - Dialing (connecting to) remote peers
 *   - Framing messages so multiple protocols can share one TCP socket
 *   - Peer handshake: exchange public keys and verify identities on connect
 *
 * ── Connection model ─────────────────────────────────────────────────────────
 *
 *   One TCP socket = one Connection.
 *   A Connection multiplexes multiple logical Streams, one per protocol.
 *
 *   Protocol negotiation (simplified multiselect):
 *     1. Dialing side sends:  "/protocol-name\n"
 *     2. Listening side sends "/protocol-name\n" back to confirm, or
 *        "/na\n" to reject.
 *
 *   SWAP POINT — multiplexing:
 *     Real libp2p uses yamux or mplex for full stream multiplexing (multiple
 *     concurrent streams over one connection with independent flow control).
 *     Our simplified version handles one protocol exchange per connection.
 *     To add full muxing: replace Connection with a yamux implementation.
 *
 * ── Message framing ──────────────────────────────────────────────────────────
 *
 *   Raw TCP is a byte stream with no message boundaries. We frame messages as:
 *     [ 4-byte uint32-BE length | payload bytes ]
 *
 *   SWAP POINT — framing:
 *     Could use varint length prefixes (like real libp2p) for smaller overhead
 *     on short messages. Replace readFramed/writeFramed to change this.
 *
 * ── Peer handshake ───────────────────────────────────────────────────────────
 *
 *   On every new connection (dial or accept), both sides:
 *     1. Send their raw public key (DER-encoded SPKI)
 *     2. Receive the remote's public key
 *     3. Derive the remote's PeerId from the key
 *     4. Optionally verify a signed challenge (TODO: noise protocol)
 *
 *   SWAP POINT — security:
 *     Real libp2p uses the Noise protocol (XX handshake) for mutual
 *     authentication and forward secrecy. Our handshake only exchanges
 *     public keys without a signed challenge — sufficient for a learning
 *     implementation where peers are assumed semi-trusted.
 *     To add Noise: replace performHandshake() with a Noise XX implementation.
 */

import net              from 'net';
import EventEmitter     from 'events';
import { createPublicKey, randomBytes, timingSafeEqual } from 'crypto';
import { PeerId }       from './peer.js';
import { sign, verify } from './crypto.js';

// ── Connection ────────────────────────────────────────────────────────────────

/**
 * Connection wraps a TCP socket and provides:
 *   - sendMessage(protocol, payload) — send a framed message for a protocol
 *   - onMessage(protocol, handler)   — register a handler for incoming messages
 *   - close()                        — tear down the socket
 *   - remotePeer                     — the PeerId of the other end (after handshake)
 */
export class Connection extends EventEmitter {
  /**
   * @param {net.Socket} socket
   * @param {PeerId}     localPeer
   */
  constructor(socket, localPeer) {
    super();
    this.socket      = socket;
    this.localPeer   = localPeer;
    this.remotePeer  = null;  // set after handshake
    // Remote address — available immediately from the socket
    this.remoteIp    = socket.remoteAddress || '127.0.0.1';
    this.remotePort  = socket.remotePort    || 0;
    this._buffer     = Buffer.alloc(0);
    this._handlers   = new Map(); // protocol → handler fn

    socket.on('data',  chunk => this._onData(chunk));
    socket.on('error', err   => { if (this.listenerCount('error') > 0) this.emit('error', err); });
    socket.on('close', ()    => this.emit('close'));
  }

  /**
   * sendMessage(protocol, payload) — send a framed protocol message
   *
   * Wire format:
   *   [ 2-byte protocol name length | protocol name bytes ]
   *   [ 4-byte payload length       | payload bytes       ]
   *
   * @param {string} protocol — e.g. '/bitswap/1.0', '/handshake/1.0'
   * @param {Buffer} payload
   */
  sendMessage(protocol, payload) {
    const protoBytes = Buffer.from(protocol, 'utf8');
    const header     = Buffer.alloc(2 + protoBytes.length + 4);
    let offset = 0;
    header.writeUInt16BE(protoBytes.length, offset); offset += 2;
    protoBytes.copy(header, offset);                 offset += protoBytes.length;
    header.writeUInt32BE(payload.length, offset);
    this.socket.write(Buffer.concat([header, payload]));
  }

  /**
   * onMessage(protocol, handler) — register a message handler
   *
   * @param {string}   protocol
   * @param {function} handler — called with (payload: Buffer, connection: Connection)
   */
  onMessage(protocol, handler) {
    this._handlers.set(protocol, handler);
  }

  /** close() — gracefully shut down the connection */
  close() {
    this.socket.end();
  }

  // ── Internal frame parser ─────────────────────────────────────────────────

  _onData(chunk) {
    // Accumulate chunks into an internal buffer
    this._buffer = Buffer.concat([this._buffer, chunk]);

    // Parse as many complete frames as possible
    while (true) {
      // Need at least 2 bytes for protocol name length
      if (this._buffer.length < 2) break;
      const protoLen = this._buffer.readUInt16BE(0);

      // SECURITY: reject absurdly long protocol names (DoS vector)
      if (protoLen > 512) {
        this._buffer = Buffer.alloc(0); // discard the corrupted stream
        this.close();
        return;
      }

      // Need protocol bytes + 4-byte payload length
      if (this._buffer.length < 2 + protoLen + 4) break;
      const protocol   = this._buffer.slice(2, 2 + protoLen).toString('utf8');
      const payloadLen = this._buffer.readUInt32BE(2 + protoLen);

      // SECURITY: reject oversized payloads (16 MiB cap)
      if (payloadLen > 16 * 1024 * 1024) {
        this._buffer = Buffer.alloc(0);
        this.close();
        return;
      }

      // Need full payload
      if (this._buffer.length < 2 + protoLen + 4 + payloadLen) break;

      const payload    = this._buffer.slice(2 + protoLen + 4, 2 + protoLen + 4 + payloadLen);
      this._buffer     = this._buffer.slice(2 + protoLen + 4 + payloadLen);

      // Dispatch to registered handler or emit as generic event
      const handler = this._handlers.get(protocol);
      if (handler) {
        handler(payload, this);
      } else {
        this.emit('message', protocol, payload);
      }
    }
  }
}

// ── Handshake ─────────────────────────────────────────────────────────────────

/**
 * performHandshake(conn) → Promise<void>
 *
 * Two-round authenticated handshake:
 *
 *   Round 1 (simultaneous): each side sends [ pubKeyLen(2) | pubKeyBytes | nonce(32) ]
 *   Round 2 (simultaneous): each side signs the nonce it received and sends the signature
 *
 * After Round 2, both sides have:
 *   - The remote's public key (and derived PeerId)
 *   - Proof that the remote holds the corresponding private key
 *
 * @param {Connection} conn
 * @returns {Promise<void>} resolves when handshake is complete
 */
export function performHandshake(conn) {
  return new Promise((resolve, reject) => {
    // Generate a fresh 32-byte challenge nonce for the remote to sign
    const localNonce  = randomBytes(32);
    const pubKeyBytes = Buffer.from(conn.localPeer.publicKeyRaw);

    // Round 1: send [ pubKeyLen(2) | pubKeyBytes | nonce(32) ]
    const r1 = Buffer.alloc(2 + pubKeyBytes.length + 32);
    r1.writeUInt16BE(pubKeyBytes.length, 0);
    pubKeyBytes.copy(r1, 2);
    localNonce.copy(r1, 2 + pubKeyBytes.length);
    conn.sendMessage('/handshake/1.0', r1);

    let round = 1;

    conn.onMessage('/handshake/1.0', (payload) => {
      try {
        if (round === 1) {
          // Parse remote's Round 1: [ pubKeyLen(2) | pubKeyBytes | nonce(32) ]
          const pkLen         = payload.readUInt16BE(0);
          const remotePubRaw  = payload.slice(2, 2 + pkLen);
          const remoteNonce   = payload.slice(2 + pkLen, 2 + pkLen + 32);

          if (remoteNonce.length !== 32) {
            throw new Error('Round 1: nonce missing or truncated');
          }

          // Derive remote peer identity from their public key
          const remotePubKey  = createPublicKey({ key: remotePubRaw, type: 'spki', format: 'der' });
          conn.remotePeer     = PeerId.fromPublicKey(remotePubKey, remotePubRaw);

          // Round 2: sign the nonce we received, send signature
          const sig = sign(remoteNonce, conn.localPeer.privateKey);
          conn.sendMessage('/handshake/1.0', sig);

          round = 2;

        } else if (round === 2) {
          // payload = remote's signature of localNonce
          // Verify they hold the private key corresponding to the public key in Round 1
          const sigValid = verify(localNonce, payload, conn.remotePeer.publicKey);
          if (!sigValid) {
            throw new Error('Round 2: remote failed private-key challenge');
          }

          conn.emit('ready', conn.remotePeer);
          resolve();
        }
      } catch (err) {
        reject(new Error(`Handshake failed: ${err.message}`));
      }
    });

    // Timeout after 10 seconds
    setTimeout(() => reject(new Error('Handshake timeout')), 10000);
  });
}

// ── TCP Transport ─────────────────────────────────────────────────────────────

/**
 * TCPTransport — manages listening and dialing over TCP
 *
 * Events emitted:
 *   'connection' (conn: Connection) — new incoming connection, after handshake
 *   'error'      (err)
 */
export class TCPTransport extends EventEmitter {
  /**
   * @param {PeerId} localPeer     — this node's identity
   * @param {object} [opts]
   * @param {number} [opts.maxConnections=128] — hard cap on simultaneous connections
   */
  constructor(localPeer, opts = {}) {
    super();
    this.localPeer      = localPeer;
    this.server         = null;
    this.connections    = new Map(); // peerId.id → Connection
    this.maxConnections = opts.maxConnections ?? 128;
  }

  /**
   * listen(port, [host]) → Promise<Multiaddr>
   *
   * Starts listening for incoming TCP connections.
   * Returns the multiaddr others can use to dial this node.
   *
   * @param {number} port
   * @param {string} [host='0.0.0.0']
   * @returns {Promise<import('./peer.js').Multiaddr>}
   */
  listen(port, host = '0.0.0.0', announceHost) {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(socket => {
        // Reject connections beyond the hard cap
        if (this.connections.size >= this.maxConnections) {
          socket.destroy();
          return;
        }
        const conn = new Connection(socket, this.localPeer);
        performHandshake(conn)
          .then(() => {
            this.connections.set(conn.remotePeer.id, conn);
            conn.on('close', () => this.connections.delete(conn.remotePeer?.id));
            this.emit('connection', conn);
          })
          .catch(err => this.emit('error', err));
      });

      this.server.listen(port, host, () => {
        const { address, port: boundPort } = this.server.address();
        // Use caller-supplied announceHost if provided (e.g. LAN IP for multi-machine),
        // otherwise fall back to 127.0.0.1 for local use.
        const listenHost = announceHost || (address === '0.0.0.0' ? '127.0.0.1' : address);
        resolve({ ip: listenHost, port: boundPort, peerId: this.localPeer.id,
                  toString() { return `/ip4/${this.ip}/tcp/${this.port}/p2p/${this.peerId}`; } });
      });

      this.server.on('error', reject);
    });
  }

  /**
   * dial(ip, port) → Promise<Connection>
   *
   * Connects to a remote peer and performs the handshake.
   * Returns a ready Connection with remotePeer set.
   *
   * @param {string} ip
   * @param {number} port
   * @returns {Promise<Connection>}
   */
  dial(ip, port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, ip, async () => {
        const conn = new Connection(socket, this.localPeer);
        try {
          await performHandshake(conn);
          this.connections.set(conn.remotePeer.id, conn);
          conn.on('close', () => this.connections.delete(conn.remotePeer?.id));
          resolve(conn);
        } catch (err) {
          reject(err);
        }
      });

      socket.on('error', reject);
    });
  }

  /**
   * stop() — shut down the TCP server and all connections
   */
  stop() {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    if (this.server) this.server.close();
  }
}
