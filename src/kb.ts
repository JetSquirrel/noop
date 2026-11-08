// The owner's SiYuan notes as a local, read-only knowledge base. The index lives in HOME_DIR/kb (next to the data mirror,
// never inside it), so notes stay on the machine that holds them: only what an agent quotes in a result crosses the Worker.
// SiYuan's own files are only ever read. Which machine has one is decided by config.local.toml: [kb] siyuan_dir, notebooks.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Cfg, CODE, HOME_DIR, P, loadConfig } from "./core";

const NOTEBOOK_DIR = /^\d{14}-[a-z0-9]{7}$/;
const MAX_CHUNK = 1600;
/** An index this old is refreshed before a search; a refresh only re-reads the notes that changed. */
const STALE_MS = 10 * 60_000;

const expand = (p: string) => resolve(p.replace(/^~/, homedir()));
const dbFile = () => join(HOME_DIR, "kb", "index.sqlite");

export type KbConfig = { data: string; notebooks: string[] };

/** This machine's knowledge base, or null when it has none. */
export function kbConfig(cfg: Cfg): KbConfig | null {
  const dir = cfg.kb?.siyuan_dir;
  if (typeof dir !== "string" || !dir.trim()) return null;
  const root = expand(dir);
  const data = existsSync(join(root, "data")) ? join(root, "data") : root;
  if (!existsSync(data)) return null;
  return { data, notebooks: Array.isArray(cfg.kb?.notebooks) ? cfg.kb.notebooks.map(String) : [] };
}

// ---------------------------------------------------------------- reading a .sy file

type SyNode = { ID?: string; Type?: string; Data?: string; TextMarkTextContent?: string; TextMarkInlineMathContent?: string; Properties?: Record<string, string>; Children?: SyNode[] };
export type Chunk = { heading: string; blockId: string; text: string };

const DATA_NODES = new Set(["NodeText", "NodeCodeBlockCode", "NodeMathBlockContent", "NodeCodeSpanContent", "NodeInlineMathContent", "NodeBackslashContent", "NodeLinkText"]);
const LINE_NODES = new Set(["NodeParagraph", "NodeHeading", "NodeListItem", "NodeCodeBlock", "NodeBlockquote", "NodeTableRow", "NodeTableHead", "NodeMathBlock", "NodeSuperBlock"]);
/** Pictures carry their alt text in a link-text child, which is not something anyone wrote. Embeds hold a query, not content. */
const SKIPPED_NODES = new Set(["NodeImage", "NodeBlockQueryEmbed", "NodeHTMLBlock", "NodeIFrame", "NodeWidget", "NodeKramdownSpanIAL", "NodeKramdownBlockIAL"]);

function textOf(n: SyNode): string {
  if (n.Type && SKIPPED_NODES.has(n.Type)) return "";
  if (n.Type === "NodeBr" || n.Type === "NodeSoftBreak") return "\n";
  let out = "";
  if (n.Type === "NodeTextMark") out += n.TextMarkTextContent || n.TextMarkInlineMathContent || "";
  else if (n.Type && DATA_NODES.has(n.Type)) out += n.Data ?? "";
  for (const c of n.Children ?? []) out += textOf(c);
  if (n.Type === "NodeTableCell") out += " | ";
  return n.Type && LINE_NODES.has(n.Type) && !out.endsWith("\n") ? `${out}\n` : out;
}

function split(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_CHUNK) {
    const cut = rest.lastIndexOf("\n", MAX_CHUNK);
    const at = cut > MAX_CHUNK / 2 ? cut : MAX_CHUNK;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** A document's title and its text, cut at its headings. */
export function readSy(doc: SyNode): { title: string; updated: string; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  let heading = "", blockId = doc.ID ?? "", buffer = "";
  const flush = () => { for (const text of split(buffer)) chunks.push({ heading, blockId, text }); buffer = ""; };
  for (const block of doc.Children ?? []) {
    if (block.Type === "NodeHeading") { flush(); heading = textOf(block).trim(); blockId = block.ID ?? blockId; continue; }
    buffer += textOf(block);
  }
  flush();
  return { title: doc.Properties?.title ?? "", updated: doc.Properties?.updated ?? "", chunks };
}

function notebooksIn(kb: KbConfig): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const e of readdirSync(kb.data, { withFileTypes: true })) {
    if (!e.isDirectory() || !NOTEBOOK_DIR.test(e.name)) continue;
    let name = e.name;
    try { name = JSON.parse(readFileSync(join(kb.data, e.name, ".siyuan", "conf.json"), "utf8")).name || e.name; } catch {}
    out.push({ id: e.name, name });
  }
  return out;
}

