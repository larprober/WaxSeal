'use strict';
/* The only bridge between the window and the disk. */

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (arg) => ipcRenderer.invoke(channel, arg || {});

contextBridge.exposeInMainWorld('waxseal', {
  info: call('app:info'),

  shelf: {
    list: call('shelf:list'),
    reveal: call('shelf:reveal'),
    chooseFolder: call('shelf:chooseFolder'),
    addExisting: call('shelf:addExisting'),
  },

  note: {
    create: call('note:create'),
    unlock: call('note:unlock'),
    peek: call('note:peek'),
    log: call('note:log'),
    save: call('note:save'),
    rename: call('note:rename'),
    changePassword: call('note:changePassword'),
    remove: call('note:delete'),
    lock: call('note:lock'),
    touch: call('note:touch'),
    shot: call('note:shot'),
  },

  onSessionExpired: (fn) => {
    ipcRenderer.on('session:expired', (_e, id) => fn(id));
  },
});
