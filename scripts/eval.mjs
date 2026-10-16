// Score the pipeline against hand-written ground truth (corpus/expected.json):
//  1. extraction: precision/recall of ownership claims and decisions found by Nemotron + quote checks;
//  2. policy: the owner the live graph policy names for every service and date (or that it abstains);
//  3. typed questions: end-to-end answers to typed questions, routed by the offline rules (no model, reproducible).
// Usage: node --env-file-if-exists=.env scripts/eval.mjs [--online] [--write]   (needs a seeded graph for parts 2 and 3;
//        --online also asks the typed questions through the configured model)
import {readFileSync, writeFileSync} from "node:fs";
import {CORPUS_DIR} from "../src/corpus.mjs";
import {openGraph} from "../src/db.mjs";
import {ownerOfService} from "../src/decision.mjs";
import {askCompanyBrain} from "../src/agent.mjs";
import {modelFromEnv, OFFLINE_MODEL} from "../src/hosted-model.mjs";

const owners = r => Object.fromEntries((r.services || []).map(s => [s.serviceId, s.owner?.id || "ABSTAIN"]));
// Typed questions and what a correct answer must contain. The clock is fixed so dates are reproducible.
const QUESTIONS = [
  ["Who should sign off the Orion release?", r => owners(r)["billing-gateway"] === "ben"],
  ["Who owned the billing gateway on September 25, 2026?", r => owners(r)["billing-gateway"] === "aria"],
  ["Who owned the billing gateway on 9/25/2026?", r => owners(r)["billing-gateway"] === "aria"],
  ["Who owns billing?", r => owners(r)["billing-gateway"] === "ben"],
  ["Who owns checkout?", r => owners(r)["checkout-web"] === "kai"],
  ["Who owns everything Project Atlas depends on?", r => JSON.stringify(owners(r)) ===
    JSON.stringify({"checkout-web": "kai", "ledger-service": "omar", "payments-api": "ABSTAIN"})],
  ["Who is responsible for Lyra's search index?", r => owners(r)["search-index"] === "ABSTAIN"],
  ["Who owns the mobile app?", r => owners(r)["mobile-app"] === "ABSTAIN"],
  ["Who knows the most about the search index?", r => r.people?.[0]?.id === "tara" && r.busFactor === 1],
  ["Who knows Kafka best?", r => r.people?.[0]?.id === "vik"],
  ["Why did we stop publishing ledger events through Kafka (ADR-007)?", r => r.current === "ADR-012"],
  ["What did we decide about Kafka?", r => String(r.current).includes("ADR-012")],
  ["What does Omar own?", r => r.owns?.map(o => o.serviceId).join() === "ledger-service"],
  ["Who leads the Payments team?", r => r.lead?.id === "nora"],
  ["Which records mention dunning?", r => r.status === "FOUND" && r.results.length > 0],
  ["Who owned the billing gateway 3 weeks ago?", r => r.reason === "AMBIGUOUS_TIME"],
  ["Who owns Project Zeus?", r => r.status !== "OWNER" && !r.services],
  ["What is the weather in Hanoi?", r => r.status === "OUT_OF_SCOPE"]
];

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
  const typed = [];
  for (const [question, ok] of QUESTIONS) {
    const r = await askCompanyBrain({model: OFFLINE_MODEL, graph, question, now: new Date("2026-10-16T12:00:00Z")});
    typed.push({question, tool: r.tool || null, status: r.status, reason: r.reason || null, ok: Boolean(ok(r))});
  }
  report.typedQuestions = {mode: "offline routing rules", correct: typed.filter(t => t.ok).length, total: typed.length, rows: typed};
  if (process.argv.includes("--online")) {
    const {model, modelId} = await modelFromEnv();
    const online = [];
    for (const [question, ok] of QUESTIONS) {
      const r = await askCompanyBrain({model, graph, question, now: new Date("2026-10-16T12:00:00Z")});
      online.push({question, tool: r.tool || null, status: r.status, reason: r.reason || null,
        explanationSource: r.explanationSource, ok: Boolean(ok(r))});
    }
    report.typedQuestionsOnline = {mode: modelId, correct: online.filter(t => t.ok).length, total: online.length,
      modelExplanationsKept: online.filter(t => t.explanationSource === "model").length, rows: online};
  }
} finally { await close(); }

console.log(JSON.stringify({
  ownership: {precision: report.ownership.precision, recall: report.ownership.recall, missed: report.ownership.missed, spurious: report.ownership.spurious},
  decisions: {precision: report.decisions.precision, recall: report.decisions.recall, missed: report.decisions.missed, spurious: report.decisions.spurious},
  rejectedByChecks: rejected.length,
  policyChecks: `${report.answers.correct}/${report.answers.total}`,
  wrongPolicy: report.answers.rows.filter(r => !r.ok),
  typedQuestions: `${report.typedQuestions.correct}/${report.typedQuestions.total}`,
  wrongTyped: report.typedQuestions.rows.filter(r => !r.ok),
  ...(report.typedQuestionsOnline ? {typedOnline: `${report.typedQuestionsOnline.correct}/${report.typedQuestionsOnline.total}`,
    modelExplanationsKept: report.typedQuestionsOnline.modelExplanationsKept,
    wrongOnline: report.typedQuestionsOnline.rows.filter(r => !r.ok)} : {})
}, null, 1));
if (process.argv.includes("--write")) {
  writeFileSync(new URL("../evidence/eval.json", import.meta.url), JSON.stringify(report, null, 1) + "\n");
}
