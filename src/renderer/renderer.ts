import { parseDoc, docMarkdown, markerFor } from "../core/markdown.js";

// The window. Everything that talks to the daemon goes through the preload
// bridge, so the token never reaches here.
declare const anotes: {
  palette(): Promise<Record<string, string>>;
  onPalette(fn: (p: Record<string, string>) => void): void;
  folders(): Promise<Result<Folder[]>>;
  notes(folder: string): Promise<Result<Note[]>>;
  note(uuid: string): Promise<Result<Note>>;
  search(query: string): Promise<Result<Note[]>>;
  save(uuid: string, markdown: string, allowShared: boolean): Promise<Result<{ degraded?: string[] }>>;
  create(folder: string, markdown: string): Promise<Result<{ uuid?: string }>>;
  openExternal(url: string): Promise<void>;
};

type Result<T> = { ok: T } | { error: string; destroys?: string[] };
interface Folder { uuid: string; name: string; trash?: boolean }
interface Note {
  uuid: string; title: string; folder: string; modified: string;
  locked?: boolean; shared?: boolean; sharedWithMe?: boolean;
  markdown?: string; degrades?: string[]; destroys?: string[]; bodyError?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const foldersEl = $("folders");
const listEl = $<HTMLUListElement>("list");
const bodyEl = $("body");
const sourceEl = $<HTMLTextAreaElement>("source");
const bannerEl = $("banner");
const statusEl = $("status");
const searchEl = $<HTMLInputElement>("search");

let folder = "";
let notes: Note[] = [];
let current: Note | null = null;
// Set when the user has taken responsibility for a note owned by someone else.
// Per note, and cleared whenever another opens: agreeing once must not quietly
// apply to the next one.
let allowShared = false;
let editing = false;
/** What the daemon last accepted, so an unchanged buffer is never rewritten. */
let saved = "";
let saveTimer: number | undefined;
let saving = false;

function say(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function failed<T>(r: Result<T>): r is { error: string; destroys?: string[] } {
  return "error" in r;
}

// ---- palette

function applyPalette(p: Record<string, string>): void {
  const map: Record<string, string> = {
    background: "--background", darkBackground: "--dark-background",
    darkerBackground: "--darker-background", lighterBackground: "--lighter-background",
    foreground: "--foreground", darkForeground: "--dark-foreground",
    brightForeground: "--bright-foreground", muted: "--muted", accent: "--accent",
    selection: "--selection", red: "--red", green: "--green", yellow: "--yellow",
  };
  for (const [key, cssVar] of Object.entries(map)) {
    if (p[key]) document.documentElement.style.setProperty(cssVar, p[key]!);
  }
}

// ---- rendering

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One span, with its styling. Read-only, so this never has to be parsed back. */
function spanHtml(sp: { text: string; style: Record<string, unknown> }): string {
  let t = escapeHtml(sp.text);
  const st = sp.style;
  if (st["code"]) t = `<code>${t}</code>`;
  if (st["sup"]) t = `<sup>${t}</sup>`;
  if (st["sub"]) t = `<sub>${t}</sub>`;
  if (st["strike"]) t = `<s>${t}</s>`;
  if (st["bold"]) t = `<b>${t}</b>`;
  if (st["italic"]) t = `<i>${t}</i>`;
  if (typeof st["href"] === "string") {
    t = `<a href="${escapeHtml(st["href"])}">${t}</a>`;
  }
  return t;
}

function renderNote(md: string): void {
  const lines = parseDoc(md) as Array<{
    block: string; depth: number; number?: number;
    spans: Array<{ text: string; style: Record<string, unknown> }>;
  }>;
  const tagFor: Record<string, string> = { title: "h1", heading: "h2", subhead: "h3" };
  bodyEl.innerHTML = lines
    .map((line) => {
      const inner = line.spans.map(spanHtml).join("") || "&nbsp;";
      const tag = tagFor[line.block] ?? "p";
      const indent = line.depth ? ` style="padding-left:${line.depth * 20}px"` : "";
      // The marker is drawn rather than left in the text, as Notes shows it: a
      // bullet, not "- ".
      const marker = line.block === "number" ? `${line.number}. ` : markerFor(line.block);
      if (marker) {
        return `<div class="line"${indent}><span class="marker">${escapeHtml(marker)}</span><span class="text">${inner}</span></div>`;
      }
      if (line.block === "code" || line.block === "fence") {
        return `<div class="line"${indent}><code class="text">${inner}</code></div>`;
      }
      return `<${tag}${indent}>${inner}</${tag}>`;
    })
    .join("");
}

// ---- banner

function showBanner(): void {
  const n = current;
  if (!n) { bannerEl.hidden = true; return; }
  let text = "";
  let action: string | null = null;
  if (n.bodyError) text = `Could not be read: ${n.bodyError}`;
  else if (n.sharedWithMe && !allowShared) { text = "Owned by someone else — read-only"; action = "Edit anyway"; }
  else if (n.sharedWithMe) text = "Editing a note you do not own — saving syncs it to them";
  else if (n.destroys?.length) text = `Read-only: saving would remove ${n.destroys.join(", ")}`;
  else if (n.degrades?.length) text = `Saving will flatten ${n.degrades.join(", ")} — no text is lost`;

  bannerEl.hidden = text === "";
  bannerEl.textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action;
    b.onclick = () => { allowShared = true; showBanner(); };
    bannerEl.append(b);
  }
}

function readOnly(): boolean {
  const n = current;
  if (!n) return true;
  if (n.bodyError) return true;
  if (n.destroys?.length) return true;
  return n.sharedWithMe === true && !allowShared;
}

// ---- data

async function loadFolders(): Promise<void> {
  const r = await anotes.folders();
  if (failed(r)) { say(r.error, true); return; }
  foldersEl.replaceChildren(
    ...[{ uuid: "", name: "All Notes" } as Folder, ...r.ok.filter((f) => !f.trash)].map((f) => {
      const b = document.createElement("button");
      b.textContent = f.name;
      b.setAttribute("aria-current", String(f.uuid === folder));
      b.onclick = () => { folder = f.uuid; searchEl.value = ""; loadFolders(); loadNotes(); };
      return b;
    }),
  );
}

async function loadNotes(): Promise<void> {
  const r = await anotes.notes(folder);
  if (failed(r)) { say(r.error, true); return; }
  say("");
  notes = r.ok;
  drawList();
  // Open the first note, as Notes does: a window that starts on an empty pane
  // makes the reader click once before it has shown them anything.
  const first = notes[0];
  if (first && !current) openNote(first.uuid);
}

function drawList(): void {
  listEl.replaceChildren(
    ...notes.map((n) => {
      const li = document.createElement("li");
      li.setAttribute("aria-selected", String(current?.uuid === n.uuid));
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = n.title.trim() || "Untitled";
      const meta = document.createElement("div");
      meta.className = "meta";
      const date = document.createElement("span");
      date.textContent = (n.modified || "").slice(0, 10);
      meta.append(date);
      // A note owned by someone else is read-only, so it is marked in the list
      // rather than only once it is opened.
      const tag = n.locked ? "locked" : n.sharedWithMe ? "theirs" : n.shared ? "shared" : "";
      if (tag) {
        const s = document.createElement("span");
        s.className = `tag ${tag}`;
        s.textContent = tag;
        meta.append(s);
      }
      li.append(title, meta);
      li.onclick = () => openNote(n.uuid);
      return li;
    }),
  );
}

async function openNote(uuid: string): Promise<void> {
  // Switching away is not a reason to lose what was typed.
  if (editing) await save();
  const r = await anotes.note(uuid);
  if (failed(r)) { say(r.error, true); return; }
  current = r.ok;
  saved = current.markdown ?? "";
  allowShared = false;
  editing = false;
  sourceEl.hidden = true;
  bodyEl.hidden = false;
  renderNote(current.markdown ?? "");
  showBanner();
  drawList();
}

/**
 * Save, if there is anything to save.
 *
 * A rewrite costs formatting the daemon reports, and Notes.app takes a minute
 * to persist, so an unchanged buffer is never sent: the comparison is against
 * what was last accepted, not against what is on screen.
 */
async function save(): Promise<void> {
  clearTimeout(saveTimer);
  if (!current || readOnly() || saving) return;
  const md = editing ? sourceEl.value : (current.markdown ?? "");
  if (md === saved) return;
  if (!md.trim()) { say("Refusing to empty the note.", true); return; }

  saving = true;
  say("Saving…");
  const uuid = current.uuid;
  const r = await anotes.save(uuid, md, allowShared);
  saving = false;
  if (failed(r)) {
    say(r.destroys?.length ? `Not saved — would remove ${r.destroys.join(", ")}` : `Not saved: ${r.error}`, true);
    return;
  }
  saved = md;
  if (current?.uuid === uuid) current.markdown = md;
  say(r.ok.degraded?.length ? `Saved; flattened ${r.ok.degraded.join(", ")}` : "Saved.");
}

/**
 * Save shortly after typing stops.
 *
 * Notes saves as you write and so does this, but not on every keystroke: each
 * save is an Apple Event on a Mac across a tailnet, and Notes.app buffers for
 * about a minute afterwards regardless. A pause is the signal.
 */
const SAVE_AFTER_TYPING = 1200;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_AFTER_TYPING) as unknown as number;
}

