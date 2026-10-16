import test from "node:test";
import assert from "node:assert/strict";
import {validateFacts, extractSource} from "../src/extract.mjs";

const ctx = {
  catalog: {services: [{id: "billing-gateway", name: "Billing Gateway", aliases: ["billing"]}, {id: "ledger-service", name: "Ledger Service", aliases: []}]},
  org: {people: [{id: "ben", name: "Ben Ortiz"}, {id: "aria", name: "Aria Okafor"}, {id: "omar", name: "Omar Haddad"}]}
};
const src = {id: "cc-1", kind: "change-control", title: "CC-1", text: "Ownership of billing-gateway transfers from Aria to Ben, effective today.\n\nADR-012 decided by Omar for the Ledger Service; supersedes ADR-007."};

test("keeps a fact whose verbatim quote names the owner and the service", () => {
  const r = validateFacts(src, {ownership: [{serviceId: "billing-gateway", ownerId: "ben",
    quote: "Ownership of billing-gateway transfers from Aria to Ben, effective today."}], decisions: []}, ctx);
  assert.equal(r.ownership.length, 1);
  assert.equal(r.rejected.length, 0);
});

test("rejects a quote that is not in the source (hallucinated evidence)", () => {
  const r = validateFacts(src, {ownership: [{serviceId: "billing-gateway", ownerId: "ben", quote: "Ben owns billing-gateway now."}], decisions: []}, ctx);
  assert.equal(r.ownership.length, 0);
  assert.equal(r.rejected[0].reason, "QUOTE_NOT_IN_SOURCE");
});

test("rejects a real quote that does not name the claimed owner", () => {
  const r = validateFacts({...src, text: "The billing gateway is owned by the payments team."},
    {ownership: [{serviceId: "billing-gateway", ownerId: "aria", quote: "The billing gateway is owned by the payments team."}], decisions: []}, ctx);
  assert.equal(r.rejected[0].reason, "QUOTE_DOES_NOT_NAME_OWNER");
});

test("rejects unknown people (e.g. an injected 'Mallory') and unknown services", () => {
  const r = validateFacts(src, {ownership: [{serviceId: "billing-gateway", ownerId: "mallory", quote: "x".repeat(10)},
    {serviceId: "everything", ownerId: "ben", quote: "x".repeat(10)}], decisions: []}, ctx);
  assert.deepEqual(r.rejected.map(x => x.reason), ["UNKNOWN_ENTITY", "UNKNOWN_ENTITY"]);
});

test("matches quotes despite curly quotes, dashes and whitespace differences", () => {
  const s = {...src, text: "Ben’s team — Ben owns   the billing gateway."};
  const r = validateFacts(s, {ownership: [{serviceId: "billing-gateway", ownerId: "ben", quote: "Ben's team - Ben owns the billing gateway."}], decisions: []}, ctx);
  assert.equal(r.ownership.length, 1);
});

test("decisions need their id, decider and affected service in the source, and must come from an ADR", () => {
  const adr = {...src, kind: "adr"};
  const ok = validateFacts(adr, {ownership: [], decisions: [{decisionId: "adr-012", title: "Outbox", decidedBy: "omar",
    serviceIds: ["ledger-service", "billing-gateway"], supersedes: "ADR-007", quote: "ADR-012 decided by Omar for the Ledger Service; supersedes ADR-007."}]}, ctx);
  assert.equal(ok.decisions[0].decisionId, "ADR-012");
  assert.deepEqual(ok.decisions[0].serviceIds, ["ledger-service", "billing-gateway"]);
  const bad = validateFacts(adr, {ownership: [], decisions: [{decisionId: "ADR-099", title: "x", decidedBy: "omar",
    serviceIds: ["ledger-service"], supersedes: null, quote: "ADR-012 decided by Omar for the Ledger Service; supersedes ADR-007."}]}, ctx);
  assert.equal(bad.rejected[0].reason, "DECISION_ID_NOT_IN_SOURCE");
  const chat = validateFacts({...src, kind: "chat"}, {ownership: [], decisions: [{decisionId: "ADR-012", title: "x", decidedBy: "omar",
    serviceIds: ["ledger-service"], supersedes: null, quote: "ADR-012 decided by Omar for the Ledger Service; supersedes ADR-007."}]}, ctx);
  assert.equal(chat.rejected[0].reason, "DECISION_NOT_FROM_ADR");
});

test("model failures and missing tool calls never throw and add no facts", async () => {
  const failing = async () => { throw new Error("HOSTED_LLM_HTTP_500"); };
  assert.match((await extractSource(failing, src, ctx)).error, /HTTP_500/);
  const chatty = async () => ({choices: [{message: {content: "Ben owns it"}}]});
  const r = await extractSource(chatty, src, ctx);
  assert.equal(r.error, "NO_TOOL_CALL");
  assert.equal(r.ownership.length, 0);
});
