//! The window.
//!
//! Three panes, as Apple Notes has them: folders, the notes in the selected
//! folder, and the note itself. Every call to the daemon is a tailnet round
//! trip to a Mac that may be asleep, so nothing blocks the main loop: work goes
//! to a thread and comes back through a channel the GTK loop is already
//! polling.

use crate::client::{Client, Error, Folder, Note};
use crate::{markdown, render};
use adw::prelude::*;
use gtk::glib;
use std::cell::RefCell;
use std::rc::Rc;

pub fn build(app: &adw::Application) {
    let window = adw::ApplicationWindow::builder()
        .application(app)
        .title("anotes")
        .default_width(1100)
        .default_height(720)
        .build();

    let client = match Client::from_env() {
        Ok(c) => c,
        Err(why) => {
            window.set_content(Some(&fatal_page(&why)));
            window.present();
            return;
        }
    };

    let state = Rc::new(State {
        client,
        folder: RefCell::new(String::new()),
        open: RefCell::new(None),
        allow_shared: RefCell::new(false),
    });

    let panes = Panes::new();
    window.set_content(Some(&panes.root));
    window.present();

    panes.wire(&state);
    load_folders(&state, &panes);
    load_notes(&state, &panes);
}

struct State {
    client: Client,
    /// UUID of the selected folder; empty means every folder.
    folder: RefCell<String>,
    /// The note currently in the editor, as last loaded from the daemon.
    open: RefCell<Option<Note>>,
    /// Set when the user has explicitly taken responsibility for editing a
    /// note owned by someone else. Per-note, and cleared whenever another is
    /// opened: agreeing once must not quietly apply to the next one.
    allow_shared: RefCell<bool>,
}

struct Panes {
    root: adw::NavigationSplitView,
    folders: gtk::ListBox,
    notes: gtk::ListBox,
    notes_page: adw::NavigationPage,
    body: gtk::TextView,
    body_page: adw::NavigationPage,
    stack: gtk::Stack,
    new_note: gtk::Button,
    banner: adw::Banner,
    save: gtk::Button,
    toast: adw::ToastOverlay,
    search: gtk::SearchEntry,
}

impl Panes {
    fn new() -> Rc<Self> {
        // --- folders
        let folders = gtk::ListBox::new();
        folders.add_css_class("navigation-sidebar");
        let folders_page = page("Folders", &scrolled(&folders), None);

        // --- notes in the selected folder
        let notes = gtk::ListBox::new();
        notes.add_css_class("navigation-sidebar");
        let search = gtk::SearchEntry::builder()
            .placeholder_text("Search all notes")
            .margin_start(6)
            .margin_end(6)
            .margin_top(6)
            .margin_bottom(6)
            .build();
        let notes_box = gtk::Box::new(gtk::Orientation::Vertical, 0);
        notes_box.append(&search);
        notes_box.append(&scrolled(&notes));
        let notes_page = page("Notes", &notes_box, None);

        // --- the note
        let body = gtk::TextView::builder()
            .wrap_mode(gtk::WrapMode::Word)
            .left_margin(24)
            .right_margin(24)
            .top_margin(18)
            .bottom_margin(18)
            .monospace(false)
            .build();
        render::install_tags(&body.buffer());
        let banner = adw::Banner::new("");
        let save = gtk::Button::builder().label("Save").build();
        save.add_css_class("suggested-action");
        save.set_sensitive(false);

        let new_note = gtk::Button::from_icon_name("document-new-symbolic");
        new_note.set_tooltip_text(Some("New note"));
        let header = adw::HeaderBar::new();
        header.pack_start(&new_note);
        header.pack_end(&save);
        // Until a note is chosen the pane shows why it is empty, rather than
        // a blank editor that looks like a note with nothing in it.
        let empty = adw::StatusPage::builder()
            .icon_name("document-edit-symbolic")
            .title("No note selected")
            .description("Choose a note, or press the + button to write one.")
            .build();
        let stack = gtk::Stack::new();
        stack.add_named(&empty, Some("empty"));
        stack.add_named(&scrolled(&body), Some("note"));
        stack.set_visible_child_name("empty");

        let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
        content.append(&banner);
        content.append(&stack);
        let toast = adw::ToastOverlay::new();
        toast.set_child(Some(&content));

        let view = adw::ToolbarView::new();
        view.add_top_bar(&header);
        view.set_content(Some(&toast));
        let body_page = adw::NavigationPage::builder()
            .title("anotes")
            .child(&view)
            .build();

        // Apple Notes' three columns: nesting one split view in another is how
        // libadwaita gets a third pane that still collapses on a narrow window.
        let inner = adw::NavigationSplitView::builder()
            .sidebar(&notes_page)
            .content(&body_page)
            .min_sidebar_width(240.0)
            .build();
        let inner_page = adw::NavigationPage::builder()
            .title("Notes")
            .child(&inner)
            .build();
        let root = adw::NavigationSplitView::builder()
            .sidebar(&folders_page)
            .content(&inner_page)
            .min_sidebar_width(180.0)
            .max_sidebar_width(260.0)
            .build();

        Rc::new(Self {
            root,
            folders,
            notes,
            notes_page,
            body,
            body_page,
            stack,
            new_note,
            banner,
            save,
            toast,
            search,
        })
    }

