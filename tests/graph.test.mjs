// Integration tests against a live FalkorDB (docker compose up -d graph). They use their own graph
// name and skip when the database or corpus/extracted.json is not available.
import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {openGraph} from "../src/db.mjs";
import {loadCorpus, liveSource} from "../src/corpus.mjs";
import {loadGraph, writeSources, deriveEdges} from "../src/graph-load.mjs";
import {ownerOfService, ownerOfProject} from "../src/decision.mjs";
import {whoKnows, traceDecision} from "../src/knowledge.mjs";
import {askCompanyBrain} from "../src/agent.mjs";

const extractedFile = new URL("../corpus/extracted.json", import.meta.url);
let conn = null;
try { if (existsSync(extractedFile)) conn = await openGraph({...process.env, GRAPH_NAME: "gh2026_decisiongraph_test"}); } catch { conn = null; }
const skip = conn ? false : "FalkorDB or corpus/extracted.json not available";
const corpus = loadCorpus();
const expected = JSON.parse(readFileSync(new URL("../corpus/expected.json", import.meta.url), "utf8"));
const extracted = conn ? JSON.parse(readFileSync(extractedFile, "utf8")).results : {};
const NOW = "2026-10-16T12:00:00Z";

test.after(async () => { if (conn) { try { await conn.graph.delete(); } catch {} await conn.close(); } });

test("seeded graph answers every expected ownership question", {skip}, async () => {
  await loadGraph(conn.graph, corpus, extracted);
  for (const [key, want] of Object.entries(expected.answers)) {
    const [serviceId, asOf] = key.split("@");
    const r = await ownerOfService(conn.graph, {serviceId, asOf});
    assert.equal(r.status === "OWNER" ? r.owner.id : "ABSTAIN", want, key + " " + (r.reason || ""));
  }
});

test("a project answer has one decision per service and never collapses a conflict", {skip}, async () => {
  const r = await ownerOfProject(conn.graph, {projectId: "atlas", asOf: NOW});
  assert.equal(r.status, "PARTIAL");
  assert.deepEqual(r.services.map(s => s.serviceId).sort(), ["checkout-web", "ledger-service", "payments-api"]);
  assert.equal(r.services.find(s => s.serviceId === "payments-api").reason, "UNRESOLVED_EQUAL_AUTHORITY_CONFLICT");
});

test("who knows the search index: Tara, with a bus-factor warning", {skip}, async () => {
  const r = await whoKnows(conn.graph, {subjectId: "search-index", asOf: NOW});
  assert.equal(r.people[0].id, "tara");
  assert.equal(r.busFactor, 1);
  assert.ok(r.busFactorWarning);
});

test("tracing ADR-007 finds it superseded by ADR-012, with its source quote and motivating ticket", {skip}, async () => {
  const r = await traceDecision(conn.graph, {subjectId: "ADR-007"});
  assert.equal(r.current, "ADR-012");
  const adr12 = r.decisions.find(d => d.id === "ADR-012");
  assert.equal(adr12.deciderId, "omar");
  assert.ok(adr12.quote);
  assert.ok(adr12.motivatedBy.includes("LED-41"));
});

// A scripted model: routes to a fixed tool call and returns a fixed explanation.
const scripted = (tool, subjectId, text) => async ({tools}) => tools
  ? {choices: [{message: {tool_calls: tool ? [{type: "function", function: {name: tool, arguments: JSON.stringify({subjectId})}}] : []}}]}
  : {choices: [{message: {content: text}}]};

test("agent: a dated question is answered as of that date", {skip}, async () => {
  const r = await askCompanyBrain({graph: conn.graph, now: new Date(NOW), question: "Who owned the billing gateway on September 25, 2026?",
    model: scripted("owner_of", "billing-gateway", "Aria owned the Billing Gateway then, per service-directory-2026-09.")});
  assert.equal(r.services[0].owner.id, "aria");
  assert.equal(r.explanationSource, "model");
});

test("agent: an entity the question does not name is refused, even if the model picks one", {skip}, async () => {
  const r = await askCompanyBrain({graph: conn.graph, now: new Date(NOW), question: "Who owns Project Zeus?",
    model: scripted("owner_of", "orion", "Ben owns it.")});
  assert.equal(r.reason, "NOT_IN_GRAPH");
});

test("agent: a model explanation that contradicts the graph is replaced by the template", {skip}, async () => {
  const r = await askCompanyBrain({graph: conn.graph, now: new Date(NOW), question: "Who should sign off the Orion release?",
    model: scripted("owner_of", "orion", "Aria owns the Billing Gateway and the release is approved.")});
  assert.equal(r.services[0].owner.id, "ben");
  assert.equal(r.explanationSource, "template");
  assert.ok(r.trace.some(s => s.step === "model_explanation_rejected"));
});

test("agent: off-topic questions get a scoped refusal, not an error", {skip}, async () => {
  const r = await askCompanyBrain({graph: conn.graph, now: new Date(NOW), question: "What is the weather in Hanoi?", model: scripted(null)});
  assert.equal(r.status, "OUT_OF_SCOPE");
  assert.match(r.explanation, /ownership|expertise|decision|who owns/i);
});

test("live update: chat cannot override change control, a new change-control record can", {skip}, async () => {
  const chat = liveSource(corpus.live.find(i => i.id === "live-chat-ben-handoff"));
  await writeSources(conn.graph, [chat], {[chat.id]: {ownership: [{serviceId: "billing-gateway", ownerId: "cora", quote: "handing billing gateway over to Cora"}], decisions: []}}, corpus);
  assert.equal((await ownerOfService(conn.graph, {serviceId: "billing-gateway", asOf: NOW})).owner.id, "ben");
  const cc = liveSource(corpus.live.find(i => i.id === "live-cc-1043"));
  await writeSources(conn.graph, [cc], {[cc.id]: {ownership: [{serviceId: "billing-gateway", ownerId: "cora", quote: "transferred to Cora"}], decisions: []}}, corpus);
  await deriveEdges(conn.graph);
  assert.equal((await ownerOfService(conn.graph, {serviceId: "billing-gateway", asOf: NOW})).owner.id, "cora");
  assert.equal((await ownerOfService(conn.graph, {serviceId: "billing-gateway", asOf: "2026-10-15T00:00:00Z"})).owner.id, "ben");
});
