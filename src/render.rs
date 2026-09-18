//! The GTK half: draw a parsed note into a TextBuffer, and read it back.
//!
//! All the correctness lives in `markdown`, which is pure and tested against a
//! real library. This file only has to be a faithful carrier: what `apply`
//! draws, `read_back` must return. Everything beyond that -- the actual
//! Markdown -- is `markdown`'s problem.

use crate::markdown::{doc_markdown, BlockKind, Rendered, Span, Style};
use adw::prelude::*;
use gtk::prelude::*;
use gtk::{TextBuffer, TextIter, TextTag};

const BOLD: &str = "b";
const ITALIC: &str = "i";
const STRIKE: &str = "s";
const CODE: &str = "code";
const SUP: &str = "sup";
const SUB: &str = "sub";
const LINK: &str = "link";
/// Marks the glyph shown in place of a list marker, so read_back knows the
/// characters are decoration rather than the user's text.
const MARKER: &str = "marker";

fn block_tag(b: BlockKind) -> Option<&'static str> {
    match b {
        BlockKind::Title => Some("h1"),
        BlockKind::Heading => Some("h2"),
        BlockKind::Subhead => Some("h3"),
        BlockKind::Bullet => Some("li-bullet"),
        BlockKind::Dash => Some("li-dash"),
        BlockKind::Number(_) => Some("li-number"),
        BlockKind::Check(false) => Some("li-check"),
        BlockKind::Check(true) => Some("li-check-done"),
        BlockKind::Code => Some("pre"),
        BlockKind::Fence => Some("fence"),
        BlockKind::Body => None,
    }
}

/// install_tags defines every tag used. Sizes are relative and weights
/// semantic: Apple Notes stores almost nothing typographic -- measured at 98.8%
/// of runs carrying neither a font nor a point size -- so following the theme
/// is both easier and more faithful than reproducing a Mac's defaults.
pub fn install_tags(buffer: &TextBuffer) {
    let table = buffer.tag_table();
    let mut add = |t: TextTag| table.add(&t);

    add(TextTag::builder().name("h1").weight(700).scale(1.6)
        .pixels_above_lines(14).pixels_below_lines(6).build());
    add(TextTag::builder().name("h2").weight(700).scale(1.3)
        .pixels_above_lines(12).pixels_below_lines(4).build());
    add(TextTag::builder().name("h3").weight(700).scale(1.1)
        .pixels_above_lines(10).build());
    add(TextTag::builder().name(BOLD).weight(700).build());
    add(TextTag::builder().name(ITALIC).style(gtk::pango::Style::Italic).build());
    add(TextTag::builder().name(STRIKE).strikethrough(true).build());
    add(TextTag::builder().name(CODE).family("monospace").build());
    add(TextTag::builder().name("pre").family("monospace").build());
    add(TextTag::builder().name("fence").family("monospace").build());
    add(TextTag::builder().name(SUP).rise(6000).scale(0.7).build());
    add(TextTag::builder().name(SUB).rise(-3000).scale(0.7).build());
    // The accent belongs to whatever theme is loaded. A hardcoded blue sits
    // wrong on every palette that is not Adwaita's, and a link with no colour
    // at all is hard to pick out, so it is taken from the style manager and
    // followed when the theme changes.
    let link = TextTag::builder()
        .name(LINK)
        .underline(gtk::pango::Underline::Single)
        .build();
    let manager = adw::StyleManager::default();
    link.set_foreground_rgba(Some(&manager.accent_color_rgba()));
    {
        let link = link.clone();
        manager.connect_accent_color_notify(move |m| {
            link.set_foreground_rgba(Some(&m.accent_color_rgba()));
        });
    }
    add(link);
    add(TextTag::builder().name(MARKER).build());
    for n in ["li-bullet", "li-dash", "li-number", "li-check", "li-check-done"] {
        add(TextTag::builder().name(n).build());
    }
    for i in 1..=6 {
        add(TextTag::builder().name(&format!("indent-{i}"))
            .left_margin(28 * i).build());
    }
}

/// apply draws the parsed note.
pub fn apply(buffer: &TextBuffer, doc: &[Rendered]) {
    buffer.set_text("");
    for (i, line) in doc.iter().enumerate() {
        if i > 0 {
            insert(buffer, "\n", &[]);
        }
        let line_start = buffer.end_iter().offset();

        // The marker is inserted as real text, as Notes shows it, and tagged so
        // read_back can tell it from what the user typed.
        match line.block {
            BlockKind::Number(n) => insert(buffer, &format!("{n}. "), &[MARKER]),
            b => {
                if let Some(glyph) = b.marker() {
                    insert(buffer, glyph, &[MARKER]);
                }
            }
        }

        for sp in &line.spans {
            insert(buffer, &sp.text, &style_tags(&sp.style));
            if let Some(href) = &sp.style.href {
                tag_href(buffer, href, sp.text.chars().count());
            }
        }

        let start = buffer.iter_at_offset(line_start);
        let end = buffer.end_iter();
        if let Some(t) = block_tag(line.block) {
            buffer.apply_tag_by_name(t, &start, &end);
        }
        if line.depth > 0 {
            buffer.apply_tag_by_name(&format!("indent-{}", line.depth.min(6)), &start, &end);
        }
    }
}