    fn wire(self: &Rc<Self>, state: &Rc<State>) {
        // Selecting a folder reloads the list beside it.
        {
            let (s, p) = (state.clone(), self.clone());
            self.folders.connect_row_selected(move |_, row| {
                let Some(row) = row else { return };
                let uuid = unsafe { row.data::<String>("uuid") };
                let uuid = uuid.map(|u| unsafe { u.as_ref().clone() }).unwrap_or_default();
                *s.folder.borrow_mut() = uuid;
                p.search.set_text("");
                load_notes(&s, &p);
            });
        }

        // Selecting a note fetches its body: the list response carries titles
        // only, because fetching every body to draw a list would mean decoding
        // the whole library on every click.
        {
            let (s, p) = (state.clone(), self.clone());
            self.notes.connect_row_selected(move |_, row| {
                let Some(row) = row else { return };
                let uuid = unsafe { row.data::<String>("uuid") };
                let Some(uuid) = uuid.map(|u| unsafe { u.as_ref().clone() }) else { return };
                open_note(&s, &p, uuid);
            });
        }

        // Typing in the search box searches every note, not just this folder's
        // titles -- the phrase someone remembers is usually in the body.
        {
            let (s, p) = (state.clone(), self.clone());
            self.search.connect_search_changed(move |entry| {
                let q = entry.text().to_string();
                if q.trim().is_empty() {
                    load_notes(&s, &p);
                    return;
                }
                let (st, pp) = (s.clone(), p.clone());
                let client = s.client.clone();
                spawn(
                    move || client.search(&q, ""),
                    move |res| match res {
                        Ok(hits) => {
                            let notes: Vec<Note> = hits.into_iter().map(|h| h.note).collect();
                            fill_notes(&st, &pp, notes);
                        }
                        Err(e) => pp.toast(&format!("Search failed: {e}")),
                    },
                );
            });
        }

        // The Save button is enabled by editing, so an untouched note cannot be
        // rewritten by accident -- a rewrite is lossy and there is no undo.
        {
            let p = self.clone();
            self.body.buffer().connect_changed(move |_| {
                if p.body.is_editable() {
                    p.save.set_sensitive(true);
                }
            });
        }
        {
            let (s, p) = (state.clone(), self.clone());
            self.save.connect_clicked(move |_| save_note(&s, &p));
        }

        // Taking responsibility for a note owned by someone else. It says what
        // is being agreed to, because "Edit anyway" on its own does not: the
        // change leaves this machine.
        {
            let (s, p) = (state.clone(), self.clone());
            self.banner.connect_button_clicked(move |_| {
                *s.allow_shared.borrow_mut() = true;
                p.body.set_editable(true);
                p.banner.set_title("Editing a note you do not own — saving syncs it to them");
                p.banner.set_button_label(None);
                p.body.grab_focus();
            });
        }

        // A new note starts in the folder that is selected, which is where
        // someone looking at that folder means to put it.
        {
            let (s, p) = (state.clone(), self.clone());
            self.new_note.connect_clicked(move |_| {
                let client = s.client.clone();
                let folder = s.folder.borrow().clone();
                let (st, pp) = (s.clone(), p.clone());
                spawn(
                    move || client.create(&folder, "New note\n"),
                    move |res| match res {
                        Ok(resp) if !resp.uuid.is_empty() => {
                            open_note(&st, &pp, resp.uuid);
                            load_notes(&st, &pp);
                        }
                        Ok(_) => {
                            // Created, but Notes.app has not written it to the
                            // database yet, so there is no UUID to open.
                            pp.toast("Created. It will appear in the list shortly.");
                        }
                        Err(e) => pp.toast(&format!("Could not create the note: {e}")),
                    },
                );
            });
        }

        // Ctrl+S, because every editor has it.
        {
            let (s, p) = (state.clone(), self.clone());
            let key = gtk::EventControllerKey::new();
            key.connect_key_pressed(move |_, keyval, _, modifier| {
                if modifier.contains(gtk::gdk::ModifierType::CONTROL_MASK)
                    && keyval == gtk::gdk::Key::s
                {
                    if p.save.is_sensitive() {
                        save_note(&s, &p);
                    }
                    return glib::Propagation::Stop;
                }
                glib::Propagation::Proceed
            });
            self.root.add_controller(key);
        }
    }

