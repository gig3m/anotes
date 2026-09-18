// The notesd HTTP client.
//
// Deliberately thin. How a note converts to Markdown, and what a rewrite would
// cost, are already decided on the daemon side; answering them again here would
// mean two answers to the same question, diverging the first time either
// changes.
.pragma library

var base = ""
var token = ""

function configured() { return base.length > 0 && token.length > 0 }

// request issues one call. Every response is handed back through `done` so a
// caller never blocks the UI thread; a failure arrives as an Error rather than
// a silent empty result.
function request(method, path, body, done) {
    if (!configured()) {
        done(null, { message: "No daemon configured. Set the URL and token in the plugin settings." })
        return
    }
    var xhr = new XMLHttpRequest()
    xhr.open(method, base.replace(/\/+$/, "") + path)
    xhr.setRequestHeader("Authorization", "Bearer " + token)
    if (body !== null && body !== undefined) xhr.setRequestHeader("Content-Type", "application/json")
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== XMLHttpRequest.DONE) return
        if (xhr.status === 0) {
            done(null, { message: "Cannot reach the daemon at " + base })
            return
        }
        var text = xhr.responseText || ""
        if (xhr.status >= 200 && xhr.status < 300) {
            if (!text.trim().length) { done({}, null); return }
            try { done(JSON.parse(text), null) }
            catch (e) { done(null, { message: "The daemon returned something unexpected" }) }
            return
        }
        var err = {}
        try { err = JSON.parse(text) } catch (e) { }
        done(null, {
            message: err.error || ("HTTP " + xhr.status),
            detail: err.detail || "",
            // Carried so a caller can offer force rather than reconstruct the
            // reason from prose.
            destroys: err.destroys || []
        })
    }
    xhr.send(body === null || body === undefined ? undefined : JSON.stringify(body))
}

function folders(done) { request("GET", "/v1/folders", null, done) }

function notes(folder, done) {
    request("GET", "/v1/notes" + (folder ? "?folder=" + encodeURIComponent(folder) : ""), null, done)
}

function note(uuid, done) { request("GET", "/v1/notes/" + encodeURIComponent(uuid), null, done) }

function search(query, done) {
    request("GET", "/v1/search?q=" + encodeURIComponent(query), null, done)
}

function replace(uuid, markdown, allowShared, done) {
    request("PUT", "/v1/notes/" + encodeURIComponent(uuid),
        { markdown: markdown, allowShared: !!allowShared }, done)
}

function create(folder, markdown, done) {
    request("POST", "/v1/notes", { markdown: markdown, folder: folder || "" }, done)
}
