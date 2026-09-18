//! Markdown to a GtkTextBuffer, and back again.
//!
//! The daemon speaks Markdown, and a Notes clone has to show a heading rather
//! than "# heading". So the markers are consumed into tags on the way in and
//! rebuilt from those tags on the way out.
//!
//! Both directions live here on purpose. A renderer without a matching writer
//! is a one-way door: the moment someone edits a rendered note there is no way
//! back to the text the daemon expects, and saving would rewrite the note as
//! whatever the buffer happened to contain. `round_trips` in the tests holds
//! the two honest by rendering and rebuilding a corpus and demanding the
//! original back.

use gtk::prelude::*;
use gtk::{TextBuffer, TextIter, TextTag};

/// Names the tags a rendered buffer uses. Kept as constants because the writer
/// looks them up by name; a typo that silently matched nothing would drop
/// formatting on save rather than fail.
pub mod tag {
    pub const TITLE: &str = "title";
    pub const HEADING: &str = "heading";
    pub const SUBHEAD: &str = "subhead";
    pub const BOLD: &str = "bold";
    pub const ITALIC: &str = "italic";
    pub const STRIKE: &str = "strike";
    pub const CODE: &str = "code";
    pub const LINK: &str = "link";
    pub const SUP: &str = "sup";
    pub const SUB: &str = "sub";
    /// Marks a line that began as a list item, and how. The marker text itself
    /// is in the buffer so it can be seen and selected; these record what to
    /// write back.
    pub const BULLET: &str = "li-bullet";
    pub const DASH: &str = "li-dash";
    pub const NUMBER: &str = "li-number";
    pub const CHECK_OPEN: &str = "li-check";
    pub const CHECK_DONE: &str = "li-check-done";
    /// Indent depth, one tag per level, so nesting survives the round trip.
    pub const INDENT: [&str; 4] = ["indent-1", "indent-2", "indent-3", "indent-4"];
}

/// install_tags defines every tag the renderer uses.
///
/// Sizes are relative and weights semantic: Apple Notes stores almost nothing
/// typographic -- measured at 98.8% of runs carrying neither a font nor a point
/// size -- so honouring the theme is both easier and more faithful than
/// reproducing whatever the Mac happened to use.
pub fn install_tags(buffer: &TextBuffer) {
    let table = buffer.tag_table();
    let add = |t: TextTag| {
        table.add(&t);
    };

    let title = TextTag::builder()
        .name(tag::TITLE)
        .weight(700)
        .scale(1.6)
        .pixels_above_lines(12)
        .pixels_below_lines(6)
        .build();
    add(title);
    add(TextTag::builder()
        .name(tag::HEADING)
        .weight(700)
        .scale(1.3)
        .pixels_above_lines(10)
        .pixels_below_lines(4)
        .build());
    add(TextTag::builder()
        .name(tag::SUBHEAD)
        .weight(700)
        .scale(1.1)
        .pixels_above_lines(8)
        .build());
    add(TextTag::builder().name(tag::BOLD).weight(700).build());
    add(TextTag::builder()
        .name(tag::ITALIC)
        .style(gtk::pango::Style::Italic)
        .build());
    add(TextTag::builder()
        .name(tag::STRIKE)
        .strikethrough(true)
        .build());
    add(TextTag::builder()
        .name(tag::CODE)
        .family("monospace")
        .build());
    add(TextTag::builder()
        .name(tag::LINK)
        .underline(gtk::pango::Underline::Single)
        .foreground("#3584e4")
        .build());
    add(TextTag::builder()
        .name(tag::SUP)
        .rise(6000)
        .scale(0.75)
        .build());
    add(TextTag::builder()
        .name(tag::SUB)
        .rise(-4000)
        .scale(0.75)
        .build());
    for name in [tag::BULLET, tag::DASH, tag::NUMBER, tag::CHECK_OPEN, tag::CHECK_DONE] {
        add(TextTag::builder().name(name).build());
    }
    for (i, name) in tag::INDENT.iter().enumerate() {
        add(TextTag::builder()
            .name(*name)
            .left_margin(24 * (i as i32 + 1))
            .build());
    }
}

