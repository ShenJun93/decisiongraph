// LIVE FalkorDB proof gate. Uses a dedicated synthetic-only acceptance graph,
// never the demo graph. Unit tests use a mock; only a real DB can earn LIVE_PASS.
import path from "node:path";
import {fileURLToPath} from "node:url";
import {openGraph} from "../src/db.mjs";
import {seedGraph} from "./seed.mjs";
import {decideFromGraph} from "../src/decision.mjs";

export const ACCEPTANCE_GRAPH="gh2026_companybrain_acceptance";
export const AS_OF="2026-10-15T00:00:00.000Z";
const CLAIM="claim-current";
const COMPETING_CLAIM="accept-equal-claim";
const COMPETING_SOURCE="accept-equal-source";

function ensure(result,status,ownerId) {
  if (result.status!==status || (ownerId!==undefined && result.currentOwner?.id!==ownerId)) {
    throw new Error("LIVE_GRAPH_ASSERTION_FAILED: "+JSON.stringify({
      expected:status,expectedOwner:ownerId,actual:result.status,actualOwner:result.currentOwner?.id,
      reason:result.reason
    }));
  }
}
const q=(graph,cypher,params)=>graph.query(cypher,{params});

async function replaceCurrentOwner(graph,ownerId) {
  await q(graph,
    "MATCH (claim:OwnershipClaim {id:$claimId})-[rel:NAMES_OWNER]->(:Person) DELETE rel",
    {claimId:CLAIM});
  await q(graph,
    "MATCH (claim:OwnershipClaim {id:$claimId}),(owner:Person {id:$ownerId}) "+
    "MERGE (claim)-[:NAMES_OWNER]->(owner)",
    {claimId:CLAIM,ownerId});
}
async function removeEqualClaim(graph) {
  await q(graph,"MATCH (c:OwnershipClaim {id:$id}) DETACH DELETE c",{id:COMPETING_CLAIM});
  await q(graph,"MATCH (s:Source {id:$id}) DETACH DELETE s",{id:COMPETING_SOURCE});
}
async function addEqualClaim(graph) {
  await q(graph,
    "MERGE (claim:OwnershipClaim {id:$claimId}) SET claim.effectiveAt=$when",
    {claimId:COMPETING_CLAIM,when:"2026-10-14T11:00:00.000Z"});
  await q(graph,"MERGE (source:Source {id:$sourceId}) SET source.rank=90",
    {sourceId:COMPETING_SOURCE});
  await q(graph,
    "MATCH (source:Source {id:$sourceId}),(claim:OwnershipClaim {id:$claimId}),"+
    "(owner:Person {id:$ownerId}),(service:Service {id:$serviceId}) "+
    "MERGE (source)-[:ATTESTS]->(claim) "+
    "MERGE (claim)-[:NAMES_OWNER]->(owner) "+
    "MERGE (claim)-[:ABOUT]->(service)",
    {sourceId:COMPETING_SOURCE,claimId:COMPETING_CLAIM,ownerId:"cora",serviceId:"billing-gateway"});
}

export async function counterfactualAcceptance(graph) {
  let primaryError=null;
  const readings=[];
  try {
    await seedGraph(graph);
    // Retry-safe normalization in the dedicated synthetic test graph.
    await removeEqualClaim(graph);
    await replaceCurrentOwner(graph,"ben");
    const baseline=await decideFromGraph(graph,{projectId:"orion",asOf:AS_OF});
    ensure(baseline,"HUMAN_REVIEW_DRAFT","ben");
    readings.push({case:"baseline",status:baseline.status,owner:baseline.currentOwner.id,
      claim:baseline.basis.claimId,source:baseline.basis.sourceId});

    await replaceCurrentOwner(graph,"aria");
    const changed=await decideFromGraph(graph,{projectId:"orion",asOf:AS_OF});
    ensure(changed,"HUMAN_REVIEW_DRAFT","aria");
    readings.push({case:"graph_edge_changed",status:changed.status,owner:changed.currentOwner.id,
      claim:changed.basis.claimId,source:changed.basis.sourceId});

    await addEqualClaim(graph);
    const conflict=await decideFromGraph(graph,{projectId:"orion",asOf:AS_OF});
    ensure(conflict,"ABSTAIN");
    if (conflict.reason!=="UNRESOLVED_EQUAL_AUTHORITY_CONFLICT") {
      throw new Error("LIVE_GRAPH_CONFLICT_NOT_DETECTED: "+conflict.reason);
    }
    readings.push({case:"equal_authority_conflict",status:conflict.status,reason:conflict.reason});
  } catch(e) {
    primaryError=e;
  } finally {
    try {
      await removeEqualClaim(graph);
      await replaceCurrentOwner(graph,"ben");
      const restored=await decideFromGraph(graph,{projectId:"orion",asOf:AS_OF});
      ensure(restored,"HUMAN_REVIEW_DRAFT","ben");
      readings.push({case:"restored",status:restored.status,owner:restored.currentOwner.id});
    } catch(e) {
      throw new AggregateError([...(primaryError?[primaryError]:[]),e],
        "ACCEPTANCE_GRAPH_RESTORE_FAILED");
    }
  }
  if(primaryError) throw primaryError;
  if(readings.length!==4) throw new Error("INCOMPLETE_GRAPH_ACCEPTANCE");
  return {liveGraphCounterfactualPass:true,graph:ACCEPTANCE_GRAPH,synthetic:true,
    readings,externalActions:false};
}

if (process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  const conn=await openGraph({...process.env,GRAPH_NAME:ACCEPTANCE_GRAPH});
  try {
    console.log(JSON.stringify(await counterfactualAcceptance(conn.graph),null,2));
  } finally {await conn.close();}
}
