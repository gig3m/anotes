import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView, Decoration, ViewPlugin, keymap, drawSelection, dropCursor,
  highlightActiveLine, WidgetType, type DecorationSet,
} from "@codemirror/view";
import { syntaxTree, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { tags } from "@lezer/highlight";

/**
 * The editor.
 *
 * One surface, and the document is always Markdown -- the same text the daemon
 * sent. Nothing is converted to a rendered DOM and converted back, which is
 * what every previous attempt here did and what made editing risky: a renderer
 * needs a writer, and a writer is a second parser with its own bugs.
 *
 * This is Obsidian's Live Preview arrangement, and Obsidian builds it the same
 * way: CodeMirror decorates the source in place. Syntax markers are dimmed, and
 * hidden entirely unless the cursor is on their line, so a heading reads as a
 * heading until you go to edit it and the "##" comes back.
 */

/** Markers to conceal when the cursor is elsewhere, by node name. */
const MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark",
]);

/**
 * A link's destination is markup too.
 *
 * Concealing only the brackets left "[17 Time Periods](https://www.google.com/
 * search?q=…)" showing its entire query string -- four wrapped lines of it for
 * one link, where iCloud shows the label alone. Only inside a Link: a bare URL
 * in the text is the text, and hiding that would delete what the note says.
 */
function isLinkDestination(view: EditorView, name: string, from: number): boolean {
  if (name !== "URL") return false;
  // The destination is the URL that follows "](", not merely any URL inside a
  // link. In "[https://x](https://x)" -- which is how a bare link in a note
  // comes across, label and destination the same -- matching on the parent
  // concealed both, and the line lost its address entirely.
  return view.state.doc.sliceString(from - 1, from) === "(";
}

const hidden = Decoration.replace({});
const dim = Decoration.mark({ class: "cm-formatting" });

/**
 * Shows a character reference as the character it stands for.
 *
 * The daemon writes indentation as &#160; -- deliberately, because a plain
 * space collapses on the way back into HTML and the indent would be lost. Every
 * Markdown reader decodes it; this one showed "&#160;&#160;&#160;&#160;" at the
 * start of every indented line, which in a note of meeting notes is most of
 * them.
 *
 * The source keeps the reference, so what is saved is what the daemon sent.
 */
class EntityWidget extends WidgetType {
  constructor(readonly ch: string) {
    super();
  }
  eq(other: EntityWidget) {
    return other.ch === this.ch;
  }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.ch;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

/** Decodes the references Notes' Markdown actually contains. */
function entityChar(text: string): string | null {
  const numeric = /^&#(\d+);$/.exec(text);
  if (numeric?.[1]) return String.fromCodePoint(Number(numeric[1]));
  const hex = /^&#[xX]([0-9a-fA-F]+);$/.exec(text);
  if (hex?.[1]) return String.fromCodePoint(parseInt(hex[1], 16));
  const named: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
    "&nbsp;": "\u00a0",
  };
  return named[text] ?? null;
}

/**
 * Conceal the syntax on lines the cursor is not on.
 *
 * Per line rather than per node: moving into a word should reveal that line's
 * markup, not just the one marker under the caret, or the text shifts as the
 * caret crosses it.
 */