/** Every notebook in a SiYuan folder, for `noop kb setup` to check names against. */
export const listNotebooks = (dir: string) => notebooksIn({ data: existsSync(join(expand(dir), "data")) ? join(expand(dir), "data") : expand(dir), notebooks: [] });

function syFiles(dir: string, ancestors: string[] = [], out: { file: string; id: string; ancestors: string[] }[] = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) syFiles(full, [...ancestors, e.name], out);
    else if (e.name.endsWith(".sy")) out.push({ file: full, id: e.name.slice(0, -3), ancestors });
  }
  return out;
}

// ---------------------------------------------------------------- the index

function open(): Database {
  mkdirSync(join(HOME_DIR, "kb"), { recursive: true });
  const db = new Database(dbFile());
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, notebook TEXT NOT NULL, title TEXT NOT NULL, hpath TEXT NOT NULL, file TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, updated TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS chunks (seq INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, block_id TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS chunks_doc ON chunks (doc_id)");
  db.run("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  return db;
}

export type IndexReport = { docs: number; changed: number; removed: number; failed: number };

/** Bring the index up to date. Only notes whose size or mtime changed are read again; `full` rebuilds it. */
export function indexKb(kb: KbConfig, full = false): IndexReport {
  if (full) for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile() + suffix, { force: true });
  const db = open();
  try {
    const wanted = notebooksIn(kb).filter((n) => !kb.notebooks.length || kb.notebooks.includes(n.name));
    const known = new Map((db.query("SELECT id, mtime, size FROM docs").all() as { id: string; mtime: number; size: number }[]).map((d) => [d.id, d]));
    const seen = new Set<string>();
    const insertDoc = db.prepare("INSERT OR REPLACE INTO docs (id, notebook, title, hpath, file, mtime, size, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertChunk = db.prepare("INSERT INTO chunks (doc_id, block_id, heading, text) VALUES (?, ?, ?, ?)");
    const removeChunks = db.prepare("DELETE FROM chunks WHERE doc_id = ?");
    const removeDoc = db.prepare("DELETE FROM docs WHERE id = ?");
    const report: IndexReport = { docs: 0, changed: 0, removed: 0, failed: 0 };
    const paths: { id: string; notebook: string; ancestors: string[] }[] = [];
    db.transaction(() => {
      for (const nb of wanted) {
        for (const f of syFiles(join(kb.data, nb.id))) {
          seen.add(f.id);
          paths.push({ id: f.id, notebook: nb.name, ancestors: f.ancestors });
          const st = statSync(f.file), old = known.get(f.id);
          if (old && old.mtime === st.mtimeMs && old.size === st.size) continue;
          let parsed: ReturnType<typeof readSy>;
          try { parsed = readSy(JSON.parse(readFileSync(f.file, "utf8"))); } catch { report.failed++; continue; }
          removeChunks.run(f.id);
          insertDoc.run(f.id, nb.name, parsed.title, "", f.file, st.mtimeMs, st.size, parsed.updated);
          for (const c of parsed.chunks) insertChunk.run(f.id, c.blockId, c.heading, c.text);
          report.changed++;
        }
      }
      for (const id of known.keys()) if (!seen.has(id)) { removeChunks.run(id); removeDoc.run(id); report.removed++; }
      const titles = new Map((db.query("SELECT id, title FROM docs").all() as { id: string; title: string }[]).map((d) => [d.id, d.title]));
      const setPath = db.prepare("UPDATE docs SET hpath = ? WHERE id = ?");
      for (const p of paths) setPath.run([p.notebook, ...p.ancestors.map((a) => titles.get(a) ?? a), titles.get(p.id) ?? p.id].join("/"), p.id);
      db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('indexed_at', ?)", [String(Date.now())]);
    })();
    report.docs = (db.query("SELECT COUNT(*) AS n FROM docs").get() as { n: number }).n;
    return report;
  } finally { db.close(); }
}

export type KbStatus = { docs: number; chunks: number; indexedAt: string | null; notebooks: Record<string, number> };

export function kbStatus(): KbStatus {
  const db = open();
  try {
    const at = db.query("SELECT v FROM meta WHERE k = 'indexed_at'").get() as { v: string } | null;
    const notebooks = Object.fromEntries((db.query("SELECT notebook, COUNT(*) AS n FROM docs GROUP BY notebook").all() as { notebook: string; n: number }[]).map((r) => [r.notebook, r.n]));
    return {
      docs: (db.query("SELECT COUNT(*) AS n FROM docs").get() as { n: number }).n,
      chunks: (db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n,
      indexedAt: at ? new Date(Number(at.v)).toISOString() : null, notebooks,
    };
  } finally { db.close(); }
}

function refreshIfStale(kb: KbConfig) {
  const db = open();
  const at = db.query("SELECT v FROM meta WHERE k = 'indexed_at'").get() as { v: string } | null;
  db.close();
  if (!at || Date.now() - Number(at.v) > STALE_MS) indexKb(kb);
}

export type KbHit = { doc: string; block: string; title: string; path: string; heading: string; snippet: string; link: string; score: number };
type Row = { doc_id: string; block_id: string; heading: string; text: string; title: string; hpath: string };

const occurrences = (hay: string, needle: string) => { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; } return n; };
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function snippetOf(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => { const i = lower.indexOf(t); return i < 0 ? Infinity : i; }));
  const start = Number.isFinite(at) ? Math.max(0, at - 60) : 0;
  return `${start ? "…" : ""}${text.slice(start, start + 240).replace(/\s+/g, " ").trim()}${start + 240 < text.length ? "…" : ""}`;
}

