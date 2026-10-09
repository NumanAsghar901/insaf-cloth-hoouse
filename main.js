const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
let win;
ipcMain.on('refocus', () => { if (win && !win.isDestroyed()) { win.blur(); win.focus(); win.webContents.focus(); } });
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
app.whenReady().then(async () => {
  process.env.POS_DATA_DIR = app.getPath('userData'); // shop.db lives here
  try {
    const server = require('./server');
    if (!server.listening) await new Promise((res, rej) => { server.once('listening', res); server.once('error', rej); });
  } catch (e) {
    dialog.showErrorBox('Garments POS', 'Could not start (is the POS already open, or port 3000 busy?)\n' + e.message);
    return app.quit();
  }
  win = new BrowserWindow({ width: 1280, height: 800, autoHideMenuBar: true, title: 'Insaf Cloth House', icon: path.join(__dirname, 'public', 'logo.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.maximize();
  win.loadURL('http://localhost:3000');
});
app.on('window-all-closed', () => app.quit());