const liveMarkers = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: { view: EditorView; docChanged: boolean; selectionSet: boolean; viewportChanged: boolean }) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const active = new Set<number>();
      for (const r of view.state.selection.ranges) {
        active.add(view.state.doc.lineAt(r.head).number);
        active.add(view.state.doc.lineAt(r.anchor).number);
      }
      const marks: Array<{ from: number; to: number; deco: Decoration }> = [];
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter: (node) => {
            const line = view.state.doc.lineAt(node.from).number;
            const deco = active.has(line) ? dim : hidden;

            // A backslash escape is markup for the character after it, so only
            // the backslash is concealed. The daemon escapes anything that
            // would otherwise read as syntax, which in a note full of
            // "*-*-*____*____*" is most of the line -- shown raw it is a wall
            // of backslashes where every other client shows the text.
            // A character reference is shown as its character, on every line:
            // unlike a delimiter there is nothing to reveal for editing, and
            // seeing "&#160;" where a space belongs is never useful.
            if (node.name === "Entity") {
              const ch = entityChar(view.state.doc.sliceString(node.from, node.to));
              if (ch !== null) {
                marks.push({
                  from: node.from,
                  to: node.to,
                  deco: Decoration.replace({ widget: new EntityWidget(ch) }),
                });
              }
              return;
            }
            if (node.name === "Escape") {
              marks.push({ from: node.from, to: node.from + 1, deco });
              return;
            }
            // A backslash inside a URL. The daemon escapes punctuation in link
            // text, and an autolinked bare URL swallows the escape into the URL
            // node rather than leaving an Escape node -- so "youtu.be/x\_y"
            // displayed its backslash, in the middle of an address.
            if (node.name === "URL") {
              const text = view.state.doc.sliceString(node.from, node.to);
              for (let k = 0; k < text.length - 1; k++) {
                if (text[k] === "\\" && /[!-\/:-@\[-`{-~]/.test(text[k + 1]!)) {
                  marks.push({ from: node.from + k, to: node.from + k + 1, deco });
                }
              }
            }
            if (MARKS.has(node.name) || isLinkDestination(view, node.name, node.from)) {
              marks.push({ from: node.from, to: node.to, deco });
            }
          },
        });
      }
      marks.sort((a, b) => a.from - b.from);
      return Decoration.set(marks.map((m) => m.deco.range(m.from, m.to)));
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Colour by role, from the Omarchy palette.
 *
 * Heading levels take the terminal colours, which is what Omarchy's own
 * Obsidian theme does -- h1 red, h2 green, h3 yellow, h4 blue -- so a note
 * looks the same here as it does there.
 */
const highlight = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-h1" },
  { tag: tags.heading2, class: "cm-h2" },
  { tag: tags.heading3, class: "cm-h3" },
  { tag: tags.heading4, class: "cm-h4" },
  { tag: tags.heading5, class: "cm-h5" },
  { tag: tags.heading6, class: "cm-h6" },
  { tag: tags.strong, class: "cm-strong" },
  { tag: tags.emphasis, class: "cm-em" },
  { tag: tags.strikethrough, class: "cm-strike" },
  { tag: tags.monospace, class: "cm-code" },
  { tag: tags.link, class: "cm-link" },
  { tag: tags.url, class: "cm-url" },
  { tag: tags.list, class: "cm-list" },
  { tag: tags.quote, class: "cm-quote" },
]);

export interface EditorHost {
  onChange(): void;
  onSave(): void;
}

export function createEditor(parent: HTMLElement, host: EditorHost): {
  view: EditorView;
  setDoc(text: string): void;
  getDoc(): string;
  setReadOnly(on: boolean): void;
  focus(): void;
  selectFirstLine(): void;
} {
  const readOnlyCompartment: Extension = EditorState.readOnly.of(false);

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        keymap.of([
          { key: "Mod-s", run: () => (host.onSave(), true) },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // Indented code blocks are removed. Four leading spaces mean a code
        // block in Markdown, and in a note they mean an indented paragraph --
        // Notes indents freely, so half of a note of meeting notes came out
        // rendered as source code. Nothing in these notes is code except a
        // fenced block, which is unaffected.
        markdown({ base: markdownLanguage, extensions: [{ remove: ["IndentedCode"] }] }),
        // The caret and the active line, explicitly. CodeMirror draws neither
        // by default, and without them there is no way to tell where you are --
        // which matters more here than in a code editor, because the
        // concealment means the line under the cursor is the one showing its
        // syntax.
        drawSelection(),
        dropCursor(),
        highlightActiveLine(),
        syntaxHighlighting(highlight),
        liveMarkers,
        EditorView.lineWrapping,
        readOnlyCompartment,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) host.onChange();
        }),
      ],
    }),
  });

  return {
    view,
    setDoc(text: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
      });
    },
    getDoc: () => view.state.doc.toString(),
    focus: () => view.focus(),
    // A new note opens with its placeholder title selected, so the first thing
    // typed replaces it rather than landing beside it.
    selectFirstLine() {
      const line = view.state.doc.line(1);
      view.dispatch({ selection: { anchor: line.from, head: line.to } });
      view.focus();
    },
    setReadOnly(on: boolean) {
      view.contentDOM.setAttribute("contenteditable", String(!on));
      view.dom.classList.toggle("is-readonly", on);
    },
  };
}
