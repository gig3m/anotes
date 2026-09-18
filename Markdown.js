// Markdown to a displayable document, and back again.
//
// The daemon speaks Markdown, and a Notes client has to show a heading rather
// than "# heading". So markers are consumed into structure on the way in and
// rebuilt on the way out.
//
// Both directions live here on purpose. A parser without a matching writer is a
// one-way door: the moment someone edits a rendered note there is nothing to
// save but whatever the view happens to hold, and the daemon would accept it,
// because a rewrite is exactly what it was asked for.
//
// Ported from the Rust original together with its tests, including the corpus
// check that round-trips a real library. That check found five bugs the
// hand-written cases missed, so it came across intact.
.pragma library

// ---- blocks

function parseDoc(md) {
    const lines = []
    let fenced = false
    for (const raw of String(md).split("\n")) {
        const depth = depthOf(raw)
        const t = raw.slice(indentLen(raw, depth))
        const trimmed = t.replace(/^[ \t]+/, "")

        if (trimmed.startsWith("```")) {
            fenced = !fenced
            // The marker is kept rather than dropped. Losing it turns a fenced
            // block into inline code spans on the way back out.
            lines.push({ block: "fence", depth: depth, spans: [{ text: trimmed, style: {} }] })
            continue
        }
        if (fenced) {
            lines.push({ block: "code", depth: depth, spans: [{ text: t, style: { code: true } }] })
            continue
        }
        const c = classify(t)
        lines.push({ block: c.block, number: c.number, depth: depth, spans: inlineSpans(c.text) })
    }
    return lines
}

