import test from "node:test";
import assert from "node:assert/strict";
import {parseQuestionTime, grounded, explanationAgrees, templateExplanation, routeOffline, namedEntities} from "../src/agent.mjs";

const now = new Date("2026-10-16T12:00:00Z");
const at = q => parseQuestionTime(q, now);

test("dates in the question set the point in time", () => {
  assert.equal(at("Who owned the billing gateway on September 25, 2026?").asOf, "2026-09-25T23:59:59.000Z");
  assert.equal(at("owner on 2026-09-25?").asOf, "2026-09-25T23:59:59.000Z");
  assert.equal(at("owner on 25th Sep?").asOf, "2026-09-25T23:59:59.000Z");
  assert.equal(at("owner on 9/25/2026?").asOf, "2026-09-25T23:59:59.000Z");
  assert.equal(at("owner on 25/9/2026?").asOf, "2026-09-25T23:59:59.000Z");
  assert.equal(at("Was it owned by Aria on Sep 25?").asOf, "2026-09-25T23:59:59.000Z");
  assert.equal(at("who owned it yesterday").asOf, "2026-10-15T23:59:59.000Z");
  assert.equal(at("Who owns Orion?").source, "now");
  assert.equal(at("Who should sign off before the Orion release?").source, "now");
});

test("vague, ranged, ambiguous or future times refuse instead of becoming 'now'", () => {
  for (const q of ["Who owned it last month?", "Who owned it in September?", "during September 2026", "Who used to own it?",
    "3 weeks ago", "last Tuesday", "at the start of October", "in 2025", "on the 25th", "before CC-1031", "recently",
    "Sep 2 or Sep 25?", "owner on 3/4/2026?", "Feb 30 2026", "Who owned it before September 25?"]) {
    assert.equal(at(q).error, "AMBIGUOUS_TIME", q);
  }
  assert.equal(at("Who owns it on Dec 1?").error, "FUTURE_TIME");
});

const e = {
  projects: [{id: "orion", name: "Project Orion", aliases: ["Orion"], serviceIds: ["billing-gateway"]},
    {id: "atlas", name: "Project Atlas", aliases: ["Atlas"], serviceIds: ["checkout-web", "ledger-service"]}],
  services: [{id: "billing-gateway", name: "Billing Gateway", aliases: ["billing gateway"]},
    {id: "search-index", name: "Search Index", aliases: ["search index"]},
    {id: "checkout-web", name: "Checkout Web", aliases: ["checkout"]},
    {id: "ledger-service", name: "Ledger Service", aliases: ["ledger"]}],
  topics: [{id: "kafka", name: "Kafka", aliases: []}],
  decisions: [{id: "ADR-012", title: "Replace Kafka publishing for ledger events with a Postgres transactional outbox"}],
  people: [{id: "omar", name: "Omar Haddad"}, {id: "tara", name: "Tara Bose"}],
  teams: [{id: "payments", name: "Payments"}]
};
const g = (q, tool, subjectId) => grounded(q, tool, {subjectId}, e);

test("the tool subject must be named in the question (or be a service of a named project)", () => {
  assert.ok(g("Who should sign off the Orion release?", "owner_of", "orion"));
  assert.ok(g("Who should sign off the Orion release?", "owner_of", "billing-gateway"));
  assert.ok(g("Who owns checkout?", "owner_of", "checkout-web"));
  assert.ok(g("who knows kafka", "who_knows", "kafka"));
  assert.ok(g("why ADR 12?", "trace_decision", "ADR-012"));
  assert.ok(g("Why do we use a transactional outbox for the ledger?", "trace_decision", "ADR-012"));
  assert.ok(g("What does Omar own?", "person_or_team", "omar"));
  assert.ok(g("Who leads the Payments team?", "person_or_team", "payments"));
  assert.ok(!g("Who owns Project Zeus?", "owner_of", "orion"));
  assert.ok(!g("Who owns Project Zeus?", "owner_of", "search-index"));
  assert.ok(!g("What does Zane own?", "person_or_team", "omar"));
  assert.ok(grounded("Which records mention the outbox relay?", "search_records", {query: "outbox relay"}, e));
  assert.ok(!grounded("Which records mention the outbox relay?", "search_records", {query: "kafka secrets"}, e));
});

