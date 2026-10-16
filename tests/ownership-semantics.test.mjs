import test from "node:test";
import assert from "node:assert/strict";
import {validateFacts} from "../src/extract.mjs";

const ctx = {
  catalog: {services: [{id: "billing-gateway", name: "Billing Gateway", aliases: ["billing gateway"]}]},
  org: {people: [{id: "aria", name: "Aria Okafor"}, {id: "ben", name: "Ben Ortiz"}]}
};
const claim = (src, ownerId, quote = src.text) =>
  validateFacts(src, {ownership: [{serviceId: "billing-gateway", ownerId, quote}], decisions: []}, ctx);

test("transfer source names both people but cannot attribute ownership to the FROM person", () => {
  const src = {id: "cc-45", kind: "change-control",
    text: "Ownership of billing-gateway transfers from Aria to Ben, effective today."};
  const good = claim(src, "ben");
  assert.equal(good.ownership.length, 1);
  const wrong = claim(src, "aria");
  assert.equal(wrong.ownership.length, 0);
  assert.equal(wrong.rejected[0].reason, "QUOTE_NEGATES_OWNERSHIP");
});

test("a negative authoritative statement cannot manufacture a positive owner fact", () => {
  for (const [txt, owner] of [
    ["Ben is not responsible for billing-gateway.", "ben"],
    ["Aria is no longer the owner of billing-gateway.", "aria"],
    ["Ownership of billing-gateway is no longer assigned to Ben.", "ben"]
  ]) {
    const out = claim({id: "cc-46", kind: "change-control", text: txt}, owner);
    assert.equal(out.ownership.length, 0, txt);
    assert.equal(out.rejected[0].reason, "QUOTE_NEGATES_OWNERSHIP", txt);
  }
});

test("affirmative direct assignment still passes after conservative negative-language guard", () => {
  const s = {id: "cc-47", kind: "change-control",
    text: "Ben is responsible for the billing-gateway starting today."};
  assert.equal(claim(s, "ben").ownership.length, 1);
});
