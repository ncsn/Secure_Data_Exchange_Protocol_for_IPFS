# IPFS Privacy Desktop

An Electron desktop app for a privacy-enhanced IPFS implementation using a triple-hash CID scheme, encrypted caching, and decoy traffic protection.

## Quick Start

```bash
npm install
npm start
```

The app opens with the sidebar on the left (navigation + node controls) and the main content area on the right. The node is **stopped** by default — click **Start Node** in the sidebar to begin.

## Understanding CID Types

This system uses three CID layers instead of one:

| CID | Derivation | Purpose | Who knows it |
|-----|-----------|---------|-------------|
| **CID1** | `H(file)` | Retrieve files (content address) | Owner + authorized recipients |
| **CID2** | `H(H(file))` | Ownership proof (never leaves your node) | Owner only |
| **CID3** | `H(H(H(file)))` | DHT lookup key, caching | Everyone (public) |

**Key rules:**
- **Get File** tab always uses **CID1**
- **Cache** tab always uses **CID3**
- **CID2** is never shown to you — the system uses it internally for ownership proofs

## Architecture

```
ipfs-desktop/
  main.cjs              Electron main process (window, tray, IPC handlers)
  preload.cjs           contextBridge IPC bridge (contextIsolation: true)
  renderer/
    index.html          UI (7 tabs: Dashboard, Add, Get, Peers, Cache, Log, Settings)
    renderer.js         Frontend logic
    styles.css          Dark theme
  src/
    controller/         Electron <-> Node bridge
    node/               Top-level Node API (add, get, connect, cache, decoy)
    bitswap/            Block exchange + 4-step privacy handshake + decoys
    dht/                Kademlia DHT (k=20, iterative lookup + store)
    libp2p/             TCP transport, ECDSA P-256, ECIES, AES-256-GCM
    cid/                SHA-256, multihash, CID, tripleHash()
    dag/                Merkle DAG, chunking
    blockstore/         Filesystem block store, pinning
    unixfs/             File/dir encoding
  docker/               Docker test environment (3-node setup)
  get-file.mjs          CLI tool for retrieving files from WSL/terminal
```

## Privacy Protocol

### 4-Step Retrieval Handshake

```
Requester (A)                     Owner (B)
    |                                 |
    |--- WANT_HAVE(CID3) ---------->|     Step 1: A searches by public CID
    |<-- PRIVACY_CHALLENGE(sig(CID2))|    Step 2: B proves ownership
    |--- PRIVACY_RESPONSE ---------->|     Step 3: A sends ecies(CID1 + K, B_pubkey)
    |<-- PRIVACY_BLOCK(aes_K(file)) -|    Step 4: B sends encrypted file
    |                                 |
    verify H(decrypted) == CID1 digest
```

### Encrypted Caching

```
Cache (C)                          Owner (B)
    |                                 |
    |--- WANT_HAVE(CID3) ---------->|
    |<-- PRIVACY_CHALLENGE(sig(CID2))|
    |--- CACHE_REQUEST(ecies(K+pub))->|
    |<-- CACHE_RESPONSE --------------|
    |    aes_K(aes(file, H(CID1)) + timestamp) + authorization
    |                                 |
    store encrypted blob (never learns CID1)
```

### Decoy Requests

Prevents traffic analysis by sending fake requests indistinguishable from real ones:
- Steps 1-2 are identical to a real handshake
- Step 3: sends `ecies(DECOY_FLAG)` instead of `ecies(CID1+K)` — encrypted, so observers can't tell
- Step 4: owner sends random bytes back
- After each real retrieval, 1-3 automatic decoys fire in the background

---

## WSL + Docker Setup

The project includes a Docker test environment with 3 nodes (owner, cache, requester) that runs in WSL2.

### Prerequisites

**Install WSL2 (one-time):**
```powershell
# In Windows PowerShell (admin)
wsl --install
```
Restart, then set up your Ubuntu user.

**Install Docker Engine in WSL (one-time):**
```bash
# Enter WSL
wsl

# Add Docker repo
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Start Docker
sudo service docker start

# Allow running without sudo
sudo usermod -aG docker $USER
# Log out and back in (or restart WSL: wsl --shutdown, then wsl)
```

### Running the Docker Test Environment

```bash
wsl
cd /mnt/c/Users/I741229/ipfs-desktop/docker
docker compose up --build
```

This starts 3 containers:

| Service | Role | Port | What it does |
|---------|------|------|-------------|
| `owner` | File owner | `localhost:4001` | Adds a test file, publishes CID1+CID3 to DHT |
| `cache` | Cache node | `localhost:4002` | Connects to owner, caches the file (encrypted) |
| `requester` | Requester | `localhost:4003` | Connects to cache, retrieves via cache protocol |

The automated test runs automatically — you'll see `PASS` or `FAIL` in the output. All three nodes stay alive afterwards for interactive testing from the Desktop app.

**Rebuild after code changes:**
```bash
docker compose up --build
```

**Stop everything:**
```bash
docker compose down
```

---

## CLI Tool — Retrieve Files from Terminal

The `get-file.mjs` script lets you retrieve files from WSL or any terminal without the Desktop app.

```bash
node get-file.mjs <CID1> <host> <port> [output-path]
```

**Example — retrieve from Docker owner:**
```bash
wsl
cd /mnt/c/Users/I741229/ipfs-desktop
node get-file.mjs bafkrei... localhost 4001
```

**Example — retrieve from Desktop app node:**
```bash
# Check the Desktop app Event Log for "Node started on port XXXXX"
node get-file.mjs bafkrei... localhost 54443
```