/// A line's block role, recovered on the way in and needed on the way out.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Block {
    Body,
    /// The fence line itself, carrying its exact marker: the length is
    /// meaningful, since a longer fence is how a block containing backticks is
    /// written.
    Fence,
    Title,
    Heading,
    Subhead,
    Bullet,
    Dash,
    Number(u32),
    Check(bool),
    Code,
}

struct Line<'a> {
    block: Block,
    depth: usize,
    text: &'a str,
}

/// parse splits Markdown into block-classified lines without touching inline
/// markup, which is resolved later against the buffer.
fn parse(md: &str) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let mut fenced = false;
    for raw in md.split('\n') {
        let depth = depth_of(raw);
        // Only the whitespace that made up the indent levels is consumed.
        // Trimming the rest would delete leading spaces a note really has --
        // and Rust's trim_start also eats NBSP, which Notes uses for indented
        // body text, so a whole line's leading layout would vanish on save.
        let t = &raw[indent_len(raw, depth)..];

        if t.starts_with("```") {
            fenced = !fenced;
            // The marker is kept rather than dropped. Losing it turned a fenced
            // block into inline code spans on the way back out, which is a
            // different note.
            out.push(Line { block: Block::Fence, depth, text: t });
            continue;
        }
        if fenced {
            out.push(Line { block: Block::Code, depth, text: raw });
            continue;
        }
        let (block, text) = classify(t);
        out.push(Line { block, depth, text });
    }
    out
}

fn classify(t: &str) -> (Block, &str) {
    // Checklists first: "- [ ]" also matches the bullet pattern.
    if let Some(rest) = t.strip_prefix("- [ ] ").or_else(|| t.strip_prefix("* [ ] ")) {
        return (Block::Check(false), rest);
    }
    if let Some(rest) = t
        .strip_prefix("- [x] ")
        .or_else(|| t.strip_prefix("- [X] "))
        .or_else(|| t.strip_prefix("* [x] "))
    {
        return (Block::Check(true), rest);
    }
    if let Some(rest) = t.strip_prefix("### ") {
        return (Block::Subhead, rest);
    }
    if let Some(rest) = t.strip_prefix("## ") {
        return (Block::Heading, rest);
    }
    if let Some(rest) = t.strip_prefix("# ") {
        return (Block::Title, rest);
    }
    if let Some(rest) = t.strip_prefix("+ ") {
        return (Block::Dash, rest);
    }
    if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
        return (Block::Bullet, rest);
    }
    if let Some((n, rest)) = split_number(t) {
        return (Block::Number(n), rest);
    }
    (Block::Body, t)
}

/// split_number matches "12. text", returning the number and the text.
fn split_number(t: &str) -> Option<(u32, &str)> {
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let rest = &t[digits.len()..];
    let rest = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))?;
    digits.parse().ok().map(|n| (n, rest))
}

/// indent_len is the byte length of the whitespace that makes up `depth`
/// levels, so the remainder of the line survives untouched.
fn indent_len(line: &str, depth: usize) -> usize {
    if depth == 0 {
        return 0;
    }
    let want = depth * 4;
    let mut cols = 0;
    for (i, c) in line.char_indices() {
        match c {
            ' ' => cols += 1,
            '\t' => cols += 4,
            _ => return i,
        }
        if cols >= want {
            return i + c.len_utf8();
        }
    }
    line.len()
}

/// depth_of reads nesting from leading whitespace: four spaces or a tab per
/// level, matching what the daemon writes.
fn depth_of(line: &str) -> usize {
    let mut cols = 0;
    for c in line.chars() {
        match c {
            ' ' => cols += 1,
            '\t' => cols += 4,
            _ => break,
        }
    }
    cols / 4
}

/// Inline styling on a run of text. A set rather than a nesting, because that
/// is what a text buffer can actually represent: two tags either cover a
/// character or they do not.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
    pub sup: bool,
    pub sub: bool,
    pub href: Option<String>,
}

/// A run of text sharing one style.
#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub text: String,
    pub style: Style,
}

