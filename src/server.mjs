// Local web UI and JSON API. Loopback only; no automatic real-world actions.
import http from "node:http";
import {readFileSync} from "node:fs";
import {openGraph} from "./db.mjs";
import {askCompanyBrain, loadEntities} from "./agent.mjs";
import {modelFromEnv} from "./hosted-model.mjs";
import {liveSource, loadCorpus, validSourceId, AUTHORITY} from "./corpus.mjs";
import {extractSource} from "./extract.mjs";
import {deriveEdges, graphStats, writeSources} from "./graph-load.mjs";
import {seedGraph} from "../scripts/seed.mjs";
import {DEMO_QUESTIONS} from "../scripts/ask.mjs";
import {untrustedChatItem} from "./live-trust.mjs";

const PAGE = readFileSync(new URL("./page.html", import.meta.url), "utf8");
const gateway = await openGraph();
await gateway.graph.query("RETURN 1 AS alive");
const port = Number(process.env.APP_PORT || 18737);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  await gateway.close();
  throw new Error("APP_PORT invalid");
}
let agentModel = null, agentInfo = {provider: null, modelId: null, error: null};
try {
  const m = await modelFromEnv();
  agentModel = m.model;
  agentInfo = {provider: m.provider, modelId: m.modelId, error: null};
} catch (e) {
  agentInfo.error = String(e.message).slice(0, 120); // config problem only; never includes the key
}
const corpus = loadCorpus();
const cachedLive = (() => {
  try { return JSON.parse(readFileSync(new URL("../corpus/extracted.json", import.meta.url), "utf8")).live || {}; }
  catch { return {}; }
})();
const LIVE_KINDS = ["chat"]; // Unverified browser text must never impersonate a signed change-control record.

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {"content-type": type + "; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"});
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
async function parseJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// One graph mutation at a time; the flag is always released, even when a step fails.
let busy = false;
async function exclusive(res, fn) {
  if (busy) return send(res, 409, {error: "BUSY"});
  busy = true;
  try { return send(res, 200, await fn()); }
  catch (e) { return send(res, 500, {error: String(e?.message || e).slice(0, 120)}); }
  finally { busy = false; }
}

// Interactive input is not an authenticated company document: accept only unverified chat.
function customItem(d) {
  return untrustedChatItem(d, corpus.org.people);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html");
    if (req.method === "GET" && url.pathname === "/api/health") {
      try {
        await gateway.graph.query("RETURN 1 AS alive");
        return send(res, 200, {ok: true, graph: gateway.config.name, source: "LIVE_FALKORDB", model: agentInfo});
      } catch {
        return send(res, 503, {ok: false, reason: "GRAPH_UNAVAILABLE", model: agentInfo});
      }
    }
    if (req.method === "GET" && url.pathname === "/api/overview") {
      const stats = await graphStats(gateway.graph);
      const e = await loadEntities(gateway.graph);
      return send(res, 200, {stats, questions: DEMO_QUESTIONS, authority: AUTHORITY, offline: Boolean(agentModel?.offline),
        people: e.people, live: corpus.live.map(i => ({id: i.id, format: i.format, kind: i.kind || "chat",
          author: i.author, title: i.title || i.channel, text: i.text})), liveKinds: LIVE_KINDS});
    }
    if (req.method === "POST" && url.pathname === "/api/ask") {
      const data = await parseJson(req);
      if (!agentModel) return send(res, 503, {status: "ABSTAIN", reason: "MODEL_NOT_CONFIGURED", detail: agentInfo.error});
      return send(res, 200, await askCompanyBrain({model: agentModel, graph: gateway.graph, question: data?.question}));
    }
    if (req.method === "POST" && url.pathname === "/api/live") {
      const data = await parseJson(req);
      if (!agentModel) return send(res, 503, {error: "MODEL_NOT_CONFIGURED"});
      if (agentModel.offline && !data?.itemId) return send(res, 400, {error: "Custom records need a model (offline mode)"});
      const item = data?.itemId ? corpus.live.find(i => i.id === data.itemId) : customItem(data?.custom);
      if (!item || !validSourceId(item.id)) return send(res, 400, {error: "UNKNOWN_ITEM"});
      return exclusive(res, async () => {
        const src = liveSource(item);
        // Offline mode replays the facts Nemotron extracted for this record during `npm run ingest`.
        const facts = agentModel.offline ? (cachedLive[src.id] || {ownership: [], decisions: [], rejected: [], error: "NOT_CACHED"})
          : await extractSource(agentModel, src, corpus);
        if (facts.error) return {source: {id: src.id}, facts, written: false};
        const counts = await writeSources(gateway.graph, [src], {[src.id]: facts}, corpus);
        await deriveEdges(gateway.graph);
        return {source: {id: src.id, kind: src.kind, authority: src.authority, title: src.title, author: src.author, at: src.at,
          simulated: !data?.itemId}, facts, written: true, counts, replayed: Boolean(agentModel.offline)};
      });
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      return exclusive(res, async () => ({reset: true, ...(await seedGraph(gateway.graph))}));
    }
    return send(res, 404, {error: "NOT_FOUND"});
  } catch (e) {
    return send(res, 400, {error: String(e.message).slice(0, 100)});
  }
});
server.listen(port, "127.0.0.1", () => console.log("DecisionGraph http://127.0.0.1:" + port));
async function shutdown() { server.close(); await gateway.close(); }
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