/** Plain LIKE over the chunks: the notes are small, and unlike a trigram index this also finds two-character Chinese words. */
export function searchKb(kb: KbConfig, query: string, limit = 8): KbHit[] {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (!terms.length) return [];
  refreshIfStale(kb);
  const db = open();
  try {
    const find = (join: "AND" | "OR") => db.query(
      `SELECT c.doc_id, c.block_id, c.heading, c.text, d.title, d.hpath FROM chunks c JOIN docs d ON d.id = c.doc_id
       WHERE ${terms.map(() => `(d.title || ' ' || c.heading || ' ' || c.text) LIKE ? ESCAPE '\\'`).join(` ${join} `)} LIMIT 3000`,
    ).all(...terms.map((t) => `%${escapeLike(t)}%`)) as Row[];
    let rows = find("AND");
    if (!rows.length && terms.length > 1) rows = find("OR"); // a whole sentence rarely has every word in one section
    const scored = rows.map((r) => {
      const title = r.title.toLowerCase(), heading = r.heading.toLowerCase(), text = r.text.toLowerCase();
      const score = terms.reduce((sum, t) => sum + (title.includes(t) ? 8 : 0) + (heading.includes(t) ? 4 : 0) + Math.min(occurrences(text, t), 5), 0);
      return { r, score };
    }).sort((a, b) => b.score - a.score);
    const perDoc = new Map<string, number>(), hits: KbHit[] = [];
    for (const { r, score } of scored) {
      const n = perDoc.get(r.doc_id) ?? 0;
      if (n >= 2) continue;
      perDoc.set(r.doc_id, n + 1);
      hits.push({ doc: r.doc_id, block: r.block_id, title: r.title, path: r.hpath, heading: r.heading, snippet: snippetOf(r.text, terms), link: `siyuan://blocks/${r.block_id}`, score });
      if (hits.length >= limit) break;
    }
    return hits;
  } finally { db.close(); }
}

export type KbDoc = { id: string; title: string; path: string; link: string; text: string; truncated: boolean };

/** One note in full (at most maxChars), by its document id or any heading's block id. */
export function showKb(kb: KbConfig, id: string, maxChars = 20_000): KbDoc | null {
  refreshIfStale(kb);
  const db = open();
  try {
    const owner = db.query("SELECT doc_id FROM chunks WHERE block_id = ? LIMIT 1").get(id) as { doc_id: string } | null;
    const docId = owner?.doc_id ?? id;
    const doc = db.query("SELECT id, title, hpath FROM docs WHERE id = ?").get(docId) as { id: string; title: string; hpath: string } | null;
    if (!doc) return null;
    const chunks = db.query("SELECT heading, text FROM chunks WHERE doc_id = ? ORDER BY seq").all(docId) as { heading: string; text: string }[];
    let last = "", full = "";
    for (const c of chunks) { if (c.heading && c.heading !== last) full += `\n## ${c.heading}\n`; last = c.heading; full += `${c.text}\n`; }
    return { id: doc.id, title: doc.title, path: doc.hpath, link: `siyuan://blocks/${doc.id}`, text: full.trim().slice(0, maxChars), truncated: full.trim().length > maxChars };
  } finally { db.close(); }
}

