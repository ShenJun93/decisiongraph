import test from "node:test";
import assert from "node:assert/strict";
import {counterfactualAcceptance,ACCEPTANCE_GRAPH} from "../scripts/counterfactual-acceptance.mjs";

function fakeGraph({failOnceAfterMutation=false}={}) {
  const state={owner:"ben",competing:false,queries:0,mutations:0,failOnceAfterMutation};
  return {
    state,
    async query(cypher,{params}={}) {
      state.queries++;
      if(cypher.includes("MATCH (project:Project {id: $projectId})")) {
        if(state.failOnceAfterMutation && state.owner==="aria"){
          state.failOnceAfterMutation=false;
          throw new Error("simulated transient graph outage");
        }
        const base={projectId:"orion",serviceId:"billing-gateway",
          claimId:"claim-current",effectiveAt:"2026-10-14T11:00:00.000Z",
          sourceId:"change-control-oct",sourceRank:90,ownerId:state.owner,
          ownerName:state.owner==="ben"?"Ben":"Aria"};
        const rows=[base,{...base,claimId:"claim-legacy",
          effectiveAt:"2026-09-20T08:00:00.000Z",sourceId:"directory-sep",
          ownerId:"aria",ownerName:"Aria"}];
        if(state.competing) rows.push({...base,claimId:"accept-equal-claim",
          sourceId:"accept-equal-source",ownerId:"cora",ownerName:"Cora"});
        return rows;
      }
      if(cypher.includes("DELETE rel") && params?.claimId==="claim-current"){
        state.owner=null;state.mutations++;return [];
      }
      if(cypher.includes("MERGE (claim)-[:NAMES_OWNER]->(owner)")&&
         params?.claimId==="claim-current"){
        state.owner=params.ownerId;state.mutations++;return [];
      }
      if(cypher.includes("DETACH DELETE") &&
         ["accept-equal-claim","accept-equal-source"].includes(params?.id)){
        state.competing=false;state.mutations++;return [];
      }
      if(params?.claimId==="accept-equal-claim" && cypher.includes("MERGE (source)-[:ATTESTS]")){
        state.competing=true;state.mutations++;return [];
      }
      return [];
    }
  };
}

test("isolated acceptance script proves baseline, edge change, conflict and restore via graph protocol",async()=>{
  const graph=fakeGraph();
  const run=await counterfactualAcceptance(graph);
  assert.equal(run.graph,ACCEPTANCE_GRAPH);
  assert.equal(run.liveGraphCounterfactualPass,true);
  assert.deepEqual(run.readings.map(r=>r.case),
    ["baseline","graph_edge_changed","equal_authority_conflict","restored"]);
  assert.deepEqual(run.readings.map(r=>r.owner),["ben","aria",undefined,"ben"]);
  assert.equal(run.readings[2].reason,"UNRESOLVED_EQUAL_AUTHORITY_CONFLICT");
  assert.equal(graph.state.owner,"ben");
  assert.equal(graph.state.competing,false);
  assert.ok(graph.state.mutations>0);
});

test("an intermediate graph readback failure still invokes cleanup",async()=>{
  const graph=fakeGraph({failOnceAfterMutation:true});
  await assert.rejects(()=>counterfactualAcceptance(graph),/LIVE_GRAPH_ASSERTION_FAILED/);
  assert.equal(graph.state.owner,"ben");
  assert.equal(graph.state.competing,false);
});

test("test-run acceptance never approves or dispatches external actions",async()=>{
  const graph=fakeGraph();
  const output=await counterfactualAcceptance(graph);
  assert.equal(output.externalActions,false);
  assert.equal(JSON.stringify(output).includes("APPROVED"),false);
});