test("offline routing rules pick the same tools a model would", () => {
  const r = q => routeOffline(q, e);
  assert.deepEqual(r("Who should sign off the Orion release?"), {tool: "owner_of", args: {subjectId: "orion"}});
  assert.deepEqual(r("Who knows the most about the search index?"), {tool: "who_knows", args: {subjectId: "search-index"}});
  assert.deepEqual(r("Why do we use a transactional outbox for the ledger?"), {tool: "trace_decision", args: {subjectId: "ADR-012"}});
  assert.deepEqual(r("What does Omar work on?"), {tool: "person_or_team", args: {subjectId: "omar"}});
  assert.equal(r("Find records that mention dunning")?.tool, "search_records");
  assert.equal(r("What is the weather in Hanoi?"), null);
  assert.equal(namedEntities("Who owns checkout and kafka?", e).services[0].id, "checkout-web");
});

const people = [{id: "ben", name: "Ben Ortiz"}, {id: "aria", name: "Aria Okafor"}, {id: "zane", name: "Zane Cole"}];
const owner = {kind: "owner", services: [{status: "OWNER", serviceId: "billing-gateway", serviceName: "Billing Gateway",
  owner: {id: "ben", name: "Ben Ortiz"}, basis: {sourceId: "cc-1031", sourceKind: "change-control", authority: 90, effectiveAt: "2026-10-14T11:00:00Z"},
  outranked: [{ownerId: "aria"}]}]};

test("model explanations that agree with the graph are kept", () => {
  assert.ok(explanationAgrees("Ben owns the Billing Gateway per change-control cc-1031; the directory entry is older.", owner, people));
});

test("explanations that approve, contradict, leak internals or name outsiders are rejected", () => {
  assert.ok(!explanationAgrees("Ben owns it and the release is approved.", owner, people));
  assert.ok(!explanationAgrees("Aria owns the billing gateway; Ben was mentioned too.", owner, people));
  assert.ok(!explanationAgrees("Ben is listed, but the gateway was owned by Aria on that date.", owner, people));
  assert.ok(!explanationAgrees("Ben owns it, and Zane approved the Orion release earlier.", owner, people));
  assert.ok(!explanationAgrees("Ben owns it (claimId cc-1031:billing-gateway:ben).", owner, people));
  assert.ok(!explanationAgrees("Ben owns it; status is LOW_AUTHORITY_ONLY elsewhere.", owner, people));
  assert.ok(!explanationAgrees("The billing gateway has an owner.", owner, people));
});

test("abstentions must say no owner can be named; quoting a record is allowed", () => {
  const abstain = {kind: "owner", services: [{status: "ABSTAIN", serviceId: "payments-api", reason: "UNRESOLVED_EQUAL_AUTHORITY_CONFLICT",
    competing: [{ownerId: "aria"}, {ownerId: "ben"}]}]};
  assert.ok(explanationAgrees("No owner can be named: Aria and Ben are named by equally authoritative records.", abstain, people));
  assert.ok(!explanationAgrees("Aria and Ben both handle payments.", abstain, people));
  assert.match(templateExplanation(abstain), /no owner named/);
  const lyra = {kind: "owner", services: [{status: "ABSTAIN", serviceId: "search-index", reason: "LOW_AUTHORITY_ONLY", evidence: [{ownerId: "dev"}]}]};
  const ppl = [{id: "dev", name: "Dev Mehta"}];
  assert.ok(explanationAgrees('No owner can be named: only chat msg-022 says "Dev owns the search index".', lyra, ppl));
  assert.ok(!explanationAgrees("No owner can be named, but Dev owns the search index.", lyra, ppl));
});
