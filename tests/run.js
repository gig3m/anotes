// Runs the Markdown round-trip tests under node.
//
// Markdown.js is a QML library, so it is loaded by stripping the .pragma line
// and evaluating it -- the alternative is maintaining a second copy for tests,
// which is how the two drift.
const fs = require("fs")
const path = require("path")
const vm = require("vm")

const src = fs.readFileSync(path.join(__dirname, "..", "Markdown.js"), "utf8")
    .replace(/^\.pragma library$/m, "")
const ctx = { console }
vm.createContext(ctx)
vm.runInContext(src, ctx)
const { parseDoc, docMarkdown } = ctx

let failures = 0
function check(name, cond, detail) {
    if (!cond) { failures++; console.error("FAIL " + name + (detail ? "\n     " + detail : "")) }
}

// The property the editor rests on: parsing a note for display and rebuilding
// it must give back what the daemon sent. Without it, opening a note and
// pressing save rewrites it as whatever the view happened to hold.
function roundTrips(md, label) {
    const got = docMarkdown(parseDoc(md))
    check(label || JSON.stringify(md), got === md,
        "rebuilt:  " + JSON.stringify(got) + "\n     original: " + JSON.stringify(md))
}

for (const md of ["hello", "two\nlines", "a blank line\n\nfollows", ""]) roundTrips(md)
for (const md of ["# Title", "## Heading", "### Subheading", "# Title\nbody\n## Heading\nmore"]) roundTrips(md)
for (const md of ["**bold**", "*italic*", "***both***", "~~struck~~", "`code`",
                  "plain **bold** plain", "a **b** c *d* e ~~f~~ g",
                  "**bold with *italic* inside**"]) roundTrips(md)
for (const md of ["- bullet", "+ dashed", "1. first\n2. second", "- a\n- b\n- c",
                  "- top\n    - nested", "1. one\n    1. one-a\n2. two",
                  "- a\n    - b\n        - c"]) roundTrips(md)
for (const md of ["- [ ] todo", "- [x] done", "- [ ] a\n- [x] b"]) roundTrips(md)
for (const md of ["[label](https://example.test/)",
                  "see [the docs](https://example.test/docs) for more",
                  "[**bold label**](https://x.test/)"]) roundTrips(md)
for (const md of ["x<sup>2</sup>", "H<sub>2</sub>O", "a<sup>b</sup>c<sub>d</sub>"]) roundTrips(md)
roundTrips("`**not bold**`")
roundTrips("# Meeting with Dean\n\nFollow up to previous meetings\n\n1. Silence is restrictive\n    1. Heb 7\n2. If CENI is wrong")
roundTrips("## Agenda\n\n- [ ] open\n- [x] closed\n\nsee [notes](https://x.test/n)")
// The escaping cases a real library turned up, which hand-written tests missed.
roundTrips("1\\. Holy, Holy, Holy")
roundTrips("1. 1\\.5 dropped on bad breaking putts")
roundTrips("  two leading spaces are content")

// Markers are consumed for display: the whole point of rendering.
{
    const d = parseDoc("# Title\n- item\n1. first\n- [x] done")
    check("title marker consumed", d[0].block === "title" && d[0].spans[0].text === "Title")
    check("bullet marker consumed", d[1].block === "bullet" && d[1].spans[0].text === "item")
    check("number parsed", d[2].block === "number" && d[2].number === 1)
    check("checkbox state", d[3].block === "checkDone" && d[3].spans[0].text === "done")
}
{
    const d = parseDoc("say **loudly** now")
    const texts = d[0].spans.map(s => s.text)
    check("emphasis becomes style", JSON.stringify(texts) === JSON.stringify(["say ", "loudly", " now"]),
        JSON.stringify(texts))
    check("bold flagged", d[0].spans[1].style.bold === true)
}
{
    const d = parseDoc("see [the docs](https://x.test/d)")
    const link = d[0].spans.find(s => s.style.href !== undefined)
    check("link label shown", link && link.text === "the docs")
    check("link dest carried", link && link.style.href === "https://x.test/d")
}

// A real library tests the shapes the author did not think of.
const corpus = process.env.CORPUS
if (corpus && fs.existsSync(corpus)) {
    let n = 0, bad = 0
    for (const f of fs.readdirSync(corpus)) {
        const md = fs.readFileSync(path.join(corpus, f), "utf8")
        n++
        if (docMarkdown(parseDoc(md)) !== md) {
            bad++
            if (bad <= 3) {
                const a = md.split("\n"), b = docMarkdown(parseDoc(md)).split("\n")
                const i = a.findIndex((l, j) => l !== b[j])
                console.error("FAIL corpus " + f + "\n     original: " + JSON.stringify(a[i]) +
                              "\n     rebuilt:  " + JSON.stringify(b[i]))
            }
        }
    }
    check("corpus round-trips (" + n + " notes)", bad === 0, bad + " failed")
    if (!bad) console.log(n + " corpus notes round-tripped")
}

console.log(failures === 0 ? "all tests passed" : failures + " FAILURES")
process.exit(failures === 0 ? 0 : 1)
