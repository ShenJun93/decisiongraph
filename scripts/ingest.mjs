// Read every corpus record with Nemotron and keep only facts whose quotes check out.
// Writes corpus/extracted.json, which `npm run seed` loads (so the graph can be rebuilt without a key).
// The three live-demo records are extracted too and kept apart, for MODEL_PROVIDER=offline.
// Usage: node --env-file=.env scripts/ingest.mjs [--only=id1,id2]   (--only re-extracts those records and merges)
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {loadCorpus, liveSource, CORPUS_DIR} from "../src/corpus.mjs";
import {extractAll} from "../src/extract.mjs";
import {modelFromEnv} from "../src/hosted-model.mjs";

const corpus = loadCorpus();
const live = corpus.live.map(liveSource);
const {model, modelId} = await modelFromEnv();
if (model.offline) throw new Error("ingest needs a model: set MODEL_PROVIDER=nvidia and NVIDIA_API_KEY");
const file = new URL("extracted.json", CORPUS_DIR);
const only = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const prev = only.length && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const all = [...corpus.sources, ...live];
const todo = only.length ? all.filter(s => only.includes(s.id)) : all;
const started = Date.now();
const fresh = await extractAll(model, todo, corpus, {
  concurrency: Number(process.env.EXTRACT_CONCURRENCY || 4),
  onProgress: (n, total, id, r) => process.stdout.write(
    `${n}/${total} ${id}: ${r.ownership.length} ownership, ${r.decisions.length} decisions, ` +
    `${r.rejected.length} rejected${r.error ? " ERROR " + r.error : ""}\n`)
});
const merged = {...(prev.results || {}), ...(prev.live || {}), ...fresh};
const results = Object.fromEntries(corpus.sources.map(s => [s.id, merged[s.id]]));
const liveResults = Object.fromEntries(live.map(s => [s.id, merged[s.id]]).filter(([, r]) => r));
const sum = k => Object.values(results).reduce((a, r) => a + (r?.[k]?.length || 0), 0);
const out = {model: modelId, extractedAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000),
  totals: {sources: corpus.sources.length, ownership: sum("ownership"), decisions: sum("decisions"), rejected: sum("rejected"),
    errors: Object.values(results).filter(r => r?.error).length},
  results, live: liveResults};
writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out.totals), "live:", Object.keys(liveResults).length);
