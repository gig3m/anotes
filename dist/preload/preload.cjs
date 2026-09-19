"use strict";

// src/preload/preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("anotes", {
  wantedNote: () => import_electron.ipcRenderer.invoke("wanted-note"),
  palette: () => import_electron.ipcRenderer.invoke("palette"),
  onPalette: (fn) => import_electron.ipcRenderer.on("palette", (_e, p) => fn(p)),
  folders: () => import_electron.ipcRenderer.invoke("folders"),
  notes: (folder) => import_electron.ipcRenderer.invoke("notes", folder),
  note: (uuid) => import_electron.ipcRenderer.invoke("note", uuid),
  search: (query) => import_electron.ipcRenderer.invoke("search", query),
  save: (uuid, markdown, allowShared) => import_electron.ipcRenderer.invoke("save", uuid, markdown, allowShared),
  create: (folder, markdown) => import_electron.ipcRenderer.invoke("create", folder, markdown),
  openExternal: (url) => import_electron.ipcRenderer.invoke("open-external", url),
  close: () => import_electron.ipcRenderer.invoke("close")
});