    fn toast(&self, message: &str) {
        self.toast.add_toast(adw::Toast::new(message));
    }
}

fn open_note(state: &Rc<State>, panes: &Rc<Panes>, uuid: String) {
    let client = state.client.clone();
    let (s, p) = (state.clone(), panes.clone());
    spawn(
        move || client.note(&uuid),
        move |res| match res {
            Ok(note) => show_note(&s, &p, note),
            Err(e) => p.toast(&format!("Could not open the note: {e}")),
        },
    );
}

fn show_note(state: &Rc<State>, panes: &Rc<Panes>, note: Note) {
    panes.stack.set_visible_child_name("note");
    render::apply(&panes.body.buffer(), &markdown::parse_doc(&note.markdown));
    panes.body_page.set_title(if note.title.is_empty() { "Untitled" } else { &note.title });

    // A note carrying attachments or checklists cannot survive a rewrite, and
    // the daemon will refuse to save it. Saying so up front and making the note
    // read-only is honest; letting someone type into it and fail at save is
    // not.
    let editable =
        note.destroys.is_empty() && note.body_error.is_empty() && !note.shared_with_me;
    panes.body.set_editable(editable);
    if note.shared_with_me {
        // One short line. An AdwBanner is a strip with a button, not a
        // paragraph: a sentence here wraps around the button slot and reads as
        // broken. The owner is a CloudKit record id rather than a name, so
        // there is nothing more useful to say anyway.
        panes.banner.set_title("Owned by someone else — read-only");
        panes.banner.set_button_label(Some("Edit anyway"));
        panes.banner.set_revealed(true);
    } else if !note.body_error.is_empty() {
        panes.banner.set_button_label(None);
        panes.banner.set_title(&format!("This note could not be read: {}", note.body_error));
        panes.banner.set_revealed(true);
    } else if !note.destroys.is_empty() {
        panes.banner.set_button_label(None);
        panes.banner.set_title(&format!(
            "Read-only here: saving would remove {}. Edit it in Notes.app.",
            note.destroys.join(", ")
        ));
        panes.banner.set_revealed(true);
    } else if !note.degrades.is_empty() {
        panes.banner.set_button_label(None);
        panes.banner.set_title(&format!(
            "Saving will flatten {} — no text is lost.",
            note.degrades.join(", ")
        ));
        panes.banner.set_revealed(true);
    } else {
        panes.banner.set_button_label(None);
        panes.banner.set_revealed(false);
    }

    // Opening a note clears any agreement made about the previous one.
    *state.allow_shared.borrow_mut() = false;
    panes.save.set_sensitive(false);
    *state.open.borrow_mut() = Some(note);
}

fn save_note(state: &Rc<State>, panes: &Rc<Panes>) {
    let Some(note) = state.open.borrow().clone() else { return };
    // Rebuilt from the buffer's styling rather than read off as plain text:
    // what is shown has had its markers consumed, so saving the visible
    // characters would strip every heading and list in the note.
    let text = render::to_markdown(&panes.body.buffer());
    if text.trim().is_empty() {
        panes.toast("Refusing to empty the note.");
        return;
    }

    panes.save.set_sensitive(false);
    let client = state.client.clone();
    let uuid = note.uuid.clone();
    let allow_shared = *state.allow_shared.borrow();
    let (s, p) = (state.clone(), panes.clone());
    spawn(
        move || client.replace(&uuid, &text, false, allow_shared),
        move |res| match res {
            Ok(resp) => {
                if resp.degraded.is_empty() {
                    p.toast("Saved.");
                } else {
                    p.toast(&format!("Saved; flattened {}.", resp.degraded.join(", ")));
                }
                // Notes.app writes its database on its own schedule, so the
                // list is not refetched here: it would show the old title for
                // up to a minute and look like the save was lost.
                let _ = &s;
            }
            Err(Error::Refused { message, destroys }) => {
                p.toast(&format!("Not saved — would remove {}: {message}", destroys.join(", ")));
                p.save.set_sensitive(true);
            }
            Err(e) => {
                p.toast(&format!("Not saved: {e}"));
                p.save.set_sensitive(true);
            }
        },
    );
}

fn load_folders(state: &Rc<State>, panes: &Rc<Panes>) {
    let client = state.client.clone();
    let p = panes.clone();
    spawn(
        move || client.folders(),
        move |res| match res {
            Ok(folders) => fill_folders(&p, folders),
            Err(e) => p.toast(&format!("Could not list folders: {e}")),
        },
    );
}

fn fill_folders(panes: &Rc<Panes>, folders: Vec<Folder>) {
    while let Some(child) = panes.folders.first_child() {
        panes.folders.remove(&child);
    }
    panes.folders.append(&folder_row("All Notes", ""));
    for f in folders.into_iter().filter(|f| !f.trash) {
        let uuid = f.uuid.clone();
        panes.folders.append(&folder_row(&f.name, &uuid));
    }
    if let Some(first) = panes.folders.row_at_index(0) {
        panes.folders.select_row(Some(&first));
    }
}

