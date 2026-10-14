import {openGraph} from "../src/db.mjs";
import {decideFromGraph} from "../src/decision.mjs";
const {graph,config,close}=await openGraph();
try {
  const decision=await decideFromGraph(graph,{projectId:"orion"});
  if(decision.status==="ABSTAIN")process.exitCode=1;
  console.log(JSON.stringify({graph:config.name,decision,
    note:"Read-only, deterministic Cypher workflow; not yet an LLM agent."},null,2));
} finally {await close();}