function classify(t) {
    // Checklists first: "- [ ]" also matches the bullet pattern.
    let m
    if ((m = /^[-*] \[ \] (.*)$/.exec(t))) return { block: "check", number: 0, text: m[1] }
    if ((m = /^[-*] \[[xX]\] (.*)$/.exec(t))) return { block: "checkDone", number: 0, text: m[1] }
    if ((m = /^### (.*)$/.exec(t))) return { block: "subhead", number: 0, text: m[1] }
    if ((m = /^## (.*)$/.exec(t))) return { block: "heading", number: 0, text: m[1] }
    if ((m = /^# (.*)$/.exec(t))) return { block: "title", number: 0, text: m[1] }
    if ((m = /^\+ (.*)$/.exec(t))) return { block: "dash", number: 0, text: m[1] }
    if ((m = /^[-*] (.*)$/.exec(t))) return { block: "bullet", number: 0, text: m[1] }
    if ((m = /^(\d+)[.)] (.*)$/.exec(t))) return { block: "number", number: parseInt(m[1], 10), text: m[2] }
    return { block: "body", number: 0, text: t }
}

// depthOf reads nesting from leading whitespace: four columns per level, which
// is what the daemon writes.
function depthOf(line) {
    let cols = 0
    for (const ch of line) {
        if (ch === " ") cols += 1
        else if (ch === "\t") cols += 4
        else break
    }
    return Math.floor(cols / 4)
}

// indentLen is how much of the line the indent levels account for. Only that
// much is consumed: trimming the rest would delete leading spaces the note
// really has, and NBSP -- which Notes uses for indented body text -- is
// whitespace to a naive trim but content here.
function indentLen(line, depth) {
    if (depth === 0) return 0
    const want = depth * 4
    let cols = 0
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === " ") cols += 1
        else if (ch === "\t") cols += 4
        else return i
        if (cols >= want) return i + 1
    }
    return line.length
}

function markerFor(block) {
    switch (block) {
        case "bullet": return "• "
        case "dash": return "– "
        case "check": return "☐ "
        case "checkDone": return "☑ "
        default: return ""
    }
}

function prefixFor(line) {
    switch (line.block) {
        case "title": return "# "
        case "heading": return "## "
        case "subhead": return "### "
        case "bullet": return "- "
        case "dash": return "+ "
        case "number": return line.number + ". "
        case "check": return "- [ ] "
        case "checkDone": return "- [x] "
        default: return ""
    }
}

// ---- inline

function inlineSpans(s) {
    const out = []
    collect(s, {}, out)
    return out.filter(function (x) { return x.text.length > 0 })
}

const OPENERS = [
    ["***", "***", function (st) { st.bold = true; st.italic = true }],
    ["**", "**", function (st) { st.bold = true }],
    ["~~", "~~", function (st) { st.strike = true }],
    ["`", "`", function (st) { st.code = true }],
    ["<sup>", "</sup>", function (st) { st.sup = true }],
    ["<sub>", "</sub>", function (st) { st.sub = true }],
    ["*", "*", function (st) { st.italic = true }]
]

function collect(s, style, out) {
    let plain = ""
    let i = 0
    function flush() {
        if (plain.length) { out.push({ text: plain, style: copyStyle(style) }); plain = "" }
    }
    while (i < s.length) {
        if (s[i] === "\\" && i + 1 < s.length) {
            plain += s[i + 1]
            i += 2
            continue
        }
        const op = openerAt(s, i)
        if (op) {
            const end = findClose(s, i + op[0].length, op[1])
            if (end >= 0) {
                flush()
                const inner = copyStyle(style)
                op[2](inner)
                if (inner.code && !style.code) {
                    // Nothing inside a code span is markup, so it is taken
                    // whole. Recursing would read `**x**` as emphasis and the
                    // delimiters would not come back.
                    out.push({ text: s.slice(i + op[0].length, end), style: inner })
                } else {
                    collect(s.slice(i + op[0].length, end), inner, out)
                }
                i = end + op[1].length
                continue
            }
        }
        if (s[i] === "[") {
            const link = splitLink(s.slice(i))
            if (link) {
                flush()
                const inner = copyStyle(style)
                inner.href = link.dest
                collect(link.label, inner, out)
                i += link.len
                continue
            }
        }
        plain += s[i]
        i += 1
    }
    flush()
}

function openerAt(s, i) {
    for (const op of OPENERS) if (s.startsWith(op[0], i)) return op
    return null
}

function findClose(s, from, close) {
    let i = from
    while (i < s.length) {
        if (s[i] === "\\") { i += 2; continue }
        if (s.startsWith(close, i)) return i
        i += 1
    }
    return -1
}

function splitLink(s) {
    const close = findClose(s, 1, "]")
    if (close < 0) return null
    const rest = s.slice(close + 1)
    if (!rest.startsWith("(")) return null
    const end = rest.indexOf(")")
    if (end < 0) return null
    return { label: s.slice(1, close), dest: rest.slice(1, end), len: close + 1 + end + 1 }
}

function copyStyle(st) {
    return {
        bold: !!st.bold, italic: !!st.italic, strike: !!st.strike,
        code: !!st.code, sup: !!st.sup, sub: !!st.sub,
        href: st.href === undefined ? undefined : st.href
    }
}

// ---- writing back

function docMarkdown(lines) {
    const out = []
    for (const line of lines) {
        const indent = "    ".repeat(line.depth)
        if (line.block === "code" || line.block === "fence") {
            // Verbatim: inside a fence nothing is markup, so nothing is escaped
            // and nothing is wrapped in backticks.
            out.push(indent + line.spans.map(function (s) { return s.text }).join(""))
            continue
        }
        // The body is escaped whether or not it carries a marker: inside
        // "1. 1.5 dropped" the "1." of "1.5" would start a nested list.
        out.push(indent + prefixFor(line) + escapeLineStart(spansMarkdown(line.spans)))
    }
    return out.join("\n")
}

// spansMarkdown emits delimiters where the style *changes*, not around each
// run. Wrapping every run independently turns "**a *b* c**" into
// "**a ****b**** c**": correct-looking, and wrong.
function spansMarkdown(spans) {
    let out = ""
    let open = []
    for (const sp of spans) {
        const want = marksOf(sp.style)
        // Close what is no longer wanted, innermost first: delimiters nest, so
        // they cannot be closed out of order.
        while (open.length && !want.some(function (m) { return sameMark(m, open[open.length - 1]) })) {
            out += closeMark(open.pop())
        }
        for (const m of want) {
            if (!open.some(function (o) { return sameMark(o, m) })) {
                out += openMark(m)
                open.push(m)
            }
        }
        out += sp.style.code ? sp.text : escapeText(sp.text)
    }
    while (open.length) out += closeMark(open.pop())
    return out
}

// Marks nest in this order: a link wraps its label, emphasis wraps text, and
// code is innermost because its contents are literal.
function marksOf(st) {
    const v = []
    if (st.href !== undefined) v.push({ kind: "link", href: st.href })
    if (st.strike) v.push({ kind: "strike" })
    if (st.bold) v.push({ kind: "bold" })
    if (st.italic) v.push({ kind: "italic" })
    if (st.sup) v.push({ kind: "sup" })
    if (st.sub) v.push({ kind: "sub" })
    if (st.code) v.push({ kind: "code" })
    return v
}

function sameMark(a, b) { return a.kind === b.kind && a.href === b.href }

function openMark(m) {
    switch (m.kind) {
        case "link": return "["
        case "strike": return "~~"
        case "bold": return "**"
        case "italic": return "*"
        case "sup": return "<sup>"
        case "sub": return "<sub>"
        case "code": return "`"
    }
    return ""
}

function closeMark(m) {
    switch (m.kind) {
        case "link": return "](" + m.href + ")"
        case "sup": return "</sup>"
        case "sub": return "</sub>"
    }
    return openMark(m)
}

// escapeText mirrors the daemon's own escaping. It must match exactly: this is
// the inverse of the parser's backslash handling, and a character escaped by
// one side and not the other changes the note on every save.
function escapeText(s) {
    let out = ""
    for (const c of s) {
        if ("\\`*_[]<>~".indexOf(c) >= 0) out += "\\"
        out += c
    }
    return out
}

// escapeLineStart stops body text from being read as a heading, list or quote.
// The daemon does the same on the way out, so a line it wrote as "1\. Holy" has
// to be written back that way.
function escapeLineStart(s) {
    const trimmed = s.replace(/^\s+/, "")
    if (!trimmed.length) return s
    const lead = s.slice(0, s.length - trimmed.length)
    const first = trimmed[0]
    if ("#>-+=".indexOf(first) >= 0) return lead + "\\" + trimmed
    const m = /^(\d+)([.)])/.exec(trimmed)
    if (m) return lead + m[1] + "\\" + trimmed.slice(m[1].length)
    return s
}
