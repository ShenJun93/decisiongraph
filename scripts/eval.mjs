// Score the pipeline against hand-written ground truth (corpus/expected.json):
//  1. extraction: precision/recall of ownership claims and decisions found by Nemotron + quote checks;
//  2. answers: the owner the live graph policy names for every service (or that it abstains).
// Usage: node scripts/eval.mjs [--write]   (needs a seeded graph for part 2)
import {readFileSync, writeFileSync} from "node:fs";
import {CORPUS_DIR} from "../src/corpus.mjs";
import {openGraph} from "../src/db.mjs";
import {ownerOfService} from "../src/decision.mjs";

const read = f => JSON.parse(readFileSync(new URL(f, CORPUS_DIR), "utf8"));
const expected = read("expected.json");
const extracted = read("extracted.json");

function score(found, truth, key) {
  const f = new Set(found.map(key)), t = new Set(truth.map(key));
  const hit = [...f].filter(x => t.has(x));
  return {found: f.size, expected: t.size, correct: hit.length,
    precision: f.size ? +(hit.length / f.size).toFixed(3) : 1, recall: t.size ? +(hit.length / t.size).toFixed(3) : 1,
    missed: [...t].filter(x => !f.has(x)), spurious: [...f].filter(x => !t.has(x))};
}

const foundOwnership = Object.entries(extracted.results).flatMap(([sourceId, r]) =>
  (r?.ownership || []).map(o => ({sourceId, ...o})));
const foundDecisions = Object.entries(extracted.results).flatMap(([sourceId, r]) =>
  (r?.decisions || []).map(d => ({sourceId, ...d})));
const rejected = Object.entries(extracted.results).flatMap(([sourceId, r]) =>
  (r?.rejected || []).map(x => ({sourceId, type: x.type, reason: x.reason})));

const report = {
  model: extracted.model, extractedAt: extracted.extractedAt,
  ownership: score(foundOwnership, expected.ownership, o => `${o.sourceId}|${o.serviceId}|${o.ownerId}`),
  decisions: score(foundDecisions, expected.decisions, d => `${d.sourceId}|${String(d.decisionId).toUpperCase()}|${d.decidedBy}|${d.supersedes || "-"}`),
  rejectedByChecks: rejected,
  answers: null
};

const {graph, close} = await openGraph();
try {
  const rows = [];
  for (const [key, want] of Object.entries(expected.answers)) {
    const [serviceId, asOf] = key.split("@");
    const r = await ownerOfService(graph, {serviceId, asOf});
    const got = r.status === "OWNER" ? r.owner.id : "ABSTAIN";
    rows.push({serviceId, asOf, expected: want, got, reason: r.reason || null, ok: got === want});
  }
  report.answers = {correct: rows.filter(r => r.ok).length, total: rows.length, rows};
} finally { await close(); }

console.log(JSON.stringify({
  ownership: {precision: report.ownership.precision, recall: report.ownership.recall, missed: report.ownership.missed, spurious: report.ownership.spurious},
  decisions: {precision: report.decisions.precision, recall: report.decisions.recall, missed: report.decisions.missed, spurious: report.decisions.spurious},
  rejectedByChecks: rejected.length,
  answers: `${report.answers.correct}/${report.answers.total}`,
  wrongAnswers: report.answers.rows.filter(r => !r.ok)
}, null, 1));
if (process.argv.includes("--write")) {
  writeFileSync(new URL("../evidence/eval.json", import.meta.url), JSON.stringify(report, null, 1) + "\n");
}
