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