/// A rendered line: what it is, how deep, and the styled text it holds.
#[derive(Clone, Debug, PartialEq)]
pub struct Rendered {
    pub block: BlockKind,
    pub depth: usize,
    pub spans: Vec<Span>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BlockKind {
    Body,
    Title,
    Heading,
    Subhead,
    Bullet,
    Dash,
    Number(u32),
    Check(bool),
    Code,
    Fence,
}

impl BlockKind {
    /// marker is the glyph shown in place of the Markdown, or none.
    pub fn marker(self) -> Option<&'static str> {
        match self {
            BlockKind::Bullet => Some("• "),
            BlockKind::Dash => Some("– "),
            BlockKind::Check(false) => Some("☐ "),
            BlockKind::Check(true) => Some("☑ "),
            _ => None,
        }
    }

    /// prefix is the Markdown this block is written back as.
    fn prefix(self) -> String {
        match self {
            BlockKind::Body | BlockKind::Code | BlockKind::Fence => String::new(),
            BlockKind::Title => "# ".into(),
            BlockKind::Heading => "## ".into(),
            BlockKind::Subhead => "### ".into(),
            BlockKind::Bullet => "- ".into(),
            BlockKind::Dash => "+ ".into(),
            BlockKind::Number(n) => format!("{n}. "),
            BlockKind::Check(false) => "- [ ] ".into(),
            BlockKind::Check(true) => "- [x] ".into(),
        }
    }
}

/// parse_doc turns Markdown into the lines a view can draw, with every marker
/// consumed. It is pure, so the round trip can be tested without a display --
/// which matters, because that property is the one the editor rests on.
pub fn parse_doc(md: &str) -> Vec<Rendered> {
    parse(md)
        .into_iter()
        .map(|l| Rendered {
            block: match l.block {
                Block::Body => BlockKind::Body,
                Block::Title => BlockKind::Title,
                Block::Heading => BlockKind::Heading,
                Block::Subhead => BlockKind::Subhead,
                Block::Bullet => BlockKind::Bullet,
                Block::Dash => BlockKind::Dash,
                Block::Number(n) => BlockKind::Number(n),
                Block::Check(d) => BlockKind::Check(d),
                Block::Code => BlockKind::Code,
                Block::Fence => BlockKind::Fence,
            },
            depth: l.depth,
            spans: if matches!(l.block, Block::Code | Block::Fence) {
                vec![Span { text: l.text.to_string(), style: Style { code: true, ..Default::default() } }]
            } else {
                inline_spans(l.text)
            },
        })
        .collect()
}

/// doc_markdown rebuilds the source from the lines. Together with parse_doc
/// this is the round trip; the view layer only has to preserve the model.
pub fn doc_markdown(lines: &[Rendered]) -> String {
    let mut out = String::new();
    for (i, l) in lines.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&"    ".repeat(l.depth));
        out.push_str(&l.block.prefix());
        if matches!(l.block, BlockKind::Code | BlockKind::Fence) {
            // Verbatim: inside a fence nothing is markup, so nothing is
            // escaped and nothing is wrapped in backticks.
            for sp in &l.spans {
                out.push_str(&sp.text);
            }
            continue;
        }
        let body = spans_markdown(&l.spans);
        {
            // The body is escaped whether or not it carries a marker: inside
            // "1. 1.5 dropped" the "1." of "1.5" would start a nested list.
            out.push_str(&escape_line_start(&body));
        }
    }
    out
}

/// inline_spans resolves emphasis, code, links and sup/sub into flat runs.
fn inline_spans(s: &str) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    collect(s, Style::default(), &mut out);
    out.retain(|s| !s.text.is_empty());
    out
}

fn collect(s: &str, style: Style, out: &mut Vec<Span>) {
    let mut plain = String::new();
    let mut i = 0;
    while i < s.len() {
        if s[i..].starts_with('\\') {
            if let Some(c) = s[i + 1..].chars().next() {
                plain.push(c);
                i += 1 + c.len_utf8();
                continue;
            }
        }
        if let Some((apply, open, close)) = opener(s, i) {
            if let Some(end) = find_close(s, i + open, close) {
                push(out, &mut plain, &style);
                let mut inner = style.clone();
                apply(&mut inner);
                if inner.code && !style.code {
                    // Nothing inside a code span is markup, so its contents are
                    // taken whole. Recursing would read `**x**` as emphasis and
                    // the delimiters would not come back.
                    out.push(Span { text: s[i + open..end].to_string(), style: inner });
                } else {
                    collect(&s[i + open..end], inner, out);
                }
                i = end + close.len();
                continue;
            }
        }
        if s[i..].starts_with('[') {
            if let Some((label, dest, len)) = split_link(&s[i..]) {
                push(out, &mut plain, &style);
                let mut inner = style.clone();
                inner.href = Some(dest.to_string());
                collect(label, inner, out);
                i += len;
                continue;
            }
        }
        let c = s[i..].chars().next().unwrap();
        plain.push(c);
        i += c.len_utf8();
    }
    push(out, &mut plain, &style);
}

