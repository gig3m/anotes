# anotes

A GTK4 desktop client for Apple Notes, for Linux.

anotes talks to [applenotes](https://github.com/gig3m/applenotes), a daemon that
runs on a Mac with SIP disabled and exposes your notes over HTTP on a tailnet.
anotes is the desktop half: it reads, searches and edits those notes from a Linux
machine, in a window that behaves like a GNOME app because it is one.

It does not talk to iCloud, and there is no Apple API involved. The Mac is the
bridge, and the notes it serves are the ones syncing to your phone.

## Reanotesments

- An `applenotes` daemon reachable from this machine
- GTK 4.12+ and libadwaita 1.5+

## Running

anotes reads the same configuration the `notes` CLI uses, so a machine already
set up for one needs nothing further:

```sh
export NOTESD_URL=http://<mac-tailnet-ip>:8437
export NOTESD_TOKEN=...      # or put it in ~/.config/applenotes/token
anotes
```

## Building

```sh
cargo build --release
```

## What it will not do

Apple Notes stores more than Markdown can express. The daemon reports, per note,
what a rewrite would flatten and what it would destroy, and anotes honours both:

- A note carrying **attachments or checklists** opens read-only, with a banner
  saying why. Saving it would delete that content, so anotes does not offer to.
- A note whose formatting would merely be **flattened** — underlining,
  indentation — is editable, with a banner saying what saving costs. No text is
  lost.

Notes.app writes its own database on its own schedule, so a note you save here
may take up to a minute to appear changed in the list. That is Notes.app, not
anotes.

## License

MIT
