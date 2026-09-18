import { contextBridge, ipcRenderer } from "electron";

/**
 * The only surface the window gets.
 *
 * The daemon token lives in main and is never exposed here: a renderer that
 * could read it could leak it to anything a note links to.
 */
contextBridge.exposeInMainWorld("anotes", {
  palette: () => ipcRenderer.invoke("palette"),
  onPalette: (fn: (p: unknown) => void) =>
    ipcRenderer.on("palette", (_e, p) => fn(p)),
  folders: () => ipcRenderer.invoke("folders"),
  notes: (folder: string) => ipcRenderer.invoke("notes", folder),
  note: (uuid: string) => ipcRenderer.invoke("note", uuid),
  search: (query: string) => ipcRenderer.invoke("search", query),
  save: (uuid: string, markdown: string, allowShared: boolean) =>
    ipcRenderer.invoke("save", uuid, markdown, allowShared),
  create: (folder: string, markdown: string) => ipcRenderer.invoke("create", folder, markdown),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  close: () => ipcRenderer.invoke("close"),
});
