import test from "node:test";
import assert from "node:assert/strict";
import {askCompanyBrain, explanationAgrees, templateExplanation, PROJECTS_CYPHER} from "../src/agent.mjs";
import {createHostedModel, validateHostedModelConfig, NVIDIA_ENDPOINT} from "../src/hosted-model.mjs";

const asOf = "2026-10-16T00:00:00.000Z";
const projects = [{id: "orion", name: "Project Orion"}, {id: "nova", name: "Project Nova"}];
const orionRows = [
  {projectId: "orion", serviceId: "billing-gateway", claimId: "claim-current", effectiveAt: "2026-10-14T11:00:00.000Z",
    sourceId: "change-control-oct", sourceRank: 90, ownerId: "ben", ownerName: "Ben (synthetic)"},
  {projectId: "orion", serviceId: "billing-gateway", claimId: "claim-chat", effectiveAt: "2026-10-14T16:00:00.000Z",
    sourceId: "chat-note-oct", sourceRank: 35, ownerId: "aria", ownerName: "Aria (synthetic)"}
];
const graph = (rows = orionRows) => ({
  calls: [],
  async query(q, opts) { this.calls.push(q); return q === PROJECTS_CYPHER ? projects : rows; }
});
const toolCall = args => ({choices: [{message: {tool_calls: [{id: "c1", type: "function",
  function: {name: "get_project_owner_evidence", arguments: JSON.stringify(args)}}]}}]});
const text = content => ({choices: [{message: {content}}]});

test("free-text question: model picks a graph project, graph decides, agreeing explanation is kept", async () => {
  const seen = [];
  const model = async req => {
    seen.push(req);
    return seen.length === 1 ? toolCall({projectId: "orion"}) : text("Ben is the current owner; this is a draft for review.");
  };
  const g = graph();
  const out = await askCompanyBrain({model, graph: g, question: "Who signs off Orion?", asOf});
  assert.equal(out.status, "HUMAN_REVIEW_DRAFT");
  assert.equal(out.currentOwner.id, "ben");
  assert.equal(out.explanationSource, "model");
  assert.deepEqual(seen[0].tools[0].function.parameters.properties.projectId.enum, ["orion", "nova"]);
  assert.equal(seen[0].tool_choice, "required");
  assert.equal(seen[1].tools, undefined, "explanation call offers no tools");
  assert.equal(out.authorizedExternalActions, false);
});

test("an explanation that names the wrong owner or approves is replaced by the template", async () => {
  for (const bad of ["Aria owns it.", "Ben owns it and the release is approved.", ""]) {
    let n = 0;
    const model = async () => (++n === 1 ? toolCall({projectId: "orion"}) : text(bad));
    const out = await askCompanyBrain({model, graph: graph(), question: "Who owns Orion?", asOf});
    assert.equal(out.explanationSource, "template", bad);
    assert.match(out.explanation, /^Ben is the current owner/);
    assert.ok(out.trace.some(s => s.step === "model_explanation_rejected"));
  }
});

test("a project that is not in the graph never reaches the ownership query", async () => {
  const g = graph();
  const out = await askCompanyBrain({model: async () => toolCall({projectId: "secret-project"}),
    graph: g, question: "Who owns secret-project?", asOf});
  assert.equal(out.reason, "MODEL_PROJECT_SCOPE_MISMATCH");
  assert.deepEqual(g.calls, [PROJECTS_CYPHER]);
});

test("model failures and missing tool calls abstain", async () => {
  const a = await askCompanyBrain({model: async () => { throw new Error("down"); }, graph: graph(), question: "Who owns Orion?"});
  assert.equal(a.reason, "MODEL_UNAVAILABLE");
  const b = await askCompanyBrain({model: async () => text("Ben, obviously"), graph: graph(), question: "Who owns Orion?"});
  assert.equal(b.reason, "MODEL_TOOL_CALL_REQUIRED");
  const c = await askCompanyBrain({model: async () => toolCall({projectId: "orion", extra: 1}), graph: graph(), question: "Who owns Orion?"});
  assert.equal(c.reason, "MODEL_PROJECT_SCOPE_MISMATCH");
});

test("abstain explanations must refuse, not name an owner", () => {
  const d = {status: "ABSTAIN", reason: "UNRESOLVED_EQUAL_AUTHORITY_CONFLICT"};
  assert.equal(explanationAgrees("Two equal sources conflict, so no owner can be named.", d), true);
  assert.equal(explanationAgrees("Cora owns Nova, go ahead and ship.", d), false);
  assert.match(templateExplanation(d), /cannot name an owner/);
});

test("hosted model: only the NVIDIA endpoint, a nvapi key and an nvidia/ model are accepted", () => {
  const ok = {apiKey: "nvapi-" + "x".repeat(40), model: "nvidia/nemotron-3-super-120b-a12b"};
  assert.equal(validateHostedModelConfig(ok).endpoint, NVIDIA_ENDPOINT);
  assert.throws(() => validateHostedModelConfig({...ok, endpoint: "https://evil.example/v1/chat/completions"}));
  assert.throws(() => validateHostedModelConfig({...ok, apiKey: "sk-123"}));
  assert.throws(() => validateHostedModelConfig({...ok, model: "gpt-x"}));
});

test("hosted model sends the key only as a bearer header and reports HTTP errors by status", async () => {
  const ok = {apiKey: "nvapi-" + "y".repeat(40), model: "nvidia/nemotron-3-super-120b-a12b"};
  let seen;
  const m = createHostedModel(ok, async (url, init) => {
    seen = {url, init};
    return {ok: true, text: async () => JSON.stringify({choices: []})};
  });
  await m({messages: [], tools: [], tool_choice: "required"});
  assert.equal(seen.url, NVIDIA_ENDPOINT);
  assert.equal(seen.init.headers.authorization, "Bearer " + ok.apiKey);
  assert.ok(!seen.init.body.includes(ok.apiKey));
  const failing = createHostedModel(ok, async () => ({ok: false, status: 429, text: async () => ""}));
  await assert.rejects(failing({messages: []}), /HOSTED_LLM_HTTP_429/);
});
