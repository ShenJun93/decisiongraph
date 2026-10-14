import test from "node:test";
import assert from "node:assert/strict";
import { resolveEvidence, decideFromGraph, LOOKUP_CYPHER } from "../src/decision.mjs";

const asOf = "2026-10-14T20:00:00.000Z";
const projectId = "orion";
const row = (overrides = {}) => ({
  projectId,serviceId:"billing-gateway",claimId:"claim-current",
  sourceId:"change-control-oct",sourceRank:90,
  effectiveAt:"2026-10-14T11:00:00.000Z",
  ownerId:"ben",ownerName:"Ben (synthetic)",...overrides
});

test("current authoritative claim yields a draft, never release approval", () => {
  const result = resolveEvidence([row()],{projectId,asOf});
  assert.equal(result.status,"HUMAN_REVIEW_DRAFT");
  assert.equal(result.currentOwner.id,"ben");
  assert.equal(result.proposedAction.type,"DRAFT_HUMAN_REVIEW_TASK");
  assert.equal(result.authorizedExternalActions,false);
  assert.ok(result.basis.path.some(p=>p.includes("Source:change-control-oct")));
});
test("newer equal-rank authoritative owner supersedes older one",()=>{
  const old = row({claimId:"claim-legacy",sourceId:"directory-sep",
    effectiveAt:"2026-09-20T08:00:00.000Z",ownerId:"aria",ownerName:"Aria"});
  const r=resolveEvidence([old,row()],{projectId,asOf});
  assert.equal(r.currentOwner.id,"ben");
  assert.equal(r.contradictoryEvidence.length,1);
  assert.equal(r.contradictoryEvidence[0].sourceId,"directory-sep");
});
test("new low-rank chat does not supersede authoritative change",()=>{
  const chat=row({claimId:"claim-chat",sourceId:"chat-note-oct",sourceRank:35,
    effectiveAt:"2026-10-14T16:00:00.000Z",ownerId:"aria",ownerName:"Aria"});
  assert.equal(resolveEvidence([chat,row()],{projectId,asOf}).currentOwner.id,"ben");
});
test("equal authority and effective time with distinct owners must abstain",()=>{
  const competing=row({claimId:"claim-equal",sourceId:"other-official",
    ownerId:"aria",ownerName:"Aria"});
  const r=resolveEvidence([row(),competing],{projectId,asOf});
  assert.equal(r.status,"ABSTAIN");
  assert.equal(r.reason,"UNRESOLVED_EQUAL_AUTHORITY_CONFLICT");
  assert.equal(r.proposedAction,null);
});
test("missing provenance fails closed rather than guessing",()=>{
  const r=resolveEvidence([row({sourceId:""})],{projectId,asOf});
  assert.equal(r.reason,"INCOMPLETE_GRAPH_PROVENANCE");
  assert.equal(r.status,"ABSTAIN");
});
test("empty graph, invalid graph response and future-dated data all abstain",()=>{
  assert.equal(resolveEvidence([],{projectId,asOf}).reason,"NO_GRAPH_EVIDENCE");
  assert.equal(resolveEvidence({owner:"Ben"},{projectId,asOf}).reason,"INVALID_GRAPH_RESPONSE");
  const future = row({effectiveAt:"2026-11-01T00:00:00.000Z"});
  assert.equal(resolveEvidence([future],{projectId,asOf}).reason,"NO_CURRENT_EVIDENCE");
});
test("multi-service output not squashed into one owner",()=>{
  const r=resolveEvidence([row(),row({serviceId:"audit-system",claimId:"other"})],{projectId,asOf});
  assert.equal(r.reason,"AMBIGUOUS_PROJECT_SERVICE");
});
test("invalid project IDs and timestamps rejected",()=>{
  assert.equal(resolveEvidence([row()],{projectId:"../../../etc",asOf}).reason,"INVALID_INPUT");
  assert.equal(resolveEvidence([row()],{projectId,asOf:"not-a-date"}).reason,"INVALID_INPUT");
});
test("graph outage returns ABSTAIN with no synthetic fallback answer", async()=>{
  const broken={async query(){throw new Error("ECONNREFUSED");}};
  const r=await decideFromGraph(broken,{projectId,asOf});
  assert.equal(r.status,"ABSTAIN");
  assert.equal(r.reason,"GRAPH_UNAVAILABLE");
  assert.equal(r.currentOwner,undefined);
});
test("real graph query is mandatory and parameterized", async()=>{
  let calls=0;
  const graph={async query(query,options){
    calls++;
    assert.equal(query,LOOKUP_CYPHER);
    assert.deepEqual(options,{params:{projectId}});
    return [row()];
  }};
  const r=await decideFromGraph(graph,{projectId,asOf});
  assert.equal(calls,1);
  assert.equal(r.currentOwner.id,"ben");
});
