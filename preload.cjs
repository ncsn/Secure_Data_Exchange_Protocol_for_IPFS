'use strict';

/**
 * preload.js — IPC bridge between main process and renderer.
 * contextIsolation: true  →  window.ipfs is exposed via contextBridge.
 * No Node.js APIs leak into the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ipfs', {
  // ── Controller lifecycle ──────────────────────────────────────────────────
  startController: () => ipcRenderer.invoke('controller:start'),
  stopController:  () => ipcRenderer.invoke('controller:stop'),
  getStatus:       () => ipcRenderer.invoke('controller:status'),

  // ── File operations ───────────────────────────────────────────────────────
  addFile: (filePath) => ipcRenderer.invoke('ipfs:add', filePath),
  getFile: (cid1)    => ipcRenderer.invoke('ipfs:get', cid1),

  // ── Peer operations ──────────────────────────────────────────────────────
  getPeers:        ()          => ipcRenderer.invoke('peers:list'),
  connectToPeer:   (ip, port)  => ipcRenderer.invoke('peers:connect', ip, port),
  disconnectPeer:  (peerId)    => ipcRenderer.invoke('peers:disconnect', peerId),

  // ── Config ───────────────────────────────────────────────────────────────
  getConfig: () => ipcRenderer.invoke('config:get'),

  // ── Cache operations ──────────────────────────────────────────────────────
  cacheFromPeer:  (cid3, peerId) => ipcRenderer.invoke('cache:store', cid3, peerId),
  getCachedItems: ()             => ipcRenderer.invoke('cache:list'),
  removeCached:   (cid3)         => ipcRenderer.invoke('cache:remove', cid3),

  // ── Decoy operations ────────────────────────────────────────────────────
  setDecoysEnabled: (enabled) => ipcRenderer.invoke('decoys:set', enabled),
  sendDecoy:        ()        => ipcRenderer.invoke('decoys:send'),

  // ── DHT operations ─────────────────────────────────────────────────────
  getDHTStats:     ()    => ipcRenderer.invoke('dht:stats'),
  getDHTBuckets:   ()    => ipcRenderer.invoke('dht:buckets'),
  getDHTProviders: ()    => ipcRenderer.invoke('dht:providers'),
  dhtLookup:       (cid) => ipcRenderer.invoke('dht:lookup', cid),

  // ── Storage operations ────────────────────────────────────────────────
  getStorageStats: ()          => ipcRenderer.invoke('storage:stats'),
  getBlocks:       ()          => ipcRenderer.invoke('storage:blocks'),
  pinBlock:        (cid, type) => ipcRenderer.invoke('storage:pin', cid, type),
  unpinBlock:      (cid)       => ipcRenderer.invoke('storage:unpin', cid),
  deleteBlock:     (cid)       => ipcRenderer.invoke('storage:delete', cid),
  runGC:           ()          => ipcRenderer.invoke('storage:gc'),

  // ── Bandwidth & Privacy ───────────────────────────────────────────────
  getBandwidthStats: () => ipcRenderer.invoke('bandwidth:stats'),
  getPrivacyScore:   () => ipcRenderer.invoke('privacy:score'),

  // ── Bootstrap peers ───────────────────────────────────────────────────
  getBootstrapPeers:   ()        => ipcRenderer.invoke('bootstrap:list'),
  addBootstrapPeer:    (address) => ipcRenderer.invoke('bootstrap:add', address),
  removeBootstrapPeer: (address) => ipcRenderer.invoke('bootstrap:remove', address),

  // ── Native dialogs ────────────────────────────────────────────────────────
  openFileDialog: ()            => ipcRenderer.invoke('dialog:openFile'),
  saveFileDialog: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),

  // ── Event listeners (main → renderer push) ────────────────────────────────
  onControllerEvent: (callback) => {
    ipcRenderer.on('controller:event', (_e, data) => callback(data));
  },
  onPeerConnected: (callback) => {
    ipcRenderer.on('peer:connected', (_e, data) => callback(data));
  },
  onPeerDisconnected: (callback) => {
    ipcRenderer.on('peer:disconnected', (_e, data) => callback(data));
  },
  onTransferUpdate: (callback) => {
    ipcRenderer.on('transfer:update', (_e, data) => callback(data));
  },

  // ── Cleanup helpers ───────────────────────────────────────────────────────
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