fn style_tags(st: &Style) -> Vec<&'static str> {
    let mut v = Vec::new();
    if st.bold { v.push(BOLD) }
    if st.italic { v.push(ITALIC) }
    if st.strike { v.push(STRIKE) }
    if st.code { v.push(CODE) }
    if st.sup { v.push(SUP) }
    if st.sub { v.push(SUB) }
    if st.href.is_some() { v.push(LINK) }
    v
}

/// tag_href attaches the destination to the last `len` characters. The URL
/// rides on a tag rather than in the text, so the reader sees the label and the
/// writer can still rebuild "[label](url)".
fn tag_href(buffer: &TextBuffer, href: &str, len: usize) {
    let end = buffer.end_iter();
    let mut start = end;
    start.backward_chars(len as i32);
    let t = TextTag::builder().build();
    unsafe { t.set_data("href", href.to_string()) };
    buffer.tag_table().add(&t);
    buffer.apply_tag(&t, &start, &end);
}

fn insert(buffer: &TextBuffer, text: &str, tags: &[&str]) {
    let mut end = buffer.end_iter();
    let off = end.offset();
    buffer.insert(&mut end, text);
    if tags.is_empty() {
        return;
    }
    let start = buffer.iter_at_offset(off);
    let end = buffer.end_iter();
    for t in tags {
        buffer.apply_tag_by_name(t, &start, &end);
    }
}

/// to_markdown reads the buffer back and hands it to the pure writer.
pub fn to_markdown(buffer: &TextBuffer) -> String {
    doc_markdown(&read_back(buffer))
}

fn read_back(buffer: &TextBuffer) -> Vec<Rendered> {
    let mut out = Vec::new();
    let mut it = buffer.start_iter();
    loop {
        let mut end = it;
        if !end.ends_line() {
            end.forward_to_line_end();
        }
        out.push(read_line(buffer, it, end));
        if !it.forward_line() {
            break;
        }
    }
    out
}

fn read_line(buffer: &TextBuffer, start: TextIter, end: TextIter) -> Rendered {
    let depth = (1..=6)
        .rev()
        .find(|i| has(&start, &format!("indent-{i}")))
        .unwrap_or(0);

    // The marker's own characters are skipped: they are decoration this file
    // drew, not text the user typed.
    let mut body = start;
    while body.offset() < end.offset() && has(&body, MARKER) {
        body.forward_char();
    }
    let marker_text = buffer.text(&start, &body, false).to_string();

    let block = if has(&start, "h1") {
        BlockKind::Title
    } else if has(&start, "h2") {
        BlockKind::Heading
    } else if has(&start, "h3") {
        BlockKind::Subhead
    } else if has(&start, "fence") {
        BlockKind::Fence
    } else if has(&start, "pre") {
        BlockKind::Code
    } else if has(&start, "li-dash") {
        BlockKind::Dash
    } else if has(&start, "li-check") {
        BlockKind::Check(false)
    } else if has(&start, "li-check-done") {
        BlockKind::Check(true)
    } else if has(&start, "li-number") {
        BlockKind::Number(
            marker_text.trim_end_matches(['.', ' ', ')']).parse().unwrap_or(1),
        )
    } else if has(&start, "li-bullet") {
        BlockKind::Bullet
    } else {
        BlockKind::Body
    };

    Rendered { block, depth, spans: read_spans(buffer, body, end) }
}

fn read_spans(buffer: &TextBuffer, start: TextIter, end: TextIter) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    let mut it = start;
    while it.offset() < end.offset() {
        let st = style_at(&it);
        let from = it;
        // A run ends where its styling changes.
        while it.offset() < end.offset() && style_at(&it) == st {
            it.forward_char();
        }
        let text = buffer.text(&from, &it, false).to_string();
        if !text.is_empty() {
            out.push(Span { text, style: st });
        }
    }
    out
}

fn style_at(it: &TextIter) -> Style {
    Style {
        bold: has(it, BOLD),
        italic: has(it, ITALIC),
        strike: has(it, STRIKE),
        code: has(it, CODE),
        sup: has(it, SUP),
        sub: has(it, SUB),
        href: href_at(it),
    }
}

fn href_at(it: &TextIter) -> Option<String> {
    it.tags().iter().find_map(|t| unsafe {
        t.data::<String>("href").map(|h| h.as_ref().clone())
    })
}

fn has(it: &TextIter, name: &str) -> bool {
    it.tags().iter().any(|t| t.name().is_some_and(|n| n == name))
}
