import { app, BrowserWindow, ipcMain, Tray, Menu } from 'electron';
import path from 'path';
import started from 'electron-squirrel-startup';
import * as VLC from 'vlc-client';
import Store from 'electron-store';
import DiscordRPC from '@xhayper/discord-rpc';
import { clientId, discordConnectRetryMS, VLCConnectRetryMS, presenceUpdateIntervalMS } from '../config.json';
import FormData from 'form-data';
import axios from 'axios';
import fs from 'fs';
import url from 'url';

const store = new Store();
let vlc;
let rpc;
let tray;
let mainWindow;
let enabled = true;
let connectRPCTimeout;
let connectVLCTimeout;
let presenceUpdate;
let pausedShowProgress = true;
let showAlbumArt = true;
let localAlbumArt;
let albumArt;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 560,
    height: 430,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.resizable = true;
    mainWindow.maximizable = true;
    mainWindow.minimizable = true;
  } else {
    mainWindow.setMenu(null);
  }

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      mainWindow.setSkipTaskbar(true);
    }
  });

  return mainWindow;
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  if ((await store.get('enabled')) != null) enabled = await store.get('enabled');
  if ((await store.get('pausedShowProgress')) != null) pausedShowProgress = await store.get('pausedShowProgress');
  if (!(await store.get('connection-config'))) createWindow();

  tray = new Tray(path.join(__dirname, 'images', 'icon.png'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        type: 'checkbox',
        label: 'Enabled',
        click: () => {
          enabled = !enabled;
          store.set('enabled', enabled);
        },
        checked: enabled,
      },
      {
        type: 'checkbox',
        label: 'Show progress while paused',
        click: () => {
          pausedShowProgress = !pausedShowProgress;
          store.set('pausedShowProgress', pausedShowProgress);
        },
        checked: pausedShowProgress,
      },
      {
        type: 'checkbox',
        label: 'Show album art (x0.at)',
        click: () => {
          showAlbumArt = !showAlbumArt;
          store.set('showAlbumArt', showAlbumArt);
        },
        checked: showAlbumArt,
      },
      {
        label: 'Config',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.setSkipTaskbar(false);
          } else {
            createWindow();
          }
        },
      },
      {
        label: 'Restart',
        click: () => {
          app.quit();
          app.relaunch();
        },
      },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.setToolTip('vlc rpc');

  if (await store.get('connection-config')) startPresenceUpdater();
});

const connectVLC = async () => {
  return new Promise((resolve) => {
    connectVLCTimeout = null;
    const config = store.get('connection-config');
    if (!config) return;
    vlc = new VLC.Client(config);

    try {
      vlc.meta();
      resolve();
    } catch (error) {
      console.error(`Failed to connect to VLC. Attempting to reconnect in ${VLCConnectRetryMS / 1000} seconds`);
      console.error(error);
      if (!connectVLCTimeout) connectVLCTimeout = setTimeout(connectVLC, VLCConnectRetryMS, resolve);
    }
  });
};

const disconnectRPC = async () => {
  if (rpc) {
    console.log('Disconnecting from Discord');
    clearTimeout(connectRPCTimeout);
    const rpcc = rpc;
    rpc = null;
    rpcc.transport.removeAllListeners('close');
    await rpcc.user?.clearActivity().catch(() => null);
    await rpcc.destroy().catch(() => null);
  }
};

const connectRPC = () => {
  return new Promise((resolve) => {
    connectRPCTimeout = null;
    if (rpc) return;

    if (!vlc) return;

    rpc = new DiscordRPC.Client({ transport: 'ipc', clientId });

    rpc.once('ready', () => {
      resolve();
    });

    rpc.transport.once('close', () => {
      disconnectRPC();

      if (!connectRPCTimeout) {
        connectRPCTimeout = setTimeout(connectRPC, discordConnectRetryMS);
      }
    });

    rpc.transport.once('open', () => {
      console.log('Connected to Discord');
    });

    rpc.login().catch((e) => {
      console.error(`Failed to connect to Discord. Attempting to reconnect in ${discordConnectRetryMS / 1000} seconds`);
      console.error(e);
      rpc = null;
      if (connectRPCTimeout) clearTimeout(connectRPCTimeout);
      connectRPCTimeout = setTimeout(connectRPC, discordConnectRetryMS, resolve);
    });
  });
};

