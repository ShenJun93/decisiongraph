import test from "node:test";
import assert from "node:assert/strict";
import {parseQuestionTime, grounded, explanationAgrees, templateExplanation} from "../src/agent.mjs";

const now = new Date("2026-10-16T12:00:00Z");

test("dates in the question set the point in time; vague or future times refuse", () => {
  assert.equal(parseQuestionTime("Who owned the billing gateway on September 25, 2026?", now).asOf, "2026-09-25T23:59:59.000Z");
  assert.equal(parseQuestionTime("owner on 2026-09-25?", now).asOf, "2026-09-25T23:59:59.000Z");
  assert.equal(parseQuestionTime("owner on 25th Sep?", now).asOf, "2026-09-25T23:59:59.000Z");
  assert.equal(parseQuestionTime("who owned it yesterday", now).asOf, "2026-10-15T23:59:59.000Z");
  assert.equal(parseQuestionTime("Who owns Orion?", now).source, "now");
  assert.equal(parseQuestionTime("Who owned it last month?", now).error, "AMBIGUOUS_TIME");
  assert.equal(parseQuestionTime("Who owned it in September?", now).error, "AMBIGUOUS_TIME");
  assert.equal(parseQuestionTime("Who used to own it?", now).error, "AMBIGUOUS_TIME");
  assert.equal(parseQuestionTime("Sep 2 or Sep 25?", now).error, "AMBIGUOUS_TIME");
  assert.equal(parseQuestionTime("Who owns it on Dec 1?", now).error, "FUTURE_TIME");
  assert.equal(parseQuestionTime("Feb 30 2026", now).error, "AMBIGUOUS_TIME");
});

const e = {
  projects: [{id: "orion", name: "Project Orion", aliases: [], serviceIds: ["billing-gateway"]}],
  services: [{id: "billing-gateway", name: "Billing Gateway", aliases: ["billing"]}, {id: "search-index", name: "Search Index", aliases: []}],
  topics: [{id: "kafka", name: "Kafka", aliases: []}],
  decisions: [{id: "ADR-012", title: "Postgres transactional outbox"}]
};

test("the tool subject must be named in the question (or be a service of a named project)", () => {
  assert.ok(grounded("Who should sign off the Orion release?", "orion", e));
  assert.ok(grounded("Who should sign off the Orion release?", "billing-gateway", e));
  assert.ok(grounded("who knows kafka", "kafka", e));
  assert.ok(grounded("why ADR 12?", "ADR-012", e));
  assert.ok(!grounded("Who owns Project Zeus?", "orion", e));
  assert.ok(!grounded("Who owns Project Zeus?", "search-index", e));
});

const people = [{id: "ben", name: "Ben Ortiz"}, {id: "aria", name: "Aria Okafor"}, {id: "zane", name: "Zane Cole"}];
const owner = {kind: "owner", services: [{status: "OWNER", serviceId: "billing-gateway", serviceName: "Billing Gateway",
  owner: {id: "ben", name: "Ben Ortiz"}, basis: {sourceId: "cc-1031", sourceKind: "change-control", authority: 90, effectiveAt: "2026-10-14T11:00:00Z"},
  outranked: [{ownerId: "aria"}]}]};

test("model explanations that agree with the graph are kept", () => {
  assert.ok(explanationAgrees("Ben owns the Billing Gateway per change-control cc-1031; Aria's directory entry is older.", owner, people));
});

test("explanations that approve, name an outranked owner, or name someone outside the evidence are rejected", () => {
  assert.ok(!explanationAgrees("Ben owns it and the release is approved.", owner, people));
  assert.ok(!explanationAgrees("Aria owns the billing gateway; Ben was mentioned too.", owner, people));
  assert.ok(!explanationAgrees("Ben owns it, and Zane approved the Orion release earlier.", owner, people));
  assert.ok(!explanationAgrees("The billing gateway has an owner.", owner, people));
});

test("abstentions must say no owner can be named", () => {
  const abstain = {kind: "owner", services: [{status: "ABSTAIN", serviceId: "payments-api", reason: "UNRESOLVED_EQUAL_AUTHORITY_CONFLICT",
    competing: [{ownerId: "aria"}, {ownerId: "ben"}]}]};
  assert.ok(explanationAgrees("No owner can be named: Aria and Ben are named by equally authoritative records.", abstain, people));
  assert.ok(!explanationAgrees("Aria and Ben both handle payments.", abstain, people));
  assert.match(templateExplanation(abstain), /no owner named/);
});

test("quoting a low-authority record is allowed; asserting it is not", () => {
  const lyra = {kind: "owner", services: [{status: "ABSTAIN", serviceId: "search-index", reason: "LOW_AUTHORITY_ONLY", evidence: [{ownerId: "dev"}]}]};
  const ppl = [{id: "dev", name: "Dev Mehta"}];
  assert.ok(explanationAgrees('No owner can be named: only chat msg-022 says "Dev owns the search index".', lyra, ppl));
  assert.ok(!explanationAgrees("No owner can be named, but Dev owns the search index.", lyra, ppl));
});
