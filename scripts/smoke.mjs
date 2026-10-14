import { openGraph } from "../src/db.mjs";
const {graph,config,close} = await openGraph();
try {
  const id = "gh2026-probe";
  const write = await graph.query(
    "MERGE (n:GraphSmoke {id:$id}) SET n.updatedAt=$when RETURN n.id AS id",
    {params:{id,when:new Date().toISOString()}}
  );
  const read = await graph.query(
    "MATCH (n:GraphSmoke {id:$id}) RETURN n.id AS id,n.updatedAt AS updatedAt",
    {params:{id}}
  );
  const idSeen = JSON.stringify(read).includes(id);
  if (!idSeen) throw new Error("Cypher readback failed to find graph probe id");
  console.log(JSON.stringify({ok:true,engine:"FalkorDB",graph:config.name,write,read},null,2));
} finally {await close();}