const startPresenceUpdater = async () => {
  if (!vlc) await connectVLC();
  if (!rpc) await connectRPC();
  if (!rpc || !vlc) return setTimeout(startPresenceUpdater, VLCConnectRetryMS);

  setPresence();
  presenceUpdate = setInterval(setPresence, presenceUpdateIntervalMS);
};

const setPresence = async () => {
  if (!enabled) return await rpc.user?.clearActivity();
  if (!vlc) {
    console.log('VLC not connected');
    await rpc.user?.clearActivity();
    return;
  }
  if (!rpc) return console.log('RPC not connected');

  let status;
  let meta;

  try {
    status = await vlc.status();
    meta = await vlc.meta();
  } catch (error) {
    console.error(error);
    await rpc.user?.clearActivity();
    return;
  }

  const currentEpochSeconds = new Date().getTime() / 1000;
  const startTimestamp = Math.round(currentEpochSeconds - status.time);
  const endTimestamp = Math.round(currentEpochSeconds + status.length - status.time);

  const defaultProperties = {
    largeImageKey: 'vlc',
    largeImageText: 'VLC Media Player',
    smallImageKey: status.state == 'paused' ? 'pause' : 'play',
    smallImageText: status.state == 'paused' ? 'Paused' : 'Playing',
    instance: false,

    endTimestamp: 1,
  };

  if (status.state != 'paused' || pausedShowProgress) {
    defaultProperties.startTimestamp = startTimestamp;
    defaultProperties.endTimestamp = endTimestamp;
  }

  if (status.state == 'stopped') {
    await rpc.user?.setActivity({
      largeImageKey: 'vlc',
      largeImageText: 'VLC Media Player',
      instance: false,
      type: 3,
      details: 'Idling',
    });
  } else {
    if (showAlbumArt && meta.artwork_url && meta.artwork_url != localAlbumArt) {
      localAlbumArt = meta.artwork_url;
      console.log('uploading artwork');
      const form = new FormData();

      form.append('file', fs.createReadStream(url.fileURLToPath(meta.artwork_url)));

      try {
        const response = await axios.post('https://x0.at/', form, {
          headers: { ...form.getHeaders() },
        });

        albumArt = response.data;
      } catch (error) {
        console.error(error);
      }
    }
    if (!showAlbumArt || !meta.artwork_url) albumArt = null;

    await rpc.user?.setActivity({
      ...defaultProperties,
      type: status.stats.decodedvideo === 0 ? 2 : 3, // 2 = listening, 3 = watching
      largeImageKey: albumArt ? albumArt : 'vlc',
      details: meta.title || meta.showName || meta.filename || 'Unknown',
      state:
        meta.artist ||
        (meta.seasonNumber || meta.episodeNumber
          ? `${meta.showName ? meta.showName : ''}${meta.seasonNumber ? `S${meta.seasonNumber}` : ''}${meta.episodeNumber ? `E${meta.episodeNumber}` : ''}`
          : meta.subtitle) ||
        meta.description ||
        (status.stats.decodedvideo === 0 ? 'Unknown Artist' : undefined),
    });
  }
};

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('save-config', async (_, data) => {
  try {
    await axios.head(`http://${data.ip}:${data.port}`);
  } catch (_) {
    return 'Connection error, is the VLC HTTP server running?';
  }

  try {
    const vlc = new VLC.Client(data);
    await vlc.meta();
    store.set('connection-config', {
      ip: data.ip,
      port: data.port,
      username: data.username,
      password: data.password,
    });
    return 'connected';
  } catch (error) {
    return error;
  }
});

ipcMain.handle('load-config', async () => {
  return store.get('connection-config');
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
