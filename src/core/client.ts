import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * The notesd client.
 *
 * Deliberately thin. How a note converts to Markdown, and what a rewrite would
 * cost, are already decided on the daemon side; answering them again here would
 * mean two answers to the same question, diverging the first time either
 * changes.
 *
 * This lives in main rather than the renderer so the token never reaches a
 * window, and so a hung Mac cannot wedge the UI thread.
 */
export interface Note {
  uuid: string;
  title: string;
  folder: string;
  modified: string;
  pinned?: boolean;
  locked?: boolean;
  trashed?: boolean;
  shared?: boolean;
  sharedWithMe?: boolean;
  owner?: string;
  markdown?: string;
  degrades?: string[];
  destroys?: string[];
  bodyError?: string;
}

export interface Folder {
  uuid: string;
  name: string;
  trash?: boolean;
}

export class Refused extends Error {
  // Written longhand rather than as a parameter property: Node strips types
  // without transforming, so a parameter property is a syntax error at load.
  readonly destroys: string[];
  constructor(message: string, destroys: string[]) {
    super(message);
    this.destroys = destroys;
  }
}

function configFile(name: string): string {
  try {
    return readFileSync(path.join(os.homedir(), ".config/applenotes", name), "utf8").trim();
  } catch {
    return "";
  }
}

export class Client {
  readonly base: string;
  private readonly token: string;

  constructor() {
    // The same files the notes CLI uses, so a machine set up for one needs
    // nothing further for the other.
    this.base = (process.env["NOTESD_URL"] || configFile("url")).replace(/\/+$/, "");
    this.token = process.env["NOTESD_TOKEN"] || configFile("token");
  }

  get configured(): boolean {
    return this.base.length > 0 && this.token.length > 0;
  }

  private async call<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    if (!this.configured) {
      throw new Error(
        "No daemon configured. Put its URL in ~/.config/applenotes/url and the token beside it.",
      );
    }
    let res: Response;
    try {
      res = await fetch(this.base + pathname, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A tailnet hop to a sleeping Mac should fail in seconds, not hang.
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new Error(`Cannot reach the daemon at ${this.base}`, { cause: e });
    }

    const text = await res.text();
    if (res.ok) {
      if (!text.trim()) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error("The daemon returned something unexpected");
      }
    }

    let err: { error?: string; detail?: string; destroys?: string[] } = {};
    try {
      err = JSON.parse(text);
    } catch {
      /* the status line is all there is */
    }
    const message = err.error
      ? err.detail
        ? `${err.error}: ${err.detail}`
        : err.error
      : `HTTP ${res.status}`;
    // Typed, so a caller can offer the override rather than reconstruct the
    // reason from prose.
    if (err.destroys?.length) throw new Refused(message, err.destroys);
    throw new Error(message);
  }

  folders(): Promise<Folder[]> {
    return this.call<Folder[]>("GET", "/v1/folders");
  }

  notes(folder = ""): Promise<Note[]> {
    const q = folder ? `?folder=${encodeURIComponent(folder)}` : "";
    return this.call<Note[]>("GET", `/v1/notes${q}`);
  }

  note(uuid: string): Promise<Note> {
    return this.call<Note>("GET", `/v1/notes/${encodeURIComponent(uuid)}`);
  }

  search(query: string): Promise<Note[]> {
    return this.call<Note[]>("GET", `/v1/search?q=${encodeURIComponent(query)}`);
  }

  replace(uuid: string, markdown: string, allowShared: boolean): Promise<{ degraded?: string[] }> {
    return this.call("PUT", `/v1/notes/${encodeURIComponent(uuid)}`, {
      markdown,
      allowShared,
    });
  }

  create(folder: string, markdown: string): Promise<{ uuid?: string }> {
    return this.call("POST", "/v1/notes", { markdown, folder });
  }
}
