import {openGraph} from "../src/db.mjs";
import {GRAPH_FIXTURE} from "../src/fixtures.mjs";
export async function seedGraph(graph) {
  for(const p of GRAPH_FIXTURE.projects) await graph.query(
    "MERGE (p:Project {id:$id}) SET p.name=$name",{params:{id:p.id,name:p.name}});
  for(const s of GRAPH_FIXTURE.services) await graph.query(
    "MERGE (s:Service {id:$id}) SET s.name=$name",{params:s});
  for(const p of GRAPH_FIXTURE.people) await graph.query(
    "MERGE (p:Person {id:$id}) SET p.name=$name",{params:p});
  for(const p of GRAPH_FIXTURE.projects) await graph.query(
    "MATCH (p:Project {id:$projectId}),(s:Service {id:$serviceId}) MERGE (p)-[:USES]->(s)",
    {params:{projectId:p.id,serviceId:p.serviceId}});
  for(const c of GRAPH_FIXTURE.claims) {
    await graph.query(
      "MATCH (o:Person {id:$ownerId}),(svc:Service {id:$serviceId}) "+
      "MERGE (c:OwnershipClaim {id:$id}) SET c.effectiveAt=$effectiveAt "+
      "MERGE (c)-[:ABOUT]->(svc) MERGE (c)-[:NAMES_OWNER]->(o)",
      {params:{id:c.id,effectiveAt:c.effectiveAt,ownerId:c.ownerId,serviceId:c.serviceId}});
    if(c.sourceId) await graph.query(
      "MATCH (c:OwnershipClaim {id:$claimId}) MERGE (s:Source {id:$sourceId}) SET s.rank=$rank "+
      "MERGE (s)-[:ATTESTS]->(c)",
      {params:{sourceId:c.sourceId,rank:c.rank,claimId:c.id}});
  }
}
const main = process.argv[1]?.replaceAll("\\","/") === new URL(import.meta.url).pathname.replace(/^\//,"");
if(main) {
 const {graph,config,close}=await openGraph();
 try{await seedGraph(graph);console.log(JSON.stringify({seeded:true,graph:config.name,synthetic:true}));}
 finally{await close();}
}
