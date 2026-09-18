# anotes

Apple Notes on the Omarchy desktop.

anotes is an [Omarchy](https://omarchy.org) shell plugin: a bar widget and panel
that reads, searches and edits the notes syncing to your iPhone. It talks to
[applenotes](https://github.com/gig3m/applenotes), a daemon running on a Mac
with SIP disabled, over your tailnet.

There is no iCloud API involved. The Mac is the bridge.

## Install

```sh
git clone https://github.com/gig3m/anotes ~/.config/omarchy/plugins/gig3m.anotes
omarchy-shell shell setPluginEnabled gig3m.anotes true
omarchy-shell shell putBarWidget gig3m.anotes '{"section":"right"}'
```

The daemon URL and token are plugin settings. Left blank, they are read from
`~/.config/applenotes/url` and `~/.config/applenotes/token` -- the same files
the `notes` CLI uses, so a machine set up for one needs nothing further.

## Notes you do not own

A note shared *with* you lives in the owner's iCloud account. Editing it syncs
the change to them and to everyone else on the share, so those notes open
read-only and are marked in the list. "Edit anyway" takes responsibility for one
note; the agreement clears when you open another.

## Rendering

Notes are drawn, not shown as Markdown: headings, bold, italic, strikethrough,
code, links, superscript, bullet and dash lists, numbering, nesting and
checklists.

Reading and editing are deliberately separate. Editing rendered text means
rebuilding Markdown from the view, and Qt's rich text would make that a second
parser -- one nothing has checked against a real library. `Markdown.js` has that
guarantee and a `TextDocument` round trip would not, so the rendered view is
read-only and exact, and editing hands back the same text the daemon sent,
unchanged unless you changed it.

## Tests

```sh
node tests/run.js                 # the round trip, on chosen cases
CORPUS=/path/to/notes node tests/run.js   # and on a real library
```

The corpus check round-trips every note in a directory of Markdown files. Run
against a real library it found five bugs the hand-written cases missed, so it
is the one worth keeping.

## License

MIT