fn push(out: &mut Vec<Span>, plain: &mut String, style: &Style) {
    if plain.is_empty() {
        return;
    }
    out.push(Span { text: std::mem::take(plain), style: style.clone() });
}

type Apply = fn(&mut Style);

/// opener reports what a delimiter at `i` turns on. Longest first, so "***" is
/// not read as "*".
fn opener(s: &str, i: usize) -> Option<(Apply, usize, &'static str)> {
    let both: Apply = |st| {
        st.bold = true;
        st.italic = true;
    };
    let bold: Apply = |st| st.bold = true;
    let italic: Apply = |st| st.italic = true;
    let strike: Apply = |st| st.strike = true;
    let code: Apply = |st| st.code = true;
    let sup: Apply = |st| st.sup = true;
    let sub: Apply = |st| st.sub = true;
    for (delim, close, f) in [
        ("***", "***", both),
        ("**", "**", bold),
        ("~~", "~~", strike),
        ("`", "`", code),
        ("<sup>", "</sup>", sup),
        ("<sub>", "</sub>", sub),
        ("*", "*", italic),
    ] {
        if s[i..].starts_with(delim) {
            return Some((f, delim.len(), close));
        }
    }
    None
}

fn find_close(s: &str, from: usize, close: &str) -> Option<usize> {
    let mut i = from;
    while i < s.len() {
        if s[i..].starts_with('\\') {
            i += 1 + s[i + 1..].chars().next().map_or(0, char::len_utf8);
            continue;
        }
        if s[i..].starts_with(close) {
            return Some(i);
        }
        i += s[i..].chars().next()?.len_utf8();
    }
    None
}

fn split_link(s: &str) -> Option<(&str, &str, usize)> {
    let close = find_close(s, 1, "]")?;
    let rest = &s[close + 1..];
    if !rest.starts_with('(') {
        return None;
    }
    let end = rest.find(')')?;
    Some((&s[1..close], &rest[1..end], close + 1 + end + 1))
}

/// spans_markdown writes runs back out.
///
/// Delimiters are emitted where the style *changes*, not around each run.
/// Wrapping every run independently turns "**a *b* c**" into
/// "**a ****b**** c**": correct-looking, and wrong.
fn spans_markdown(spans: &[Span]) -> String {
    let mut out = String::new();
    let mut open: Vec<Mark> = Vec::new();

    for sp in spans {
        let want = marks_of(&sp.style);

        // Close what is no longer wanted, innermost first: delimiters nest, so
        // they cannot be closed out of order.
        while let Some(last) = open.last() {
            if want.contains(last) {
                break;
            }
            out.push_str(&last.close());
            open.pop();
        }
        for m in &want {
            if !open.contains(m) {
                out.push_str(&m.open());
                open.push(m.clone());
            }
        }
        // Code is literal, so nothing inside it is escaped; everywhere else
        // the characters the daemon escapes have to be escaped back, or a line
        // it wrote as "1\. Holy" comes back as "1. Holy" and turns into a
        // numbered list on the next save.
        if sp.style.code {
            out.push_str(&sp.text);
        } else {
            out.push_str(&escape_text(&sp.text));
        }
    }
    while let Some(m) = open.pop() {
        out.push_str(&m.close());
    }
    out
}

/// Mark is one delimiter pair, in the order they nest: a link wraps its label,
/// emphasis wraps text, and code is innermost because its contents are literal.
#[derive(Clone, PartialEq)]
enum Mark {
    Link(String),
    Strike,
    Bold,
    Italic,
    Sup,
    Sub,
    Code,
}

