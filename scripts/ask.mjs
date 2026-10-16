// Ask the Company Brain from the command line.
// Usage: node --env-file=.env scripts/ask.mjs ["question" ...]
import {openGraph} from "../src/db.mjs";
import {askCompanyBrain} from "../src/agent.mjs";
import {modelFromEnv} from "../src/hosted-model.mjs";

export const DEMO_QUESTIONS = [
  "Who should sign off the Orion release?",
  "Who owned the billing gateway on September 25, 2026?",
  "Who owns everything Project Atlas depends on?",
  "Who is responsible for Lyra's search index?",
  "Who knows the most about the search index?",
  "Why did we stop publishing ledger events through Kafka (ADR-007)?"
];

const main = process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/ask.mjs");
if (main) {
  const questions = process.argv.slice(2).length ? process.argv.slice(2) : DEMO_QUESTIONS;
  const {model, provider, modelId} = await modelFromEnv();
  const connection = await openGraph();
  try {
    for (const question of questions) {
      const r = await askCompanyBrain({model, graph: connection.graph, question});
      console.log(JSON.stringify({provider, modelId, question, tool: r.tool || null, subjectId: r.subjectId || null,
        status: r.status, reason: r.reason || null, asOf: r.time?.asOf || null,
        owners: (r.services || []).map(s => `${s.serviceId}: ${s.owner?.id || s.reason}`),
        people: (r.people || []).slice(0, 3).map(p => `${p.id} (${p.score})`), busFactor: r.busFactor,
        current: r.current, explanationSource: r.explanationSource, explanation: r.explanation,
        trace: r.trace.map(s => s.step + (s.subjectId ? ":" + s.subjectId : ""))}, null, 1));
    }
  } finally {
    await connection.close();
  }
}
