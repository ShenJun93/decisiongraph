// Genuine model-driven tool-call run: requires live FalkorDB and a model selected by
// MODEL_PROVIDER (nvidia = hosted Nemotron, local = loopback llama.cpp). No simulated fallback.
import {openGraph} from "../src/db.mjs";
import {answerWithGraphTool} from "../src/agent.mjs";
import {modelFromEnv} from "../src/hosted-model.mjs";

const {model,provider,modelId}=await modelFromEnv();
const connection=await openGraph();
try {
  const result=await answerWithGraphTool({
    model,graph:connection.graph,
    projectId:process.env.DEMO_PROJECT_ID || "orion",
    question:"Who owns the release? Show the evidence and do not approve it."
  });
  console.log(JSON.stringify({provider,modelId,...result},null,2));
  if(result.status!=="HUMAN_REVIEW_DRAFT" || !result.agentToolCallVerified)
    process.exitCode=1;
}finally{await connection.close();}
