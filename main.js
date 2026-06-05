const { app, BrowserWindow } = require('electron');
const path = require('path');

require('./server');

function createWindow(){

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    autoHideMenuBar: true,
    backgroundColor: '#111111',
    webPreferences:{
      nodeIntegration:false
    }
  });

  win.loadURL('http://localhost:3000/dashboard.html');
}

app.whenReady().then(createWindow);