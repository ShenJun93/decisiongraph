// Read every corpus record with Nemotron and keep only facts whose quotes check out.
// Writes corpus/extracted.json, which `npm run seed` loads (so the graph can be rebuilt without a key).
// Usage: node --env-file=.env scripts/ingest.mjs [--only=id1,id2]   (--only re-extracts those records and merges)
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {loadCorpus, CORPUS_DIR} from "../src/corpus.mjs";
import {extractAll} from "../src/extract.mjs";
import {modelFromEnv} from "../src/hosted-model.mjs";

const corpus = loadCorpus();
const {model, modelId} = await modelFromEnv();
const file = new URL("extracted.json", CORPUS_DIR);
const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const previous = only.length && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).results : {};
const todo = only.length ? corpus.sources.filter(s => only.includes(s.id)) : corpus.sources;
const started = Date.now();
const fresh = await extractAll(model, todo, corpus, {
  concurrency: Number(process.env.EXTRACT_CONCURRENCY || 4),
  onProgress: (n, total, id, r) => process.stdout.write(
    `${n}/${total} ${id}: ${r.ownership.length} ownership, ${r.decisions.length} decisions, ` +
    `${r.rejected.length} rejected${r.error ? " ERROR " + r.error : ""}\n`)
});
const results = {...previous, ...fresh};
const sum = k => Object.values(results).reduce((a, r) => a + (r[k]?.length || 0), 0);
const ordered = Object.fromEntries(corpus.sources.map(s => [s.id, results[s.id]]));
const out = {model: modelId, extractedAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000),
  totals: {sources: corpus.sources.length, ownership: sum("ownership"), decisions: sum("decisions"), rejected: sum("rejected"),
    errors: Object.values(results).filter(r => r.error).length},
  results: ordered};
writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out.totals));
