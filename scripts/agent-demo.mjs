// Genuine model-driven tool-call smoke: requires separately verified live FalkorDB
// and a licensed LOCAL_LLM_MODEL hosted on loopback. No fallback simulated agent.
import {openGraph} from "../src/db.mjs";
import {answerWithGraphTool} from "../src/agent.mjs";
import {createLocalModel,localModelConfig} from "../src/local-model.mjs";

const model=createLocalModel(localModelConfig());
const connection=await openGraph();
try {
  const result=await answerWithGraphTool({
    model,graph:connection.graph,
    projectId:process.env.DEMO_PROJECT_ID || "orion",
    question:"Who owns the release? Show the evidence and do not approve it."
  });
  console.log(JSON.stringify(result,null,2));
  if(result.status!=="HUMAN_REVIEW_DRAFT" || !result.agentToolCallVerified)
    process.exitCode=1;
}finally{await connection.close();}
