import test from "node:test";
import assert from "node:assert/strict";
import {resolveOwner, MAX_EVIDENCE_ROWS} from "../src/decision.mjs";

const row = (o) => ({serviceId: "billing-gateway", serviceName: "Billing Gateway", claimId: "c-" + o.sourceId,
  sourceKind: "change-control", sourceTitle: "t", quote: "q", ownerName: o.ownerId, ...o});
const legacy = row({sourceId: "dir", authority: 80, ownerId: "aria", effectiveAt: "2026-09-20T08:00:00Z"});
const current = row({sourceId: "cc", authority: 90, ownerId: "ben", effectiveAt: "2026-10-14T11:00:00Z"});
const chat = row({sourceId: "chat", authority: 35, ownerId: "aria", effectiveAt: "2026-10-14T16:00:00Z"});
const now = {serviceId: "billing-gateway", asOf: "2026-10-16T12:00:00Z"};

test("higher authority wins and the outranked claims are kept with their quotes", () => {
  const r = resolveOwner([legacy, current, chat], now);
  assert.equal(r.status, "OWNER");
  assert.equal(r.owner.id, "ben");
  assert.deepEqual(r.outranked.map(x => x.sourceId).sort(), ["chat", "dir"]);
});

test("asks about the past are answered as of that time (claims not yet in effect are ignored)", () => {
  const r = resolveOwner([legacy, current, chat], {serviceId: "billing-gateway", asOf: "2026-09-25T23:59:59Z"});
  assert.equal(r.owner.id, "aria");
});

test("before any claim existed there is no owner", () => {
  assert.equal(resolveOwner([legacy], {serviceId: "billing-gateway", asOf: "2026-09-01T00:00:00Z"}).reason, "NO_EVIDENCE_AT_THAT_TIME");
});

test("equal authority at the same instant, written in different timezones, abstains", () => {
  const a = row({sourceId: "cc-a", authority: 90, ownerId: "aria", effectiveAt: "2026-10-12T12:00:00Z"});
  const b = row({sourceId: "cc-b", authority: 90, ownerId: "cora", effectiveAt: "2026-10-12T19:00:00+07:00"});
  const r = resolveOwner([a, b], now);
  assert.equal(r.reason, "UNRESOLVED_EQUAL_AUTHORITY_CONFLICT");
  assert.equal(r.competing.length, 2);
});

test("chat or wiki alone can never name an owner", () => {
  const r = resolveOwner([chat], now);
  assert.equal(r.reason, "LOW_AUTHORITY_ONLY");
  assert.equal(r.evidence.length, 1);
});

test("a claim with no attesting source makes the policy abstain instead of choosing from the rest", () => {
  const r = resolveOwner([current, {...legacy, sourceId: null, authority: null}], now);
  assert.equal(r.reason, "INCOMPLETE_GRAPH_PROVENANCE");
});

test("a service with no claims, unknown services and the row cap all abstain", () => {
  assert.equal(resolveOwner([{serviceId: "mobile-app", serviceName: "Mobile App", claimId: null}], {...now, serviceId: "mobile-app"}).reason, "NO_GRAPH_EVIDENCE");
  assert.equal(resolveOwner([], now).reason, "UNKNOWN_SERVICE");
  assert.equal(resolveOwner(Array(MAX_EVIDENCE_ROWS).fill(current), now).reason, "EVIDENCE_RESULT_LIMIT");
  assert.equal(resolveOwner([current], {...now, asOf: "yesterday"}).reason, "INVALID_INPUT");
});
