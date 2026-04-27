'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;
let controllerProcess = null;

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    title: 'IPFS Privacy Desktop',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // In development, open DevTools
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('IPFS Privacy Desktop');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
}

// ─── IPC: Controller bridge ───────────────────────────────────────────────────

// Forward controller status updates to the renderer
function forwardToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// Lazy-load controller so Electron can start even if deps are not yet installed
let controller = null;
function getController() {
  if (!controller) {
    try {
      controller = require('./controller/controller.cjs');
    } catch (e) {
      return null;
    }
  }
  return controller;
}

ipcMain.handle('controller:start', async () => {
  const ctrl = getController();
  if (!ctrl) return { ok: false, error: 'Controller module not found. Run npm install first.' };
  try {
    await ctrl.start((event, data) => forwardToRenderer(event, data));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('controller:stop', async () => {
  const ctrl = getController();
  if (!ctrl) return { ok: false };
  await ctrl.stop();
  return { ok: true };
});

ipcMain.handle('controller:status', async () => {
  const ctrl = getController();
  if (!ctrl) return { running: false };
  return ctrl.getStatus();
});

// File add
ipcMain.handle('ipfs:add', async (_event, filePath) => {
  const ctrl = getController();
  if (!ctrl) return { ok: false, error: 'Controller not loaded' };
  return ctrl.addFile(filePath);
});

// File get
ipcMain.handle('ipfs:get', async (_event, cid1) => {
  const ctrl = getController();
  if (!ctrl) return { ok: false, error: 'Controller not loaded' };
  return ctrl.getFile(cid1);
});

// Open file dialog
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Open save dialog
ipcMain.handle('dialog:saveFile', async (_event, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'output',
  });
  return result.canceled ? null : result.filePath;
});

// Peer list
ipcMain.handle('peers:list', async () => {
  const ctrl = getController();
  if (!ctrl) return [];
  return ctrl.getPeers();
});

// Connect to peer
ipcMain.handle('peers:connect', async (_event, ip, port) => {
  const ctrl = getController();
  if (!ctrl) return { ok: false, error: 'Controller not loaded' };
  return ctrl.connectToPeer(ip, port);
});

// Disconnect peer
ipcMain.handle('peers:disconnect', async (_event, peerId) => {
  const ctrl = getController();
  if (!ctrl) return { ok: false, error: 'Controller not loaded' };
  return ctrl.disconnectPeer(peerId);
});

// Get config
ipcMain.handle('config:get', async () => {
  const ctrl = getController();
  if (!ctrl) return {};
  return ctrl.getConfig();
});

// Cache operations
ipcMain.handle('cache:store', async (_event, cid3, peerId) => {
  const ctrl = getController();
  if (!ctrl) return { ok: false, error: 'Controller not loaded' };
  return ctrl.cacheFromPeer(cid3, peerId);
});

ipcMain.handle('cache:list', async () => {
  const ctrl = getController();
  if (!ctrl) return [];
  return ctrl.getCachedItems();
});

ipcMain.handle('cache:remove', async (_event, cid3) => {
  const ctrl = getController();
  if (!ctrl) return { ok: false, error: 'Controller not loaded' };
  return ctrl.removeCached(cid3);
});

// Decoy operations
ipcMain.handle('decoys:set', async (_event, enabled) => {
  const ctrl = getController();
  if (ctrl) ctrl.setDecoysEnabled(enabled);
});

ipcMain.handle('decoys:send', async () => {
  const ctrl = getController();
  if (!ctrl) return { ok: false, error: 'Controller not loaded' };
  return ctrl.sendDecoy();
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms (don't quit)
  // On macOS, app.quit() would be called here normally, but we want tray behavior
});

app.on('before-quit', async () => {
  const ctrl = getController();
  if (ctrl) await ctrl.stop();
});
