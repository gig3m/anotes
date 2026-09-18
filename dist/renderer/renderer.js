// src/core/markdown.js
function parseDoc(md) {
  const lines = [];
  let fenced = false;
  for (const raw of String(md).split("\n")) {
    const depth = depthOf(raw);
    const t = raw.slice(indentLen(raw, depth));
    const trimmed = t.replace(/^[ \t]+/, "");
    if (trimmed.startsWith("```")) {
      fenced = !fenced;
      lines.push({ block: "fence", depth, spans: [{ text: trimmed, style: {} }] });
      continue;
    }
    if (fenced) {
      lines.push({ block: "code", depth, spans: [{ text: t, style: { code: true } }] });
      continue;
    }
    const c = classify(t);
    lines.push({ block: c.block, number: c.number, depth, spans: inlineSpans(c.text) });
  }
  return lines;
}
function classify(t) {
  let m;
  if (m = /^[-*] \[ \] (.*)$/.exec(t)) return { block: "check", number: 0, text: m[1] };
  if (m = /^[-*] \[[xX]\] (.*)$/.exec(t)) return { block: "checkDone", number: 0, text: m[1] };
  if (m = /^### (.*)$/.exec(t)) return { block: "subhead", number: 0, text: m[1] };
  if (m = /^## (.*)$/.exec(t)) return { block: "heading", number: 0, text: m[1] };
  if (m = /^# (.*)$/.exec(t)) return { block: "title", number: 0, text: m[1] };
  if (m = /^\+ (.*)$/.exec(t)) return { block: "dash", number: 0, text: m[1] };
  if (m = /^[-*] (.*)$/.exec(t)) return { block: "bullet", number: 0, text: m[1] };
  if (m = /^(\d+)[.)] (.*)$/.exec(t)) return { block: "number", number: parseInt(m[1], 10), text: m[2] };
  return { block: "body", number: 0, text: t };
}
function depthOf(line) {
  let cols = 0;
  for (const ch of line) {
    if (ch === " ") cols += 1;
    else if (ch === "	") cols += 4;
    else break;
  }
  return Math.floor(cols / 4);
}
function indentLen(line, depth) {
  if (depth === 0) return 0;
  const want = depth * 4;
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === " ") cols += 1;
    else if (ch === "	") cols += 4;
    else return i;
    if (cols >= want) return i + 1;
  }
  return line.length;
}
function markerFor(block) {
  switch (block) {
    case "bullet":
      return "\u2022 ";
    case "dash":
      return "\u2013 ";
    case "check":
      return "\u2610 ";
    case "checkDone":
      return "\u2611 ";
    default:
      return "";
  }
}
function inlineSpans(s) {
  const out = [];
  collect(s, {}, out);
  return out.filter(function(x) {
    return x.text.length > 0;
  });
}
var OPENERS = [
  ["***", "***", function(st) {
    st.bold = true;
    st.italic = true;
  }],
  ["**", "**", function(st) {
    st.bold = true;
  }],
  ["~~", "~~", function(st) {
    st.strike = true;
  }],
  ["`", "`", function(st) {
    st.code = true;
  }],
  ["<sup>", "</sup>", function(st) {
    st.sup = true;
  }],
  ["<sub>", "</sub>", function(st) {
    st.sub = true;
  }],
  ["*", "*", function(st) {
    st.italic = true;
  }]
];
function collect(s, style, out) {
  let plain = "";
  let i = 0;
  function flush() {
    if (plain.length) {
      out.push({ text: plain, style: copyStyle(style) });
      plain = "";
    }
  }
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) {
      plain += s[i + 1];
      i += 2;
      continue;
    }
    const op = openerAt(s, i);
    if (op) {
      const end = findClose(s, i + op[0].length, op[1]);
      if (end >= 0) {
        flush();
        const inner = copyStyle(style);
        op[2](inner);
        if (inner.code && !style.code) {
          out.push({ text: s.slice(i + op[0].length, end), style: inner });
        } else {
          collect(s.slice(i + op[0].length, end), inner, out);
        }
        i = end + op[1].length;
        continue;
      }
    }
    if (s[i] === "[") {
      const link = splitLink(s.slice(i));
      if (link) {
        flush();
        const inner = copyStyle(style);
        inner.href = link.dest;
        collect(link.label, inner, out);
        i += link.len;
        continue;
      }
    }
    plain += s[i];
    i += 1;
  }
  flush();
}
function openerAt(s, i) {
  for (const op of OPENERS) if (s.startsWith(op[0], i)) return op;
  return null;
}
function findClose(s, from, close) {
  let i = from;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s.startsWith(close, i)) return i;
    i += 1;
  }
  return -1;
}
function splitLink(s) {
  const close = findClose(s, 1, "]");
  if (close < 0) return null;
  const rest = s.slice(close + 1);
  if (!rest.startsWith("(")) return null;
  const end = rest.indexOf(")");
  if (end < 0) return null;
  return { label: s.slice(1, close), dest: rest.slice(1, end), len: close + 1 + end + 1 };
}
function copyStyle(st) {
  return {
    bold: !!st.bold,
    italic: !!st.italic,
    strike: !!st.strike,
    code: !!st.code,
    sup: !!st.sup,
    sub: !!st.sub,
    href: st.href === void 0 ? void 0 : st.href
  };
}

