import { app, BrowserWindow, ipcMain, shell } from "electron";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Refused } from "../core/client.ts";
import { readPalette, themeDir } from "../core/theme.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");

const client = new Client();
let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    backgroundColor: readPalette().background,
    // Omarchy is keyboard-first with almost no chrome, and Hyprland draws the
    // border and title. A titlebar here would be a second one.
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, "dist", "preload", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(root, "src", "renderer", "index.html"));

  // Links belong in the browser, not in a note window with no address bar.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

/**
 * Re-read the palette when Omarchy switches theme.
 *
 * `omarchy theme set` rewrites the files under current/, so watching that
 * directory picks up every theme without this app knowing any of their names.
 * The directory is watched rather than the file because the theme switch
 * replaces files rather than rewriting them in place, and a watch on an
 * inode that gets replaced stops firing.
 */
function watchTheme(): void {
  try {
    watch(themeDir(), { persistent: false }, () => {
      win?.webContents.send("palette", readPalette());
    });
  } catch {
    // No Omarchy, or no theme yet: the fallback palette stands.
  }
}

function fail(e: unknown): { error: string; destroys?: string[] } {
  if (e instanceof Refused) return { error: e.message, destroys: e.destroys };
  return { error: e instanceof Error ? e.message : String(e) };
}

app.whenReady().then(() => {
  ipcMain.handle("palette", () => readPalette());
  ipcMain.handle("folders", async () => {
    try {
      return { ok: await client.folders() };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("notes", async (_e, folder: string) => {
    try {
      return { ok: await client.notes(folder) };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("note", async (_e, uuid: string) => {
    try {
      return { ok: await client.note(uuid) };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("search", async (_e, query: string) => {
    try {
      return { ok: await client.search(query) };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("save", async (_e, uuid: string, markdown: string, allowShared: boolean) => {
    try {
      return { ok: await client.replace(uuid, markdown, allowShared) };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("create", async (_e, folder: string, markdown: string) => {
    try {
      return { ok: await client.create(folder, markdown) };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle("open-external", (_e, url: string) => shell.openExternal(url));
  ipcMain.handle("close", () => win?.close());

  createWindow();
  watchTheme();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
