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

## Editing

One surface, and it always holds Markdown -- the same text the daemon sent.
Nothing is converted to a rendered document and converted back.

That is Obsidian's Live Preview arrangement, built the way Obsidian builds it:
CodeMirror decorates the source in place. Syntax markers are dimmed on the line
the cursor is on and hidden everywhere else, so a heading reads as a heading
until you go to edit it and the `##` comes back. Heading levels take the
terminal colours, matching Omarchy's own Obsidian theme.

Saving happens on a pause in typing, on switching notes, and on closing the
window. An unchanged buffer is never sent: a rewrite costs formatting the daemon
reports, whether or not anything changed.

### Why there is no Markdown round trip here any more

Earlier versions of this app rendered notes to a document and rebuilt Markdown
from it on save. That needs a writer as well as a parser, and the writer is a
second implementation with its own bugs -- it had five, found by round-tripping
a real library. Keeping the buffer as Markdown removes the reason that code
existed, so it is gone rather than kept for reassurance. The escaping rules it
encoded live where they belong, in the daemon.

## License

MIT