impl Mark {
    fn open(&self) -> String {
        match self {
            Mark::Link(_) => "[".into(),
            Mark::Strike => "~~".into(),
            Mark::Bold => "**".into(),
            Mark::Italic => "*".into(),
            Mark::Sup => "<sup>".into(),
            Mark::Sub => "<sub>".into(),
            Mark::Code => "`".into(),
        }
    }
    fn close(&self) -> String {
        match self {
            Mark::Link(href) => format!("]({href})"),
            Mark::Sup => "</sup>".into(),
            Mark::Sub => "</sub>".into(),
            other => other.open(),
        }
    }
}

/// escape_text mirrors the daemon's own escaping. It must match exactly: this
/// is the inverse of the parser's backslash handling, and a character escaped
/// by one side and not the other changes the note on every save.
fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '~') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// escape_line_start stops a line of body text from being read as a heading,
/// list or quote. The daemon does the same on the way out, so a line it wrote
/// as "1\. Holy" has to be written back that way.
fn escape_line_start(s: &str) -> String {
    let trimmed = s.trim_start();
    if trimmed.is_empty() {
        return s.to_string();
    }
    let lead = &s[..s.len() - trimmed.len()];
    let mut chars = trimmed.chars();
    let first = chars.next().unwrap();
    if matches!(first, '#' | '>' | '-' | '+' | '=') {
        return format!("{lead}\\{trimmed}");
    }
    if first.is_ascii_digit() {
        let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
        let rest = &trimmed[digits.len()..];
        if rest.starts_with('.') || rest.starts_with(')') {
            return format!("{lead}{digits}\\{rest}");
        }
    }
    s.to_string()
}

