import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * The live Omarchy palette.
 *
 * Omarchy renders the active theme to a colors.toml under
 * ~/.local/state/omarchy/current/theme and rewrites it on `omarchy theme set`.
 * Every themed thing on the desktop reads its own generated file from that
 * directory -- alacritty, btop, neovim, obsidian -- so reading it is how an app
 * follows the theme, rather than hoping a toolkit does it.
 */
export interface Palette {
  mode: "dark" | "light";
  background: string;
  darkBackground: string;
  darkerBackground: string;
  lighterBackground: string;
  foreground: string;
  darkForeground: string;
  brightForeground: string;
  muted: string;
  accent: string;
  selection: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
}

/** Used when Omarchy is not present or the file cannot be read. */
export const FALLBACK: Palette = {
  mode: "dark",
  background: "#0d1117",
  darkBackground: "#0a0d11",
  darkerBackground: "#07090c",
  lighterBackground: "#25292e",
  foreground: "#b1bac4",
  darkForeground: "#858c93",
  brightForeground: "#c5cbd3",
  muted: "#484f58",
  accent: "#58a6ff",
  selection: "#25292e",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
};

export function themeDir(): string {
  const base = process.env["XDG_STATE_HOME"] ?? path.join(os.homedir(), ".local/state");
  return path.join(base, "omarchy", "current", "theme");
}

/**
 * Parse the `key = "#value"` lines we need.
 *
 * Deliberately not a TOML parser: the file is flat scalars, and a dependency to
 * read sixteen hex strings would be the tail wagging the dog.
 */
function parseColors(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of source.split("\n")) {
    const m = /^\s*([a-z_0-9]+)\s*=\s*"([^"]*)"/i.exec(line);
    if (m?.[1] && m[2] !== undefined) out.set(m[1], m[2]);
  }
  return out;
}

export function readPalette(dir = themeDir()): Palette {
  let colors: Map<string, string>;
  try {
    colors = parseColors(readFileSync(path.join(dir, "colors.toml"), "utf8"));
  } catch {
    return FALLBACK;
  }
  const pick = (key: string, fallback: string): string => colors.get(key)?.trim() || fallback;
  return {
    // The theme states its own mode; inferring it from the background's
    // luminance gets the borderline ones wrong.
    mode: pick("mode", "dark") === "light" ? "light" : "dark",
    background: pick("background", FALLBACK.background),
    darkBackground: pick("dark_background", FALLBACK.darkBackground),
    darkerBackground: pick("darker_background", FALLBACK.darkerBackground),
    lighterBackground: pick("lighter_background", FALLBACK.lighterBackground),
    foreground: pick("foreground", FALLBACK.foreground),
    darkForeground: pick("dark_foreground", FALLBACK.darkForeground),
    brightForeground: pick("bright_foreground", FALLBACK.brightForeground),
    muted: pick("muted", FALLBACK.muted),
    accent: pick("accent", FALLBACK.accent),
    selection: pick("selection", FALLBACK.selection),
    red: pick("red", FALLBACK.red),
    green: pick("green", FALLBACK.green),
    yellow: pick("yellow", FALLBACK.yellow),
    blue: pick("blue", FALLBACK.blue),
    magenta: pick("magenta", FALLBACK.magenta),
    cyan: pick("cyan", FALLBACK.cyan),
  };
}

/** The palette as CSS custom properties, for the renderer to adopt wholesale. */
export function paletteVars(p: Palette): string {
  return Object.entries({
    "--background": p.background,
    "--dark-background": p.darkBackground,
    "--darker-background": p.darkerBackground,
    "--lighter-background": p.lighterBackground,
    "--foreground": p.foreground,
    "--dark-foreground": p.darkForeground,
    "--bright-foreground": p.brightForeground,
    "--muted": p.muted,
    "--accent": p.accent,
    "--selection": p.selection,
    "--red": p.red,
    "--green": p.green,
    "--yellow": p.yellow,
    "--blue": p.blue,
    "--magenta": p.magenta,
    "--cyan": p.cyan,
  })
    .map(([k, v]) => `${k}: ${v};`)
    .join("\n  ");
}