// src/renderer/renderer.ts
var $ = (id) => document.getElementById(id);
var foldersEl = $("folders");
var listEl = $("list");
var bodyEl = $("body");
var sourceEl = $("source");
var bannerEl = $("banner");
var statusEl = $("status");
var searchEl = $("search");
var folder = "";
var notes = [];
var current = null;
var allowShared = false;
var editing = false;
var saved = "";
var saveTimer;
var saving = false;
function say(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}
function failed(r) {
  return "error" in r;
}
function applyPalette(p) {
  const map = {
    background: "--background",
    darkBackground: "--dark-background",
    darkerBackground: "--darker-background",
    lighterBackground: "--lighter-background",
    foreground: "--foreground",
    darkForeground: "--dark-foreground",
    brightForeground: "--bright-foreground",
    muted: "--muted",
    accent: "--accent",
    selection: "--selection",
    red: "--red",
    green: "--green",
    yellow: "--yellow"
  };
  for (const [key, cssVar] of Object.entries(map)) {
    if (p[key]) document.documentElement.style.setProperty(cssVar, p[key]);
  }
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function spanHtml(sp) {
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
function renderNote(md) {
  const lines = parseDoc(md);
  const tagFor = { title: "h1", heading: "h2", subhead: "h3" };
  bodyEl.innerHTML = lines.map((line) => {
    const inner = line.spans.map(spanHtml).join("") || "&nbsp;";
    const tag = tagFor[line.block] ?? "p";
    const indent = line.depth ? ` style="padding-left:${line.depth * 20}px"` : "";
    const marker = line.block === "number" ? `${line.number}. ` : markerFor(line.block);
    if (marker) {
      return `<div class="line"${indent}><span class="marker">${escapeHtml(marker)}</span><span class="text">${inner}</span></div>`;
    }
    if (line.block === "code" || line.block === "fence") {
      return `<div class="line"${indent}><code class="text">${inner}</code></div>`;
    }
    return `<${tag}${indent}>${inner}</${tag}>`;
  }).join("");
}
function showBanner() {
  const n = current;
  if (!n) {
    bannerEl.hidden = true;
    return;
  }
  let text = "";
  let action = null;
  if (n.bodyError) text = `Could not be read: ${n.bodyError}`;
  else if (n.sharedWithMe && !allowShared) {
    text = "Owned by someone else \u2014 read-only";
    action = "Edit anyway";
  } else if (n.sharedWithMe) text = "Editing a note you do not own \u2014 saving syncs it to them";
  else if (n.destroys?.length) text = `Read-only: saving would remove ${n.destroys.join(", ")}`;
  else if (n.degrades?.length) text = `Saving will flatten ${n.degrades.join(", ")} \u2014 no text is lost`;
  bannerEl.hidden = text === "";
  bannerEl.textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action;
    b.onclick = () => {
      allowShared = true;
      showBanner();
    };
    bannerEl.append(b);
  }
}
function readOnly() {
  const n = current;
  if (!n) return true;
  if (n.bodyError) return true;
  if (n.destroys?.length) return true;
  return n.sharedWithMe === true && !allowShared;
}
async function loadFolders() {
  const r = await anotes.folders();
  if (failed(r)) {
    say(r.error, true);
    return;
  }
  foldersEl.replaceChildren(
    ...[{ uuid: "", name: "All Notes" }, ...r.ok.filter((f) => !f.trash)].map((f) => {
      const b = document.createElement("button");
      b.textContent = f.name;
      b.setAttribute("aria-current", String(f.uuid === folder));
      b.onclick = () => {
        folder = f.uuid;
        searchEl.value = "";
        loadFolders();
        loadNotes();
      };
      return b;
    })
  );
}
async function loadNotes() {
  const r = await anotes.notes(folder);
  if (failed(r)) {
    say(r.error, true);
    return;
  }
  say("");
  notes = r.ok;
  drawList();
  const first = notes[0];
  if (first && !current) openNote(first.uuid);
}
function drawList() {
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
    })
  );
}
async function openNote(uuid) {
  if (editing) await save();
  const r = await anotes.note(uuid);
  if (failed(r)) {
    say(r.error, true);
    return;
  }
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
async function save() {
  clearTimeout(saveTimer);
  if (!current || readOnly() || saving) return;
  const md = editing ? sourceEl.value : current.markdown ?? "";
  if (md === saved) return;
  if (!md.trim()) {
    say("Refusing to empty the note.", true);
    return;
  }
  saving = true;
  say("Saving\u2026");
  const uuid = current.uuid;
  const r = await anotes.save(uuid, md, allowShared);
  saving = false;
  if (failed(r)) {
    say(r.destroys?.length ? `Not saved \u2014 would remove ${r.destroys.join(", ")}` : `Not saved: ${r.error}`, true);
    return;
  }
  saved = md;
  if (current?.uuid === uuid) current.markdown = md;
  say(r.ok.degraded?.length ? `Saved; flattened ${r.ok.degraded.join(", ")}` : "Saved.");
}
var SAVE_AFTER_TYPING = 1200;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_AFTER_TYPING);
}
searchEl.oninput = async () => {
  const q = searchEl.value.trim();
  if (!q) {
    loadNotes();
    return;
  }
  const r = await anotes.search(q);
  if (failed(r)) {
    say(r.error, true);
    return;
  }
  notes = r.ok;
  drawList();
};
sourceEl.oninput = () => {
  if (editing) scheduleSave();
};
async function stopEditing() {
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
  const link = e.target.closest("a");
  if (link) {
    e.preventDefault();
    anotes.openExternal(link.getAttribute("href") ?? "");
    return;
  }
  if (readOnly() || !current) return;
  editing = true;
  sourceEl.value = current.markdown ?? "";
  bodyEl.hidden = true;
  sourceEl.hidden = false;
  sourceEl.focus();
};
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "s") {
    e.preventDefault();
    save();
  }
  if (e.key === "Escape") {
    if (editing && current) {
      stopEditing();
    } else if (document.activeElement === searchEl) {
      searchEl.value = "";
      searchEl.blur();
      loadNotes();
    }
  }
  if (e.ctrlKey && e.key === "f") {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
  }
});
window.addEventListener("beforeunload", () => {
  if (editing) save();
});
anotes.onPalette(applyPalette);
anotes.palette().then(applyPalette);
loadFolders();
loadNotes();
