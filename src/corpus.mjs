// Loads the synthetic Larkspur Systems corpus (docs, tickets, chat, HR, catalog) into one list of
// sources. Every fact the graph holds later points back to one of these sources.
import {readFileSync, readdirSync, existsSync} from "node:fs";
import {join} from "node:path";

// How much each kind of record is trusted when sources disagree (0..100).
export const AUTHORITY = Object.freeze({
  "change-control": 90, adr: 85, directory: 80, runbook: 70, ticket: 60, chat: 35, wiki: 20
});
// Below this, a source may be shown as evidence but can never name an owner on its own.
export const MIN_NAMING_AUTHORITY = 60;

export const CORPUS_DIR = new URL("../corpus/", import.meta.url);

const ID = /^[A-Za-z0-9][A-Za-z0-9#._-]{0,63}$/;
export const validSourceId = s => typeof s === "string" && ID.test(s);
export const validTime = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s));

export function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) throw new Error("doc without frontmatter");
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return {meta, body: m[2].trim()};
}

function source({id, kind, title, author, at, text, ...rest}) {
  if (!validSourceId(id)) throw new Error("bad source id " + id);
  if (!(kind in AUTHORITY)) throw new Error(`unknown kind ${kind} for ${id}`);
  if (!validTime(at)) throw new Error(`bad time for ${id}`);
  return {id, kind, authority: AUTHORITY[kind], title: title || id, author: author || null, at, text: String(text || ""), ...rest};
}

/** One source from a doc markdown string (used for corpus docs and live uploads). */
export function docSource(md) {
  const {meta, body} = parseFrontmatter(md);
  return source({id: meta.id, kind: meta.kind, title: meta.title, author: meta.author, at: meta.date, text: body, format: "doc"});
}

/** Tickets become one source for the ticket body and one per comment, each with its own author and time. */
export function ticketSources(t) {
  const base = source({
    id: t.id, kind: "ticket", title: `${t.id}: ${t.title}`, author: t.reporter, at: t.createdAt,
    text: `${t.title}\n\n${t.body || ""}`, format: "ticket", ticketId: t.id, serviceId: t.serviceId || null,
    topicIds: t.topicIds || [], reporter: t.reporter || null, assignee: t.assignee || null,
    resolvedBy: t.resolvedBy || null, status: t.status || null
  });
  const comments = (t.comments || []).map((c, i) => source({
    id: `${t.id}#c${i + 1}`, kind: "ticket", title: `${t.id} comment ${i + 1}`, author: c.author, at: c.at,
    text: c.text, format: "comment", ticketId: t.id, serviceId: t.serviceId || null, topicIds: []
  }));
  return [base, ...comments];
}

export function chatSource(m) {
  return source({id: m.id, kind: "chat", title: `${m.channel} · ${m.author}`, author: m.author, at: m.at,
    text: m.text, format: "chat", channel: m.channel});
}

/** A live item (corpus/live/*.json or the UI) as a source. */
export function liveSource(item) {
  if (item?.format === "chat") return chatSource(item);
  if (item?.format === "doc") {
    return source({id: item.id, kind: item.kind, title: item.title, author: item.author, at: item.date, text: item.text, format: "doc"});
  }
  throw new Error("live item format must be chat or doc");
}

const readJson = (dir, f) => JSON.parse(readFileSync(join(dir, f), "utf8"));

export function loadCorpus(dir = CORPUS_DIR) {
  const base = dir instanceof URL ? dir.pathname.replace(/^\/([A-Za-z]:)/, "$1") : dir;
  const org = readJson(base, "people.json");
  const catalog = readJson(base, "catalog.json");
  const docsDir = join(base, "docs");
  const docs = readdirSync(docsDir).filter(f => f.endsWith(".md")).sort()
    .map(f => docSource(readFileSync(join(docsDir, f), "utf8")));
  const tickets = readJson(base, "tickets.json").flatMap(ticketSources);
  const chat = readJson(base, "chat.json").map(chatSource);
  const liveDir = join(base, "live");
  const live = existsSync(liveDir)
    ? readdirSync(liveDir).filter(f => f.endsWith(".json")).sort().map(f => readJson(liveDir, f))
    : [];
  const sources = [...docs, ...tickets, ...chat];
  const ids = new Set();
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error("duplicate source id " + s.id);
    ids.add(s.id);
  }
  return {org, catalog, sources, live};
}

// ---------------------------------------------------------------------------------------------
// Name matching used by both the extractor's quote check and the agent's grounding check.

export const firstName = s => String(s || "").trim().split(/\s+/)[0];

export function personNames(p) {
  return [firstName(p.name), p.name, p.id].filter(Boolean).map(s => s.toLowerCase());
}

export function entityNames(e) {
  return [e.name, e.id, e.id?.replaceAll("-", " "), ...(e.aliases || [])]
    .filter(Boolean).map(s => s.toLowerCase());
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, case-insensitive match of any name in text. */
export function mentions(text, names) {
  const t = String(text || "").toLowerCase();
  return names.some(n => n && new RegExp(`(^|[^a-z0-9])${escapeRe(n)}($|[^a-z0-9])`).test(t));
}

export const normalize = s => String(s || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
