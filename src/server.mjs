import http from "node:http";
import { openGraph } from "./db.mjs";
import { decideFromGraph, validId, LOOKUP_CYPHER } from "./decision.mjs";
import { askCompanyBrain, PROJECTS_CYPHER } from "./agent.mjs";
import { modelFromEnv } from "./hosted-model.mjs";
import { counterfactualAcceptance, ACCEPTANCE_GRAPH } from "../scripts/counterfactual-acceptance.mjs";

// Only loopback is exposed. No automatic real-world actions: drafts only.
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

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DecisionGraph | Graph Hacks 2026</title>
<style>
:root{--bg:#0d1420;--panel:#152133;--line:#2c4260;--text:#e6eef9;--dim:#93a9c4;--ok:#3ecf8e;--warn:#f5b041;--bad:#ef6b6b;--accent:#6ab0ff;
 font-family:Inter,system-ui,sans-serif;color-scheme:dark;background:var(--bg);color:var(--text)}
*{box-sizing:border-box}body{max-width:1080px;margin:0 auto;padding:28px 18px 60px}
h1{margin:0;font-size:30px}h1 span{color:var(--accent)}.sub{color:var(--dim);margin:6px 0 22px}
.ask{display:flex;gap:10px}.ask input{flex:1;font:inherit;font-size:17px;padding:13px 14px;border-radius:10px;border:1px solid var(--line);background:#0f1a2a;color:var(--text)}
button{font:inherit;border:1px solid var(--line);background:#1d3655;color:var(--text);border-radius:10px;padding:12px 16px;cursor:pointer}
button.primary{background:#2a6fdb;border-color:#2a6fdb;font-weight:600}button:disabled{opacity:.5;cursor:wait}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 22px}.chips button{padding:7px 12px;font-size:14px;background:#122236}
.grid{display:grid;grid-template-columns:1.25fr 1fr;gap:16px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
.card h3{margin:0 0 10px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.verdict{border-left:6px solid var(--line)}.verdict.ok{border-left-color:var(--ok)}.verdict.warn{border-left-color:var(--warn)}
.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:.04em}
.badge.ok{background:rgba(62,207,142,.15);color:var(--ok)}.badge.warn{background:rgba(245,176,65,.15);color:var(--warn)}
.owner{font-size:28px;font-weight:700;margin:10px 0 4px}.explain{line-height:1.55;margin:12px 0 0}
.chain{display:flex;flex-direction:column;gap:6px}.node{display:flex;align-items:center;gap:8px;font-family:ui-monospace,monospace;font-size:13px}
.pill{padding:5px 9px;border-radius:8px;background:#0f1a2a;border:1px solid var(--line)}.rel{color:var(--accent);font-size:12px;padding-left:18px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:7px 6px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--dim);font-weight:500}
.trace li{margin:5px 0;color:var(--dim)}.trace b{color:var(--text)}
pre{white-space:pre-wrap;font-size:12px;color:var(--dim);margin:0}.muted{color:var(--dim);font-size:13px}
.cf{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}@media(max-width:820px){.cf{grid-template-columns:repeat(2,1fr)}}
.cf div{background:#0f1a2a;border:1px solid var(--line);border-radius:10px;padding:10px;font-size:13px}.cf b{display:block;font-size:15px;margin-top:4px}
footer{margin-top:26px;color:var(--dim);font-size:13px}
</style></head><body>
<h1>Decision<span>Graph</span></h1>
<div class="sub">Company Brain on FalkorDB · ask who owns a release; the graph decides, or refuses · all data synthetic</div>
<form class="ask" id="f"><input id="q" maxlength="600" placeholder="Ask about a project, e.g. Who should sign off the Orion release?" required>
<button class="primary" id="go">Ask the graph</button></form>
<div class="chips" id="chips"></div>
<div id="out"><div class="card"><span class="muted">Ask a question. Nemotron picks the project, a parameterized Cypher query reads the live FalkorDB graph, and the provenance policy names an owner or abstains.</span></div></div>
<div class="card" style="margin-top:16px"><h3>Does the graph really drive the answer?</h3>
<div class="muted">Runs on a separate synthetic graph: read the owner, change one edge, add an equal-authority conflict, then restore.</div>
<button id="cfbtn" style="margin-top:10px">Run live counterfactual</button><div class="cf" id="cf"></div></div>
<footer id="foot"></footer>
<script>
const EX=["Who should sign off the Orion release?","Who owns the ML pipeline behind Vega?","Can I ship Nova today, and who approves it?","Who is responsible for Lyra's search index?"];
const $=s=>document.querySelector(s);const esc=s=>String(s??"").replace(/[&<>"']/g,c=>"&#"+c.charCodeAt(0)+";");
EX.forEach(t=>{const b=document.createElement("button");b.type="button";b.textContent=t;b.onclick=()=>{$("#q").value=t;ask();};$("#chips").append(b);});
fetch("/api/health").then(r=>r.json()).then(h=>{$("#foot").textContent="Graph: "+(h.graph||"?")+" ("+(h.source||"down")+") · Model: "+(h.model?.modelId||"not configured")+" via "+(h.model?.provider||"-")+" · drafts only, no external actions";});
$("#f").addEventListener("submit",e=>{e.preventDefault();ask();});
async function ask(){const q=$("#q").value.trim();if(!q)return;$("#go").disabled=true;$("#out").innerHTML='<div class="card muted">Asking Nemotron and reading the graph…</div>';
 try{const r=await fetch("/api/ask",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question:q})});render(await r.json());}
 catch(err){$("#out").innerHTML='<div class="card">Request failed: '+esc(err)+'</div>';}finally{$("#go").disabled=false;}}
function render(d){
 const ok=d.status==="HUMAN_REVIEW_DRAFT";const reason={UNRESOLVED_EQUAL_AUTHORITY_CONFLICT:"Equal-authority sources disagree",INCOMPLETE_GRAPH_PROVENANCE:"A claim has no attesting source",NO_GRAPH_EVIDENCE:"No ownership evidence"}[d.reason]||d.reason;
 let html='<div class="grid"><div class="card verdict '+(ok?"ok":"warn")+'"><h3>Decision · project '+esc(d.projectId||"?")+'</h3>'+
  '<span class="badge '+(ok?"ok":"warn")+'">'+(ok?"HUMAN REVIEW DRAFT":"ABSTAIN")+'</span>'+
  '<div class="owner">'+(ok?esc(d.currentOwner.name):"No owner named")+'</div>'+
  '<div class="muted">'+(ok?"Service "+esc(d.serviceId)+" · source "+esc(d.basis.sourceId)+" · authority "+esc(d.basis.authority)+" · effective "+esc(d.basis.effectiveAt):esc(reason))+'</div>'+
  '<p class="explain">'+esc(d.explanation)+'</p><div class="muted">Explanation: '+(d.explanationSource==="model"?"Nemotron (checked against the decision)":"template (model text missing or disagreed)")+'</div>';
 if(ok&&d.proposedAction)html+='<p class="muted">Proposed: '+esc(d.proposedAction.summary)+' <b>Draft only, needs human approval.</b></p>';
 html+='</div><div class="card"><h3>Evidence path in the graph</h3>';
 if(ok){html+='<div class="chain">';
  d.basis.path.forEach(edge=>{const m=edge.match(/^(.*) -(\\w+)-> (.*)$/);if(!m)return;
   html+='<div class="node"><span class="pill">'+esc(m[1])+'</span><span class="rel">—'+esc(m[2])+'→</span><span class="pill">'+esc(m[3])+'</span></div>';});
  html+='</div><div class="muted" style="margin-top:8px">Each edge is a real relationship returned by the Cypher query.</div>';}
 else if(d.competing){html+='<table><tr><th>Owner</th><th>Source</th><th>Authority</th><th>Effective</th></tr>'+d.competing.map(c=>'<tr><td>'+esc(c.ownerId)+'</td><td>'+esc(c.sourceId)+'</td><td>'+esc(c.authority)+'</td><td>'+esc(c.effectiveAt)+'</td></tr>').join("")+'</table>';}
 else html+='<div class="muted">The policy refused before naming anyone: '+esc(reason)+'.</div>';
 html+='</div></div><div class="grid" style="margin-top:16px">';
 html+='<div class="card"><h3>Outranked claims</h3>'+((d.contradictoryEvidence||[]).length?'<table><tr><th>Owner</th><th>Source</th><th>Authority</th><th>Effective</th></tr>'+d.contradictoryEvidence.map(c=>'<tr><td>'+esc(c.ownerId)+'</td><td>'+esc(c.sourceId)+'</td><td>'+esc(c.authority)+'</td><td>'+esc(c.effectiveAt)+'</td></tr>').join("")+'</table>':'<div class="muted">None.</div>')+'</div>';
 html+='<div class="card"><h3>What the agent did</h3><ol class="trace">'+(d.trace||[]).map(s=>'<li><b>'+esc(s.step)+'</b> '+esc(s.projectId||s.status||s.source||"")+(s.reason?" · "+esc(s.reason):"")+'</li>').join("")+'</ol><details><summary class="muted">Cypher it ran</summary><pre>'+esc(d.cypher||"")+'</pre></details></div></div>';
 $("#out").innerHTML=html;}
$("#cfbtn").onclick=async()=>{$("#cfbtn").disabled=true;$("#cf").innerHTML='<div>Running on the live graph…</div>';
 try{const r=await (await fetch("/api/counterfactual",{method:"POST"})).json();
  $("#cf").innerHTML=(r.readings||[]).map(x=>'<div>'+esc(x.case.replaceAll("_"," "))+'<b>'+esc(x.owner?("owner: "+x.owner):x.status)+'</b>'+(x.reason?'<span class="muted">'+esc(x.reason)+'</span>':"")+'</div>').join("")||esc(JSON.stringify(r));}
 catch(e){$("#cf").textContent=String(e);}finally{$("#cfbtn").disabled=false;}};
</script></body></html>`;

function send(res,status,body,type="application/json") {
  res.writeHead(status,{"content-type":type+"; charset=utf-8","cache-control":"no-store",
    "x-content-type-options":"nosniff"});
  res.end(type==="application/json"?JSON.stringify(body):body);
}
async function parseJson(req) {
  let size=0; const chunks=[];
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>4096) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
let counterfactualRunning=false;
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,"http://127.0.0.1");
    if(req.method==="GET"&&url.pathname==="/") return send(res,200,PAGE,"text/html");
    if(req.method==="GET"&&url.pathname==="/api/health") {
      try {
        await gateway.graph.query("RETURN 1 AS alive");
        return send(res,200,{ok:true,graph:gateway.config.name,source:"LIVE_FALKORDB",model:agentInfo});
      }catch{
        return send(res,503,{ok:false,reason:"GRAPH_UNAVAILABLE",model:agentInfo});
      }
    }
    if(req.method==="POST"&&url.pathname==="/api/ask") {
      const data=await parseJson(req);
      if(!agentModel) return send(res,503,{status:"ABSTAIN",reason:"MODEL_NOT_CONFIGURED",detail:agentInfo.error});
      const result=await askCompanyBrain({model:agentModel,graph:gateway.graph,question:data?.question});
      return send(res,200,{...result,cypher:[PROJECTS_CYPHER,LOOKUP_CYPHER].join("\n\n")});
    }
    if(req.method==="POST"&&url.pathname==="/api/decision") {
      const data=await parseJson(req);
      if(!validId(data?.projectId)) return send(res,400,{error:"INVALID_PROJECT_ID"});
      const result=await decideFromGraph(gateway.graph,{projectId:data.projectId});
      return send(res,result.reason==="GRAPH_UNAVAILABLE"?503:200,result);
    }
    if(req.method==="POST"&&url.pathname==="/api/counterfactual") {
      if(counterfactualRunning) return send(res,409,{error:"ALREADY_RUNNING"});
      counterfactualRunning=true;
      const conn=await openGraph({...process.env,GRAPH_NAME:ACCEPTANCE_GRAPH});
      try { return send(res,200,await counterfactualAcceptance(conn.graph)); }
      finally { await conn.close(); counterfactualRunning=false; }
    }
    return send(res,404,{error:"NOT_FOUND"});
  }catch(e){return send(res,400,{error:String(e.message).slice(0,100)});}
});
server.listen(port,"127.0.0.1",()=>console.log("DecisionGraph local http://127.0.0.1:"+port));
async function shutdown(){server.close();await gateway.close();}
process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);
