// Ask the Company Brain free-text questions: Nemotron picks the project and explains,
// live FalkorDB evidence decides. Usage: node --env-file=.env scripts/ask.mjs ["question" ...]
import {openGraph} from "../src/db.mjs";
import {askCompanyBrain} from "../src/agent.mjs";
import {modelFromEnv} from "../src/hosted-model.mjs";

const questions = process.argv.slice(2).length ? process.argv.slice(2) : [
  "Who should sign off the Orion release?",
  "Who owns the ML pipeline behind Vega?",
  "Can I ship Nova today, and who approves it?",
  "Who is responsible for Lyra's search index?"
];
const {model, provider, modelId} = await modelFromEnv();
const connection = await openGraph();
try {
  for (const question of questions) {
    const r = await askCompanyBrain({model, graph: connection.graph, question});
    console.log(JSON.stringify({provider, modelId, question, projectId: r.projectId, status: r.status,
      reason: r.reason || null, owner: r.currentOwner?.name || null,
      explanationSource: r.explanationSource, explanation: r.explanation, trace: r.trace}, null, 2));
  }
} finally {
  await connection.close();
}
