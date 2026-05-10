# Secure Data Exchange Protocol for IPFS

Electron desktop application implementing the **Secure Data Exchange Protocol** for IPFS — a privacy-preserving file sharing system with triple hashing, decoy requests, and encrypted caching. Based on the research paper *"Secure Data Exchange Protocol for IPFS"*.

## Table of Contents

- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [Windows Setup](#windows-setup)
  - [WSL Setup (for Docker testing)](#wsl-setup-for-docker-testing)
  - [Install the Application](#install-the-application)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Features](#features)
- [Docker Multi-Node Testing](#docker-multi-node-testing)
- [Architecture](#architecture)
- [Testing](#testing)
- [Usage Guide](#usage-guide)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Installation

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | 18+ | Runtime |
| **npm** | 9+ | Package manager |
| **Git** | 2.30+ | Version control |
| **Docker** | 20+ | Multi-node testing (optional) |
| **WSL 2** | Ubuntu 22.04+ | Docker on Windows (optional) |

### Windows Setup

1. **Install Node.js** (if not installed):
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
   Or download from https://nodejs.org

2. **Install Git** (if not installed):
   ```powershell
   winget install Git.Git
   ```

3. **Verify installations:**
   ```powershell
   node --version    # Should be 18+
   npm --version     # Should be 9+
   git --version
   ```

### WSL Setup (for Docker testing)

The Docker multi-node test environment requires WSL 2 with Docker. Skip this section if you only want to run the desktop app.

1. **Enable WSL 2** (run PowerShell as Administrator):
   ```powershell
   wsl --install
   ```
   Restart your computer if prompted.

2. **Install Ubuntu** (if not already present):
   ```powershell
   wsl --install -d Ubuntu-22.04
   ```

3. **Install Docker Desktop for Windows:**
   - Download from https://www.docker.com/products/docker-desktop/
   - During installation, enable **"Use WSL 2 based engine"**
   - After installation, open Docker Desktop > Settings > Resources > WSL Integration > Enable for your Ubuntu distro

4. **Verify Docker inside WSL:**
   ```bash
   wsl
   docker --version
   docker compose version
   ```

5. **Clone the repo inside WSL** (for Docker builds):
   ```bash
   # Inside WSL terminal
   cd ~
   git clone https://github.com/ncsn/Secure_Data_Exchange_Protocol_for_IPFS.git
   cd Secure_Data_Exchange_Protocol_for_IPFS
   ```

### Install the Application

**On Windows (for the desktop app):**
```powershell
git clone https://github.com/ncsn/Secure_Data_Exchange_Protocol_for_IPFS.git
cd Secure_Data_Exchange_Protocol_for_IPFS
npm install
```

**On WSL/Linux/macOS:**
```bash
git clone https://github.com/ncsn/Secure_Data_Exchange_Protocol_for_IPFS.git
cd Secure_Data_Exchange_Protocol_for_IPFS
npm install
```

---

## Quick Start

### Run the Desktop App

```bash
npm start
```

This launches the Electron app. Click **Start Node** in the sidebar to begin.

### Run the Docker Test Network (3 nodes)

```bash
cd docker
docker compose up --build
```

This starts Owner (port 4001), Cache (port 4002), and Requester (port 4003). The automated test verifies the full privacy protocol end-to-end.

---

## How It Works

Standard IPFS publishes content-addressed CIDs to a public DHT. Anyone observing the network can link requesters to specific files. This project breaks that link with **triple hashing**:

| CID | Derivation | Visibility | Purpose |
|-----|-----------|------------|---------|
| **CID1** | `H(file)` | Private (shared out-of-band) | Used by requester to retrieve file |
| **CID2** | `H(H(file))` | Secret (never leaves owner) | Ownership proof (signed challenge) |
| **CID3** | `H(H(H(file)))` | Public (published to DHT) | Network discovery — cannot be reversed to CID1 |

### The 5-Step Enhanced Privacy Protocol (with DH Key Exchange)

```
Requester (A)                     Owner (B)
    |                                 |
    |--- WANT_HAVE(CID3) ------------>|     Step 1: A searches by public CID
    |<-- sign(CID2) + DH_pubB ------->|     Step 2: B proves ownership + sends DH public key
    |--- ecies(CID1, B_pub) + DH_pubA>|     Step 3: A sends encrypted CID1 + DH public key
    |    K = HKDF(ECDH(A,B))          |     Both derive shared session key via ECDH
    |<-- aes_K(file) ---------------->|     Step 4: B sends encrypted file
    |                                 |
    verify H(decrypted) == CID1 digest
```

The session key `K` is now derived via **Elliptic Curve Diffie-Hellman** (ECDH on P-256) + HKDF-SHA256, providing forward secrecy — compromising a long-term key does not reveal past session keys.

### Decoy Requests

After each real retrieval, 1-3 decoy requests are automatically dispatched. They are cryptographically indistinguishable from genuine retrievals, making traffic analysis infeasible.

### Encrypted Caching

Cache nodes store and serve encrypted content without ever learning CID1. The inner encryption layer uses `H(CID1)` as the key — only the requester (who knows CID1) can decrypt.

---

## Features

### Desktop Application (10 Tabs)

- **Dashboard** — Peer ID, connections, storage, cached items, DHT peers. Privacy health score. Network topology graph.
- **Add File** — Drag-and-drop or file browser. Computes triple-hash CIDs and publishes CID3 to DHT.
- **Get File** — Enter CID1 to retrieve. Visual 4-step protocol stepper shows handshake progress.
- **Storage** — Browse all local blocks, pin/unpin management, garbage collection, disk usage.
- **Peers** — Connect by IP:port, per-peer bandwidth stats, disconnect individual peers.
- **Cache** — Cache encrypted objects from peers using CID3. Zero-knowledge caching.
- **DHT** — Kademlia routing table: k-buckets, provider records, CID registry, interactive lookup.
- **Event Log** — Real-time timestamped event stream.
- **Settings** — Listen port, announce IP, decoy toggle, bootstrap peers, download path.
- **Toast Notifications** — Slide-in alerts for connections, transfers, and errors.

### Privacy Properties

- **No CID reversal** — `H(H(H(x)))` cannot be reversed to find `x` or `H(x)`
- **Mutual authentication** — Owner signs CID2 (ECDSA), requester encrypts with owner's public key (ECIES)
- **End-to-end encryption** — ECIES key exchange + AES-256-GCM block encryption
- **Traffic analysis resistance** — Decoy requests indistinguishable from real requests on the wire
- **Zero-knowledge caching** — Cache nodes store encrypted blobs, never learn CID1
- **Forward secrecy** — ECDH ephemeral key exchange ensures each session key is independent; compromise of long-term keys cannot decrypt past sessions

### Cryptographic Primitives

| Operation | Primitive |
|-----------|-----------|
| Content hashing | SHA-256 (32-byte digest) |
| Identity keys | ECDSA on NIST P-256 |
| Digital signatures | ECDSA-SHA256 (DER-encoded) |
| Key exchange | ECDH on P-256 + HKDF-SHA256 (forward secrecy) |
| Asymmetric encryption | ECIES with HKDF-SHA256 + AES-256-GCM |
| Session encryption | AES-256-GCM (12-byte IV, 16-byte auth tag) |

---

## Docker Multi-Node Testing

The Docker setup creates a complete 3-node test network:

```bash
cd docker
docker compose up --build
```

| Service | Port | Role |
|---------|------|------|
| **owner** | 4001 | Adds a test file, publishes CID1+CID3 to DHT |
| **cache** | 4002 | Connects to owner, caches the file (encrypted) |
| **requester** | 4003 | Connects to cache, retrieves via privacy protocol |

Expected output: `PASS — Encrypted caching protocol works!`

### Connecting the Desktop App to Docker Nodes

1. Start Docker nodes: `docker compose up --build`
2. Start the desktop app: `npm start`
3. Go to **Peers** tab, connect to `127.0.0.1:4001` (owner), `127.0.0.1:4002` (cache), `127.0.0.1:4003` (requester)
4. Use the CID1 from the Docker owner's log to retrieve the file in the **Get File** tab

---

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
    └── libp2p/     — TCP transport + peer identification
```

### Project Structure

```
.
├── main.cjs                 — Electron main process + IPC handlers
├── preload.cjs              — Context bridge (window.ipfs API)
├── controller/
│   └── controller.cjs       — Bridge: main process ↔ core node
├── renderer/
│   ├── index.html           — Single-page app (10 tab sections)
│   ├── renderer.js          — UI logic, event handling, topology canvas
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
└── package.json
```

---

## Testing

### Unit and Integration Tests

```bash
node src/libp2p/libp2p.test.js         # Transport + crypto
node src/bitswap/bitswap.test.js        # Bitswap + privacy protocol + DH key exchange (20 tests)
node src/node/node.test.js              # End-to-end integration (14 tests)
node src/dht/dht.test.js                # DHT routing + provider lookup
node src/cid/cid.test.js                # CID + triple hash
node src/blockstore/blockstore.test.js  # Block storage + pinning
node src/unixfs/unixfs.test.js          # File chunking + directories
```

### Performance Benchmark

```bash
node src/node/perf.test.js    # 50-iteration benchmark (3 nodes, localhost)
```

Measures: TCP handshake, file add, privacy retrieval, decoy request, cache population, cache retrieval. Outputs a before/after comparison table (pre-ECDH vs post-ECDH migration).

### Docker Integration Test

```bash
cd docker
docker compose up --build    # Owner → Cache → Requester → PASS/FAIL
docker compose down
```

---

## Usage Guide

### Basic Workflow

1. Click **Start Node** in the sidebar
2. Add bootstrap peers in **Settings** (e.g. `127.0.0.1:4001` for Docker nodes)
3. Go to **Add File** — drop a file. Copy the CID1 shown.
4. Share CID1 privately with the recipient (out-of-band)
5. Recipient enters CID1 in **Get File** — watches the 4-step protocol complete
6. File is saved to the Downloads folder

### Key Rules

| CID | Use in... | Never use in... |
|-----|-----------|-----------------|
| **CID1** | Get File | Cache tab |
| **CID3** | Cache tab | Get File |
| **CID2** | Never shared | — |

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
```

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| "Cannot find module" on `npm start` | Missing dependencies | Run `npm install` |
| Docker: "nonce missing or truncated" | Old Docker image cached | `docker compose build --no-cache && docker compose up` |
| Get File: "No providers found" | Not connected to owner/cache | Connect to the peer first in Peers tab |
| Get File: "Failed to retrieve from all providers" | Wrong CID type | Use **CID1**, not CID2 or CID3 |
| Decoy timeout | No eligible targets in registry | Connect to peers who own content, wait for DHT sync |
| WSL: Docker commands not found | Docker Desktop WSL integration off | Docker Desktop > Settings > WSL Integration > Enable |

---

## Formal Verification

The protocol has been formally verified using **ProVerif** under the Dolev-Yao adversarial model, confirming:
- Mutual authentication between requester and owner
- Key secrecy (session keys are not leaked)
- Resistance to MITM and replay attacks

---
