//! The notesd HTTP client.
//!
//! Deliberately thin. The interesting decisions -- how a note converts to
//! Markdown, which formatting a rewrite destroys -- already live on the daemon
//! side, and answering them a second time here would mean two answers to the
//! same question, diverging the first time either changes.
//!
//! Every call blocks, and is expected to be made off the GTK main thread.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
pub struct Folder {
    pub uuid: String,
    pub name: String,
    #[serde(default)]
    pub trash: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Note {
    pub uuid: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub trashed: bool,
    #[serde(default)]
    pub modified: String,
    /// Present only when a single note is fetched.
    #[serde(default)]
    pub markdown: String,
    /// Formatting a rewrite would flatten. Never a reason to refuse one.
    #[serde(default)]
    pub degrades: Vec<String>,
    /// Content a rewrite would destroy -- attachments, checklists. The daemon
    /// refuses the write unless forced, so the editor must not offer to save a
    /// note carrying any of this.
    #[serde(default)]
    pub destroys: Vec<String>,
    /// Why the body could not be read, when it could not.
    #[serde(default)]
    pub body_error: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Hit {
    #[serde(flatten)]
    pub note: Note,
    #[serde(default)]
    pub context: String,
}

#[derive(Serialize)]
struct WriteRequest<'a> {
    markdown: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    folder: &'a str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    force: bool,
}

#[derive(Debug, Deserialize, Default)]
pub struct WriteResponse {
    #[serde(default)]
    pub uuid: String,
    #[serde(default)]
    pub degraded: Vec<String>,
    #[serde(default)]
    pub detail: String,
}

/// A refusal carries what would be lost, so the caller can offer to force it
/// rather than reconstruct the reason from prose.
#[derive(Debug)]
pub enum Error {
    /// The daemon declined the write because it would destroy content.
    Refused { message: String, destroys: Vec<String> },
    Http(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Refused { message, .. } => write!(f, "{message}"),
            Error::Http(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone)]
pub struct Client {
    base: String,
    token: String,
    http: reqwest::blocking::Client,
}

impl Client {
    /// Reads the same configuration the notes CLI uses, so a machine already
    /// set up for one needs nothing further for the other.
    pub fn from_env() -> std::result::Result<Self, String> {
        let base = std::env::var("NOTESD_URL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            // A desktop launcher starts with almost no environment, so the URL
            // has to be readable from disk as well -- the same place, and the
            // same convention, as the token.
            .or_else(|| config_file("url"))
            .ok_or_else(|| {
                "No daemon configured.\n\nSet NOTESD_URL, or put the daemon's URL in \
                 ~/.config/applenotes/url"
                    .to_string()
            })?;

        let token = std::env::var("NOTESD_TOKEN")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| config_file("token"))
            .ok_or_else(|| {
                "No token.\n\nSet NOTESD_TOKEN, or put the token in \
                 ~/.config/applenotes/token"
                    .to_string()
            })?;

        let http = reqwest::blocking::Client::builder()
            // A tailnet hop to a sleeping Mac should fail in seconds, not hang
            // the window for a minute.
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;

        Ok(Self { base: base.trim_end_matches('/').to_string(), token, http })
    }

    pub fn folders(&self) -> Result<Vec<Folder>> {
        self.get("/v1/folders", &[])
    }

    pub fn notes(&self, folder: &str, deleted: bool) -> Result<Vec<Note>> {
        let mut q: Vec<(&str, String)> = Vec::new();
        if !folder.is_empty() {
            q.push(("folder", folder.to_string()));
        }
        if deleted {
            q.push(("deleted", "true".into()));
        }
        self.get("/v1/notes", &q)
    }

    pub fn note(&self, uuid: &str) -> Result<Note> {
        self.get(&format!("/v1/notes/{uuid}"), &[])
    }

    pub fn search(&self, query: &str, folder: &str) -> Result<Vec<Hit>> {
        let mut q = vec![("q", query.to_string())];
        if !folder.is_empty() {
            q.push(("folder", folder.to_string()));
        }
        self.get("/v1/search", &q)
    }

    pub fn replace(&self, uuid: &str, markdown: &str, force: bool) -> Result<WriteResponse> {
        let url = format!("{}/v1/notes/{uuid}", self.base);
        let body = WriteRequest { markdown, folder: "", force };
        let resp = self
            .http
            .put(url)
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .map_err(|e| Error::Http(e.to_string()))?;
        self.decode(resp)
    }

    pub fn create(&self, folder: &str, markdown: &str) -> Result<WriteResponse> {
        let url = format!("{}/v1/notes", self.base);
        let body = WriteRequest { markdown, folder, force: false };
        let resp = self
            .http
            .post(url)
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .map_err(|e| Error::Http(e.to_string()))?;
        self.decode(resp)
    }

    fn get<T: serde::de::DeserializeOwned>(&self, path: &str, query: &[(&str, String)]) -> Result<T> {
        let resp = self
            .http
            .get(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .query(query)
            .send()
            .map_err(|e| Error::Http(e.to_string()))?;
        self.decode(resp)
    }

    fn decode<T: serde::de::DeserializeOwned>(&self, resp: reqwest::blocking::Response) -> Result<T> {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        if status.is_success() {
            // 202 with an empty body is how the daemon says "accepted, but
            // Notes.app has not written it yet"; decode that as the default
            // rather than an error.
            if body.trim().is_empty() {
                return serde_json::from_str("null")
                    .or_else(|_| serde_json::from_str("{}"))
                    .map_err(|e| Error::Http(e.to_string()));
            }
            return serde_json::from_str(&body).map_err(|e| {
                Error::Http(format!("the daemon returned something unexpected: {e}"))
            });
        }

        #[derive(Deserialize, Default)]
        struct ErrBody {
            #[serde(default)]
            error: String,
            #[serde(default)]
            detail: String,
            #[serde(default)]
            destroys: Vec<String>,
        }
        let e: ErrBody = serde_json::from_str(&body).unwrap_or_default();
        let message = if !e.error.is_empty() {
            if e.detail.is_empty() { e.error } else { format!("{}: {}", e.error, e.detail) }
        } else {
            format!("{status}")
        };
        if !e.destroys.is_empty() {
            return Err(Error::Refused { message, destroys: e.destroys });
        }
        Err(Error::Http(message))
    }
}

/// Reads a single-line setting from ~/.config/applenotes/<name>.
fn config_file(name: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::Path::new(&home).join(".config/applenotes").join(name);
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
