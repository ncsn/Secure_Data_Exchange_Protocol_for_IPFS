# IPFS Privacy Desktop

Electron desktop application for the **Triple-Hash Enhanced Privacy Protocol** — a privacy-preserving file sharing system built on IPFS concepts with a custom Kademlia DHT, Bitswap engine, and 4-step authenticated handshake.

## What It Does

Standard IPFS publishes a single content-addressed CID to a public DHT. Anyone watching the network can link "who requested what" to a specific file. This project breaks that link with **triple hashing**:

| CID | Derivation | Visibility | Purpose |
|-----|-----------|------------|---------|
| **CID1** | `H(file)` | Private (shared out-of-band) | Used by requester to retrieve file |
| **CID2** | `H(H(file))` | Secret (never leaves owner) | Ownership proof (signed challenge) |
| **CID3** | `H(H(H(file)))` | Public (published to DHT) | Network discovery — cannot be reversed to CID1 |

The **4-step Enhanced Privacy Protocol** prevents the DHT from ever learning which file a user actually wants:

```
Requester (A)                     Owner (B)
    |                                  |
    |--- WANT_HAVE(CID3) ------------->|     Step 1: A searches by public CID
    |<-- PRIVACY_CHALLENGE(sig(CID2))->|    Step 2: B proves ownership
    |--- PRIVACY_RESPONSE ------------>|     Step 3: A sends ecies(CID1 + K, B_pubkey)
    |<-- PRIVACY_BLOCK(aes_K(file)) -->|    Step 4: B sends encrypted file
    |                                  |
    verify H(decrypted) == CID1 digest
```

## Quick Start

### Prerequisites

- Node.js 18+
- npm

### Install and Run

```bash
git clone https://github.com/ncsn/IPFS_enhanced_privacy.git
cd IPFS_enhanced_privacy
npm install
npm start
```

### Docker (3-node test network)

```bash
cd docker
docker compose build
docker compose up
```

Runs three nodes:

| Service | Port | Role |
|---------|------|------|
| **owner** | 4001 | Adds a test file, publishes CID1+CID3 to DHT |
| **cache** | 4002 | Connects to owner, caches the file (encrypted) |
| **requester** | 4003 | Connects to cache, retrieves via privacy protocol |

The automated test runs automatically — you'll see `PASS` or `FAIL` in the output.

## Features

### 10-Tab Desktop Application

- **Dashboard** — Peer ID, connections, storage, cached items, DHT peers. Privacy health score (good/fair/poor). Network topology canvas showing connected peers in a radial graph.
- **Add File** — Drag-and-drop or file browser. Computes triple-hash CIDs and publishes CID3 to DHT.
- **Get File** — Enter CID1 to retrieve. Visual 4-step protocol stepper shows handshake progress in real-time.
- **Storage** — Browse all local blocks, pin/unpin management (recursive/direct), garbage collection, disk usage bar.
- **Peers** — Connect by IP:port, per-peer bandwidth stats (bytes sent/received from Bitswap ledgers), disconnect individual peers.
- **Cache** — Cache encrypted objects from peers using CID3. Cache node never learns CID1 (zero-knowledge caching).
- **DHT** — Kademlia routing table: collapsible k-buckets, provider records, CID registry (decoy targets), interactive lookup tool.
- **Event Log** — Real-time timestamped event stream with color-coded levels.
- **Settings** — Listen port, announce IP, decoy toggle, manual decoy trigger, bootstrap peers (auto-connect on start), download path.
- **Toast Notifications** — Non-intrusive slide-in alerts for connections, transfers, and errors.

### Privacy

- **Triple-hash CID scheme** — DHT observers cannot reverse CID3 to CID1
- **ECIES + AES encrypted transfer** — End-to-end with ephemeral session key
- **Decoy traffic** — 1-3 automatic random requests after each real retrieval (100-2000ms stagger)
- **Privacy health score** — Dashboard indicator based on decoy config, registry size, and peer count
- **Encrypted caching** — Cache nodes store `AES(file, H(CID1))` without learning CID1
- **Ownership challenge** — Owner signs CID2 to prove possession without revealing the file

### Networking

- **Custom Kademlia DHT** — 256 k-buckets, K=20, alpha=3, XOR distance metric
- **Custom Bitswap engine** — Per-peer ledgers with debt ratio, incentive-compatible serving
- **TCP transport** — Authenticated handshake with ECDSA P-256, 16 MiB payload cap
- **Bootstrap peers** — Saved to `~/.ipfs-desktop-privacy/bootstrap.json`, auto-connect on start

## Architecture

```
Electron Renderer (HTML/CSS/JS)
    |
    |  IPC (contextBridge)
    v
Electron Main Process (main.cjs)
    |
    |  controller/controller.cjs
    v
Core Node (src/)
    ├── node/       — Node class, orchestrates all subsystems
    ├── bitswap/    — Block exchange + privacy protocol + decoys
    ├── dht/        — Kademlia DHT + provider records
    ├── blockstore/ — Filesystem block storage + pinning + GC
    ├── cid/        — Triple-hash CID computation + crypto
    ├── unixfs/     — File import/export (chunking, directories)
    ├── dag/        — DAG node serialization
    └── libp2p/     — TCP transport + connection multiplexing
```

