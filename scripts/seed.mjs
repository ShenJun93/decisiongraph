// Build the company graph in FalkorDB from the corpus and the validated extractions.
// Usage: node scripts/seed.mjs
import {readFileSync} from "node:fs";
import {openGraph} from "../src/db.mjs";
import {loadCorpus, CORPUS_DIR} from "../src/corpus.mjs";
import {loadGraph, graphStats} from "../src/graph-load.mjs";

export function loadExtracted() {
  return JSON.parse(readFileSync(new URL("extracted.json", CORPUS_DIR), "utf8")).results;
}

export async function seedGraph(graph) {
  return loadGraph(graph, loadCorpus(), loadExtracted());
}

const main = process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/seed.mjs");
if (main) {
  const {graph, config, close} = await openGraph();
  try {
    const counts = await seedGraph(graph);
    console.log(JSON.stringify({seeded: true, graph: config.name, ...counts, stats: await graphStats(graph)}, null, 1));
  } finally { await close(); }
}
