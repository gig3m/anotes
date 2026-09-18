// Puts anotes in the Omarchy menu.
//
// A .desktop file rather than a launcher script: the menu, the app switcher and
// the window rules all key off it, and Hyprland matches the window by
// StartupWMClass.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(os.homedir(), ".local/share/applications");
const entry = `[Desktop Entry]
Type=Application
Name=anotes
GenericName=Notes
Comment=Apple Notes on the desktop, over an applenotes daemon
Exec=sh -c 'cd ${root} && ELECTRON_OZONE_PLATFORM_HINT=auto electron43 src/main/main.ts'
Icon=accessories-text-editor
Terminal=false
Categories=Office;TextEditor;Utility;
StartupNotify=true
StartupWMClass=electron
`;
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "io.nrsil.anotes.desktop");
writeFileSync(file, entry);
console.log("installed " + file);