fn load_notes(state: &Rc<State>, panes: &Rc<Panes>) {
    let client = state.client.clone();
    let folder = state.folder.borrow().clone();
    let (s, p) = (state.clone(), panes.clone());
    spawn(
        move || client.notes(&folder, false),
        move |res| match res {
            Ok(notes) => fill_notes(&s, &p, notes),
            Err(e) => p.toast(&format!("Could not list notes: {e}")),
        },
    );
}

fn fill_notes(_state: &Rc<State>, panes: &Rc<Panes>, notes: Vec<Note>) {
    while let Some(child) = panes.notes.first_child() {
        panes.notes.remove(&child);
    }
    panes.notes_page.set_title(&format!("Notes ({})", notes.len()));
    let empty = notes.is_empty();
    for n in notes {
        panes.notes.append(&note_row(&n));
    }
    // Open the first note, as Apple Notes does: a window that starts on an
    // empty pane makes the user click once before it has shown them anything.
    if let Some(first) = panes.notes.row_at_index(0) {
        panes.notes.select_row(Some(&first));
    }
    if empty {
        panes.stack.set_visible_child_name("empty");
    }
}

// --- small widget helpers

fn folder_row(name: &str, uuid: &str) -> gtk::ListBoxRow {
    let label = gtk::Label::builder()
        .label(name)
        .xalign(0.0)
        .margin_start(12)
        .margin_end(12)
        .margin_top(8)
        .margin_bottom(8)
        .build();
    let row = gtk::ListBoxRow::builder().child(&label).build();
    unsafe { row.set_data("uuid", uuid.to_string()) };
    row
}

fn note_row(note: &Note) -> gtk::ListBoxRow {
    let title = if note.title.trim().is_empty() { "Untitled" } else { note.title.trim() };
    let name = gtk::Label::builder().label(title).xalign(0.0).ellipsize(gtk::pango::EllipsizeMode::End).build();
    name.add_css_class("heading");
    let sub = gtk::Label::builder()
        .label(note.modified.split('T').next().unwrap_or(""))
        .xalign(0.0)
        .build();
    sub.add_css_class("dim-label");
    sub.add_css_class("caption");

    let b = gtk::Box::new(gtk::Orientation::Vertical, 2);
    b.set_margin_start(12);
    b.set_margin_end(12);
    b.set_margin_top(8);
    b.set_margin_bottom(8);
    b.append(&name);
    b.append(&sub);
    // A note owned by someone else is read-only, so it is marked in the list
    // rather than only once it is opened.
    if let Some(tag) = badge(note) {
        let l = gtk::Label::builder().label(tag).xalign(0.0).build();
        l.add_css_class("caption");
        l.add_css_class("dim-label");
        b.append(&l);
    }

    let row = gtk::ListBoxRow::builder().child(&b).build();
    unsafe { row.set_data("uuid", note.uuid.clone()) };
    row
}

/// badge names the one thing about a note worth showing beside its title.
fn badge(note: &Note) -> Option<&'static str> {
    if note.locked {
        return Some("Locked");
    }
    if note.shared_with_me {
        return Some("Shared with you — read-only");
    }
    if note.shared {
        return Some("Shared");
    }
    None
}

fn scrolled(child: &impl IsA<gtk::Widget>) -> gtk::ScrolledWindow {
    gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vexpand(true)
        .child(child)
        .build()
}

fn page(title: &str, child: &impl IsA<gtk::Widget>, header: Option<&adw::HeaderBar>) -> adw::NavigationPage {
    let view = adw::ToolbarView::new();
    match header {
        Some(h) => view.add_top_bar(h),
        None => view.add_top_bar(&adw::HeaderBar::new()),
    }
    view.set_content(Some(child));
    adw::NavigationPage::builder().title(title).child(&view).build()
}

fn fatal_page(why: &str) -> adw::ToolbarView {
    let status = adw::StatusPage::builder()
        .icon_name("network-offline-symbolic")
        .title("anotes cannot reach your notes")
        .description(why)
        .build();
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(&status));
    view
}

/// Runs a blocking job off the main thread and delivers the result back on it.
/// GTK is not thread safe, so the result must cross a channel rather than be
/// touched where it was produced.
fn spawn<T, F, D>(job: F, done: D)
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
    D: FnOnce(T) + 'static,
{
    let (tx, rx) = async_channel::bounded(1);
    std::thread::spawn(move || {
        let _ = tx.send_blocking(job());
    });
    glib::spawn_future_local(async move {
        if let Ok(v) = rx.recv().await {
            done(v);
        }
    });
}
