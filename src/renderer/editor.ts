import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView, Decoration, ViewPlugin, keymap, drawSelection, dropCursor,
  highlightActiveLine, type DecorationSet,
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

const hidden = Decoration.replace({});
const dim = Decoration.mark({ class: "cm-formatting" });

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
            if (!MARKS.has(node.name)) return;
            const line = view.state.doc.lineAt(node.from).number;
            // A link's destination is markup too, but concealing it without
            // replacing it would leave the label pointing at nothing visible.
            marks.push({ from: node.from, to: node.to, deco: active.has(line) ? dim : hidden });
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
        markdown({ base: markdownLanguage }),
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
