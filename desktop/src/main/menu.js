/**
 * @file CaptureDesk application menu — minimal, branded, standard edit roles
 * so clipboard shortcuts keep working inside renderer inputs.
 */
const { app, Menu, shell, dialog } = require('electron');
const windows = require('./windows');
const library = require('./library');
const recorder = require('./recorder');
const store = require('./store');

/**
 * Build and apply the application menu.
 */
function install() {
  const template = [
    {
      label: 'CaptureDesk',
      submenu: [
        {
          label: 'About CaptureDesk',
          click: () => {
            const win = windows.dashboard();
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About CaptureDesk',
              message: 'CaptureDesk Desktop',
              detail: 'Version 1.0.0\n\nProfessional local screen recording, editing, and export.\n100% on-device — recordings never leave your machine.\n\nMIT License · CaptureDesk Project',
              buttons: ['OK'],
            });
          },
        },
        { type: 'separator' },
        {
          label: 'CaptureDesk Settings',
          accelerator: 'CommandOrControl+,',
          click: () => windows.dashboard(),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Quit CaptureDesk' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Recording',
          accelerator: 'CommandOrControl+N',
          click: () => {
            const snap = recorder.snapshot();
            if (snap.state === recorder.STATE.IDLE) {
              recorder.start({ mode: 'screen', options: store.read() });
            }
          },
        },
        {
          label: 'Open CaptureDesk Recordings',
          accelerator: 'CommandOrControl+O',
          click: () => shell.openPath(library.currentDir()),
        },
      ],
    },
    { role: 'editMenu', label: 'Edit' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu', label: 'Window' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { install };