fn marks_of(st: &Style) -> Vec<Mark> {
    let mut v = Vec::new();
    if let Some(h) = &st.href {
        v.push(Mark::Link(h.clone()));
    }
    if st.strike {
        v.push(Mark::Strike);
    }
    if st.bold {
        v.push(Mark::Bold);
    }
    if st.italic {
        v.push(Mark::Italic);
    }
    if st.sup {
        v.push(Mark::Sup);
    }
    if st.sub {
        v.push(Mark::Sub);
    }
    if st.code {
        v.push(Mark::Code);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property the editor rests on: parsing a note for display and
    /// rebuilding it must give back what the daemon sent. Without it, opening
    /// a note and pressing save rewrites it as whatever the view happened to
    /// hold -- and the daemon would accept that, because a rewrite is exactly
    /// what it was asked for.
    ///
    /// Pure on purpose. Driving this through a real TextBuffer would need a
    /// display, and a guarantee that can only be checked on a developer's
    /// desktop is one that stops being checked.
    #[track_caller]
    fn round_trips(md: &str) {
        let got = doc_markdown(&parse_doc(md));
        assert_eq!(got, md, "\n  rebuilt:  {got:?}\n  original: {md:?}");
    }

    #[test]
    fn plain_text() {
        round_trips("hello");
        round_trips("two\nlines");
        round_trips("a blank line\n\nfollows");
        round_trips("");
    }

    #[test]
    fn headings() {
        round_trips("# Title");
        round_trips("## Heading");
        round_trips("### Subheading");
        round_trips("# Title\nbody\n## Heading\nmore");
    }

    #[test]
    fn emphasis() {
        round_trips("**bold**");
        round_trips("*italic*");
        round_trips("***both***");
        round_trips("~~struck~~");
        round_trips("`code`");
        round_trips("plain **bold** plain");
        round_trips("a **b** c *d* e ~~f~~ g");
        round_trips("**bold with *italic* inside**");
    }

    #[test]
    fn lists() {
        round_trips("- bullet");
        round_trips("+ dashed");
        round_trips("1. first\n2. second");
        round_trips("- a\n- b\n- c");
        round_trips("- top\n    - nested");
        round_trips("1. one\n    1. one-a\n2. two");
        round_trips("- a\n    - b\n        - c");
    }

    #[test]
    fn checklists() {
        round_trips("- [ ] todo");
        round_trips("- [x] done");
        round_trips("- [ ] a\n- [x] b");
    }

    #[test]
    fn links() {
        round_trips("[label](https://example.test/)");
        round_trips("see [the docs](https://example.test/docs) for more");
        round_trips("[**bold label**](https://x.test/)");
    }

    #[test]
    fn superscript_and_subscript() {
        round_trips("x<sup>2</sup>");
        round_trips("H<sub>2</sub>O");
        round_trips("a<sup>b</sup>c<sub>d</sub>");
    }

    /// The shapes real notes take, rather than one feature at a time.
    #[test]
    fn realistic_notes() {
        round_trips("# Meeting with Dean\n\nFollow up to previous meetings\n\n1. Silence is restrictive\n    1. Heb 7\n2. If CENI is wrong");
        round_trips("## Agenda\n\n- [ ] open\n- [x] closed\n\nsee [notes](https://x.test/n)");
        round_trips("- a bullet\n    - nested bullet\n        - deeper still");
    }

    /// Markers are consumed for display, so the view shows a heading rather
    /// than "# heading" -- the whole point of rendering.
    #[test]
    fn markers_are_consumed_for_display() {
        let doc = parse_doc("# Title\n- item\n1. first\n- [x] done");
        assert_eq!(doc[0].block, BlockKind::Title);
        assert_eq!(doc[0].spans[0].text, "Title");
        assert_eq!(doc[1].block, BlockKind::Bullet);
        assert_eq!(doc[1].spans[0].text, "item");
        assert_eq!(doc[2].block, BlockKind::Number(1));
        assert_eq!(doc[3].block, BlockKind::Check(true));
        assert_eq!(doc[3].spans[0].text, "done");
    }

    /// Emphasis delimiters are consumed too, and become style on the run.
    #[test]
    fn emphasis_becomes_style_not_text() {
        let doc = parse_doc("say **loudly** now");
        let texts: Vec<_> = doc[0].spans.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["say ", "loudly", " now"]);
        assert!(doc[0].spans[1].style.bold);
        assert!(!doc[0].spans[0].style.bold);
    }

    /// A link shows its label, with the destination carried beside it.
    #[test]
    fn a_link_shows_its_label() {
        let doc = parse_doc("see [the docs](https://x.test/d)");
        let link = doc[0].spans.iter().find(|s| s.style.href.is_some()).unwrap();
        assert_eq!(link.text, "the docs");
        assert_eq!(link.style.href.as_deref(), Some("https://x.test/d"));
    }

    /// Nothing inside a code span is markup, so its delimiters must not be
    /// read as emphasis -- and must come back as they went in.
    #[test]
    fn code_spans_are_literal() {
        round_trips("`**not bold**`");
        let doc = parse_doc("`**not bold**`");
        assert_eq!(doc[0].spans[0].text, "**not bold**");
        assert!(doc[0].spans[0].style.code);
        assert!(!doc[0].spans[0].style.bold);
    }

    /// No text may be invented or lost, whatever the styling.
    #[test]
    fn every_character_of_the_body_survives() {
        for md in [
            "# Title", "- item", "**bold** text", "1. one", "- [x] done",
            "x<sup>2</sup>", "[a](b)", "`code`",
        ] {
            let doc = parse_doc(md);
            let shown: String = doc[0].spans.iter().map(|s| s.text.as_str()).collect();
            assert!(!shown.is_empty(), "{md:?} rendered to nothing");
        }
    }
    /// Round-trips every note in a real library. Examples chosen by the author
    /// of the parser test the shapes the author thought of; a real library
    /// tests the ones they did not.
    #[test]
    fn corpus_round_trips() {
        let dir = match std::env::var("CORPUS") {
            Ok(d) => d,
            Err(_) => return,
        };
        let mut checked = 0;
        let mut failed = Vec::new();
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            let md = std::fs::read_to_string(&p).unwrap();
            let got = doc_markdown(&parse_doc(&md));
            checked += 1;
            if got != md {
                failed.push((p, md, got));
            }
        }
        for (p, md, got) in failed.iter().take(3) {
            let (a, b) = first_difference(md, got);
            eprintln!("--- {p:?}\n  original: {a:?}\n  rebuilt:  {b:?}");
        }
        assert!(failed.is_empty(), "{}/{} notes did not round-trip", failed.len(), checked);
        eprintln!("{checked} notes round-tripped");
    }

    /// Reports the first line that differs, since whole notes are unreadable in
    /// a failure message.
    fn first_difference(a: &str, b: &str) -> (String, String) {
        for (x, y) in a.lines().zip(b.lines()) {
            if x != y {
                return (x.to_string(), y.to_string());
            }
        }
        (format!("<{} lines>", a.lines().count()), format!("<{} lines>", b.lines().count()))
    }
}
