# anotes

Apple Notes on the Omarchy desktop.

anotes reads, searches and edits the notes syncing to your iPhone. It talks to
[applenotes](https://github.com/gig3m/applenotes), a daemon running on a Mac
with SIP disabled, over your tailnet. There is no iCloud API involved; the Mac
is the bridge.

Built for [Omarchy](https://omarchy.org): keyboard-first, almost no chrome,
mono, and themed from the live palette.

## Running

```sh
npm install
npm start
npm run install-desktop   # and it is in the menu
```

The daemon URL and token are read from `~/.config/applenotes/url` and
`~/.config/applenotes/token` -- the same files the `notes` CLI uses, so a
machine set up for one needs nothing further. `NOTESD_URL` and `NOTESD_TOKEN`
override them.

## Theming

Omarchy renders the active theme to `~/.local/state/omarchy/current/theme/` and
rewrites it on `omarchy theme set`. anotes reads `colors.toml` from there and
watches the directory, so it follows all twenty themes without knowing any of
their names -- the same way alacritty, btop, neovim and the rest are themed.

The visual language is Omarchy's own: mono everywhere in the chrome, squared
corners, borders that are always present rather than grown on focus, and the
shell's 12/11/10 type scale. Prose is the one exception, and prose only lives
inside the note.

## Notes you do not own

A note shared *with* you lives in the owner's iCloud account. Editing it syncs
the change to them and to everyone else on the share, so those notes open
read-only and are tagged in the list. "Edit anyway" takes responsibility for one
note; the agreement clears when you open another.

## Reading and editing

Notes are rendered: headings, bold, italic, strikethrough, code, links,
superscript, bullet and dash lists, numbering, nesting and checklists. Clicking
one opens its source.

The split is deliberate. Editing rendered text means rebuilding Markdown out of
the view, and doing that through a rich-text widget would be a second parser --
one nothing has checked against a real library. `src/core/markdown.js` has that
guarantee; the view does not. So the rendered pane is exact and read-only, and
editing hands back the text the daemon sent, unchanged unless you changed it.

## Tests

```sh
npm test
CORPUS=/path/to/markdown/notes npm test   # and against a real library
```

The corpus check round-trips every note in a directory. Run against a real
library it found five bugs the hand-written cases missed -- dropped backslash
escapes that would have turned body text into a numbered list, trimmed leading
whitespace, code spans parsed as markup, delimiters emitted per run instead of
per change, and discarded fence markers. It is the test worth keeping.

## License

MIT