## Project Structure

```
ipfs-desktop/
├── main.cjs                 — Electron main process + IPC handlers
├── preload.cjs              — Context bridge (window.ipfs API)
├── controller/
│   └── controller.cjs       — Bridge: main process ↔ core node
├── renderer/
│   ├── index.html           — Single-page app (10 tab sections)
│   ├── renderer.js          — UI logic, event handling, canvas topology
│   └── styles.css           — Dark theme, cards, tables, animations
├── src/
│   ├── node/node.js         — Node class
│   ├── bitswap/bitswap.js   — Bitswap engine + privacy handshake
│   ├── dht/dht.js           — DHT node
│   ├── dht/kademlia.js      — Routing table + XOR distance
│   ├── blockstore/          — Block storage + pinning + GC
│   ├── cid/                 — CID + triple-hash + crypto
│   ├── unixfs/              — File import/export
│   ├── dag/                 — DAG serialization
│   └── libp2p/              — TCP transport
├── docker/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── docker-node.mjs      — Docker entry point
├── get-file.mjs             — CLI retrieval tool
└── package.json
```

## Usage Guide

### Basic Workflow

1. Click **Start Node** in the sidebar
2. Add bootstrap peers in **Settings** (e.g. `127.0.0.1:4001` for a Docker node)
3. Go to **Add File** — drop a file. Copy the CID1 shown.
4. Share CID1 privately with the recipient
5. Recipient enters CID1 in **Get File** — watches the 4-step protocol complete
6. File is saved to the Downloads folder

### Key Rules

- **Get File** always uses **CID1** (the private CID)
- **Cache** always uses **CID3** (the public CID)
- **CID2** is never shared — the system uses it internally for ownership proofs

### Encrypted Caching

```
Cache (C)                          Owner (B)
    |--- WANT_HAVE(CID3) ------------->|
    |<-- PRIVACY_CHALLENGE(sig(CID2))->|
    |--- CACHE_REQUEST(ecies(K+pub))-->|
    |<-- CACHE_RESPONSE -------------->|
    |    aes_K(aes(file, H(CID1)) + timestamp) + authorization
    store encrypted blob (never learns CID1)
```

### Decoy Requests

Prevents traffic analysis by sending fake requests indistinguishable from real ones:
- Steps 1-2 are identical to a real handshake
- Step 3: sends `ecies(DECOY_FLAG)` instead of `ecies(CID1+K)` — encrypted, so observers can't tell
- Step 4: owner sends random bytes back
- After each real retrieval, 1-3 automatic decoys fire in the background

### CLI Retrieval

```bash
node get-file.mjs <CID1> <host> <port> [output-path]

# Examples
node get-file.mjs bafkrei... localhost 4001          # From Docker owner
node get-file.mjs bafkrei... localhost 4002          # From Docker cache
node get-file.mjs bafkrei... localhost <port>        # From Desktop app (check Event Log for port)
```

## Testing

### Unit Tests

```bash
node src/bitswap/bitswap.test.js    # Bitswap unit tests
node src/node/node.test.js          # Node integration tests
node src/dht/dht.test.js            # DHT unit tests
node src/cid/cid.test.js            # CID tests
node src/blockstore/blockstore.test.js
node src/unixfs/unixfs.test.js
```

### Docker Integration Test

```bash
cd docker
docker compose up --build    # Runs owner → cache → requester → PASS/FAIL
docker compose down          # Cleanup
```

## Common Mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Using CID3 in Get File | "Could not find this content" | Use **CID1** |
| Using CID1 in Cache tab | Cache fails | Use **CID3** |
| Caching your own file from remote peer | "Peer does not have block" | Cache files the *remote peer* owns |
| Decoy fails: "no eligible targets" | No remote CID3 in registry | Connect to a peer who owns content, wait for DHT sync |

## Technical Details

### Kademlia DHT

- 256-bit XOR metric space (SHA-256 hashed peer/CID IDs)
- 256 k-buckets, max 20 peers per bucket
- Iterative lookup with alpha=3 parallel queries
- Provider records with 24-hour TTL, hourly cleanup
- Memory-bounded: max 100 providers/CID, max 10,000 CIDs

### Bitswap Protocol

- Standard: WANT_HAVE, HAVE, DONT_HAVE, WANT_BLOCK, BLOCK, CANCEL
- Privacy: PRIVACY_CHALLENGE, PRIVACY_RESPONSE, PRIVACY_BLOCK
- Cache: CACHE_REQUEST, CACHE_RESPONSE, CACHE_CHALLENGE, CACHE_BLOCK
- Per-peer ledgers: bytes sent/received, debt ratio < 10 serving threshold
- Max pending requests: 1024

### Security Model

- **No CID reversal**: `H(H(H(x)))` cannot be reversed to find `x` or `H(x)`
- **Ownership verification**: Owner signs `H(H(file))` without revealing `H(file)`
- **End-to-end encryption**: ECIES key exchange + AES-256 block encryption
- **Traffic analysis resistance**: Decoy requests indistinguishable from real requests on the wire
- **Zero-knowledge caching**: Cache nodes store encrypted blobs, never learn CID1

## License

ISC