// ---------------------------------------------------------------- setup and what agents are told

const SECTION = (name: string) => new RegExp(`^\\[${name}\\][^\\[]*`, "m");

/** Writes one section of config.local.toml, the per-machine config that is never synced. */
export function setLocalSection(name: string, body: string) {
  const file = P("config.local.toml");
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = `[${name}]\n${body.trim()}\n\n`;
  const next = SECTION(name).test(old) ? old.replace(SECTION(name), block) : `${old.replace(/\s*$/, "")}${old.trim() ? "\n\n" : ""}${block}`;
  writeFileSync(file, next);
}

export function setupKb(dir: string, notebooks: string[]): { name: string }[] {
  const all = listNotebooks(dir);
  const unknown = notebooks.filter((n) => !all.some((b) => b.name === n));
  if (unknown.length) throw new Error(`no such notebook: ${unknown.join(", ")} (found: ${all.map((b) => b.name).join(", ")})`);
  setLocalSection("kb", `siyuan_dir = ${JSON.stringify(expand(dir).replace(/\\/g, "/"))}\nnotebooks = ${JSON.stringify(notebooks)}`);
  return all.filter((b) => !notebooks.length || notebooks.includes(b.name));
}

export function kbCli(cfg: Cfg, args: string[]) {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { full: { type: "boolean" }, json: { type: "boolean" }, n: { type: "string", short: "n" }, notebooks: { type: "string" } } });
  if (sub === "setup") {
    if (!positionals[0] || !existsSync(expand(positionals[0]))) { console.error("usage: noop kb setup <siyuan-dir> [--notebooks 知识库,Inbox]"); process.exitCode = 1; return; }
    const chosen = setupKb(positionals[0], (values.notebooks ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    console.log(`✔ knowledge base: ${chosen.map((b) => b.name).join(", ")} (kept in config.local.toml; notes stay on this machine)`);
    const kb = kbConfig(loadConfig());
    if (kb) console.log(JSON.stringify(indexKb(kb, true)));
    return;
  }
  const kb = kbConfig(cfg);
  if (!kb) { console.error("this machine has no knowledge base: noop kb setup <siyuan-dir>"); process.exitCode = 1; return; }
  if (sub === "index") { console.log(JSON.stringify(indexKb(kb, !!values.full))); return; }
  if (sub === "status") { console.log(JSON.stringify(kbStatus())); return; }
  if (sub === "search") {
    const hits = searchKb(kb, positionals.join(" "), Number(values.n) || 8);
    if (values.json) { console.log(JSON.stringify(hits)); return; }
    if (!hits.length) console.log("no matching notes");
    for (const h of hits) console.log(`${h.path}${h.heading ? ` › ${h.heading}` : ""}\n  ${h.link}\n  ${h.snippet}\n`);
    return;
  }
  if (sub === "show" && positionals[0]) {
    const d = showKb(kb, positionals[0]);
    if (!d) { console.error("no such note"); process.exitCode = 1; return; }
    console.log(`# ${d.title}\n${d.path}\n${d.link}\n\n${d.text}${d.truncated ? "\n\n(truncated)" : ""}`);
    return;
  }
  console.error("usage: noop kb setup|index|status|search|show");
  process.exitCode = 1;
}

/** The section of an agent's prompt that tells it about the notes, on a machine that has them. */
export function kbPrompt(cfg: Cfg): string {
  if (!kbConfig(cfg)) return "";
  const noop = `bun "${join(CODE, "src", "cli.ts").replace(/\\/g, "/")}"`;
  return `# The owner's knowledge base (on this machine only)
Search the owner's notes when the task could benefit from what they already wrote:
  ${noop} kb search "架构 同步"     (words separated by spaces; --json for machine-readable output)
  ${noop} kb show <doc or block id>
Results carry a siyuan:// link; cite the notes you used. The notes are private and read-only: never modify the note files, and never copy a whole note into the hub folder, a commit, a PR or anything else that leaves this machine. Summarize instead, and quote only short passages you actually need.`;
}