// ---- input

searchEl.oninput = async () => {
  const q = searchEl.value.trim();
  if (!q) { loadNotes(); return; }
  const r = await anotes.search(q);
  if (failed(r)) { say(r.error, true); return; }
  notes = r.ok;
  drawList();
};

sourceEl.oninput = () => { if (editing) scheduleSave(); };

/** Leave the editor, saving rather than pretending to. */
async function stopEditing(): Promise<void> {
  if (!editing) return;
  const md = sourceEl.value;
  await save();
  editing = false;
  if (current) current.markdown = md;
  renderNote(md);
  sourceEl.hidden = true;
  bodyEl.hidden = false;
}

bodyEl.onclick = (e) => {
  const link = (e.target as HTMLElement).closest("a");
  if (link) {
    e.preventDefault();
    anotes.openExternal(link.getAttribute("href") ?? "");
    return;
  }
  if (readOnly() || !current) return;
  // Editing is the source, which is what the daemon sent: see README.
  editing = true;
  sourceEl.value = current.markdown ?? "";
  bodyEl.hidden = true;
  sourceEl.hidden = false;
  sourceEl.focus();
};

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "s") { e.preventDefault(); save(); }
  if (e.key === "Escape") {
    if (editing && current) {
      // Previously this re-rendered the buffer and set it as the note's text
      // without sending it anywhere, so an edit looked committed and was lost
      // on close.
      stopEditing();
    } else if (document.activeElement === searchEl) {
      searchEl.value = "";
      searchEl.blur();
      loadNotes();
    }
  }
  if (e.ctrlKey && e.key === "f") { e.preventDefault(); searchEl.focus(); searchEl.select(); }
});

// A pending save must not be lost to a closing window. The handler is
// synchronous, so this can only flush what is already in flight -- which is why
// the debounce is short.
window.addEventListener("beforeunload", () => { if (editing) save(); });

anotes.onPalette(applyPalette);
anotes.palette().then(applyPalette);
loadFolders();
loadNotes();
