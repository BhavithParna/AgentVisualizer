// Desktop shell: runs the local server inside the app and shows it in a window.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { start } = require('./server');

let win;
async function createWindow() {
  const { url } = await start({ open: false });
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1560, height: 980, minWidth: 1040, minHeight: 700,
    title: 'Agent Visualizer', backgroundColor: '#d3d1cc', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } } : {}),
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (mac) win.webContents.on('did-finish-load', () => win.webContents.insertCSS(
    // no native title bar on macOS: make the top strip draggable and keep the controls clickable
    'body::before{content:"";position:fixed;top:0;left:0;right:0;height:30px;-webkit-app-region:drag;z-index:40}' +
    '#notch,#tr,button{-webkit-app-region:no-drag}#head{top:52px}'));
  win.loadURL(url);
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('activate', () => { if (!win) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