The script:
1. Creates a temporary node
2. Connects to the specified peer
3. Runs the full 4-step privacy handshake
4. Saves the file to `./retrieved-<cid>.bin` (or custom path)
5. Verifies integrity (H(data) == CID1)
6. Previews text content if applicable

**Note:** The port number changes each time the Desktop app restarts (because `listenPort: 0` picks a random port). Always check the Event Log for the current port.

---

## Testing Scenarios

### Scenario A: Single Node — Add and Retrieve Your Own File

1. Click **Start Node**
2. Go to **Add File** — drag-drop or browse a file
3. Click **Add to IPFS** — three CIDs appear. **Copy CID1.**
4. Go to **Get File** — paste **CID1**, click **Retrieve**
5. Expected: file saved to Downloads, verification OK

### Scenario B: Desktop App + Docker Owner — Privacy Handshake

1. Start Docker: `wsl` then `cd /mnt/c/Users/I741229/ipfs-desktop/docker && docker compose up --build`
2. In Desktop app: **Start Node**
3. **Peers** tab: connect to `127.0.0.1` port `4001`
4. Check docker logs for the Owner's CID1 (or use `get-file.mjs`)
5. **Get File** tab: paste CID1, click **Retrieve**
6. Watch the 4-step stepper animate through the handshake

### Scenario C: Desktop App + Docker — Cache a Remote File

1. Docker running (same as above)
2. Desktop app: **Start Node**, connect to `localhost:4001` (owner)
3. **Cache** tab: paste the owner's **CID3** (from Docker logs), select the peer, click **Cache**
4. Expected: "Cached successfully!" — your node now stores the encrypted blob

### Scenario D: Desktop App + Docker — Retrieve from Cache

1. Docker running, connect to `localhost:4002` (cache node)
2. The cache node already has the file cached from the owner
3. **Get File** tab: paste **CID1**, click **Retrieve**
4. The file is retrieved from the cache node (not the owner) via the cache protocol

### Scenario E: CLI Retrieval from WSL

```bash
wsl
cd /mnt/c/Users/I741229/ipfs-desktop

# Retrieve from Docker owner
node get-file.mjs bafkrei... localhost 4001

# Retrieve from Docker cache
node get-file.mjs bafkrei... localhost 4002

# Retrieve from Desktop app (check Event Log for port)
node get-file.mjs bafkrei... localhost <port>
```

### Scenario F: Decoy Requests

1. Start Docker, start Desktop app node, connect to `localhost:4001`
2. Wait a moment — the Docker owner's CID3 enters your registry via DHT
3. **Settings** tab: click **Send Decoy**
4. Check **Event Log**: "Decoy request sent and completed (response discarded)"
5. The decoy toggle (checked by default) also sends 1-3 automatic decoys after every real Get File

### Scenario G: Automated 3-Node Test (No Desktop App)

```bash
wsl
cd /mnt/c/Users/I741229/ipfs-desktop/docker
docker compose up --build
```

Watch the output — the requester automatically retrieves the file from the cache node and reports PASS/FAIL.

---

## Tab Reference

### Dashboard
Node status at a glance: Peer ID, connected peers, stored blocks, cached items, protocol version. Auto-refreshes every 5 seconds.

### Add File
Drag-drop or browse to add files. Shows CID1 (share with recipients), CID2 (never share), CID3 (public). Each has a Copy button.

### Get File
Enter **CID1** to retrieve a file. Shows a 4-step protocol stepper with real-time progress:
1. WANT_HAVE(CID3) sent
2. PRIVACY_CHALLENGE verified
3. PRIVACY_RESPONSE sent (encrypted CID1 + K)
4. PRIVACY_BLOCK received and verified

### Peers
Manage connections. Connect by IP+port, refresh list, **disconnect** individual peers. Source column: `transport` (direct TCP) or `dht` (routing table).

### Cache
Store encrypted copies of files from connected peers using **CID3**. Cached items table shows all stored objects with remove buttons. Your node never learns the original content.

### Event Log
Timestamped, color-coded log: blue (INFO), green (OK), yellow (WARN), red (ERROR). Click Clear to reset.

### Settings
| Setting | Description | Default |
|---------|-------------|---------|
| Listen Port | TCP port. 0 = auto-assign. | 0 |
| Announce IP | IP announced to DHT | 127.0.0.1 |
| Data Directory | Block storage path | (read-only) |
| Decoy Requests | Toggle automatic decoy traffic | On |
| Send Decoy | Manual decoy test button | — |
| Save Location | Downloaded files path | (read-only) |

---

## Common Mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Using CID3 in Get File | "Could not find this content" | Use **CID1** (the private CID) |
| Using CID1 in Cache tab | Cache fails | Use **CID3** (the public CID) |
| Caching your own file from remote peer | "Peer does not have block" | Cache files the *remote peer* owns |
| Wrong port for CLI retrieval | `ECONNREFUSED` | Check Event Log for current port |
| Decoy fails: "no eligible targets" | No remote CID3 in registry | Connect to a peer who owns content, wait for DHT sync |
| Docker: port conflict | `EADDRINUSE` | `docker compose down` first, then `up` |

## Test Scripts

| Script | Purpose |
|--------|---------|
| `get-file.mjs` | CLI file retrieval via privacy protocol |
| `docker/docker-compose.yml` | 3-node Docker test environment |
| `docker/docker-node.mjs` | Docker node entry script (owner/cache/requester roles) |
| `node src/bitswap/bitswap.test.js` | Bitswap unit tests (12 tests) |
| `node src/node/node.test.js` | Node integration tests (13 tests) |
| `node src/dht/dht.test.js` | DHT unit tests (13 tests) |
