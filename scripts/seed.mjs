import {openGraph} from "../src/db.mjs";
import {GRAPH_FIXTURE,PROJECT_ID,SERVICE_ID} from "../src/fixtures.mjs";
export async function seedGraph(graph) {
  for(const p of GRAPH_FIXTURE.projects) await graph.query(
    "MERGE (p:Project {id:$id}) SET p.name=$name",{params:p});
  for(const s of GRAPH_FIXTURE.services) await graph.query(
    "MERGE (s:Service {id:$id}) SET s.name=$name",{params:s});
  for(const p of GRAPH_FIXTURE.people) await graph.query(
    "MERGE (p:Person {id:$id}) SET p.name=$name",{params:p});
  await graph.query(
    "MATCH (p:Project {id:$projectId}),(s:Service {id:$serviceId}) MERGE (p)-[:USES]->(s)",
    {params:{projectId:PROJECT_ID,serviceId:SERVICE_ID}});
  for(const c of GRAPH_FIXTURE.claims) {
    await graph.query(
      "MERGE (c:OwnershipClaim {id:$id}) SET c.effectiveAt=$effectiveAt",
      {params:{id:c.id,effectiveAt:c.effectiveAt}});
    await graph.query(
      "MERGE (s:Source {id:$id}) SET s.rank=$rank",
      {params:{id:c.sourceId,rank:c.rank}});
    await graph.query(
      "MATCH (s:Source {id:$sourceId}),(c:OwnershipClaim {id:$claimId}),(o:Person {id:$ownerId}),(svc:Service {id:$serviceId}) MERGE (s)-[:ATTESTS]->(c) MERGE (c)-[:ABOUT]->(svc) MERGE (c)-[:NAMES_OWNER]->(o)",
      {params:{sourceId:c.sourceId,claimId:c.id,ownerId:c.ownerId,serviceId:SERVICE_ID}});
  }
}
const main = process.argv[1]?.replaceAll("\\","/") === new URL(import.meta.url).pathname.replace(/^\//,"");
if(main) {
 const {graph,config,close}=await openGraph();
 try{await seedGraph(graph);console.log(JSON.stringify({seeded:true,graph:config.name,synthetic:true}));}
 finally{await close();}
}
