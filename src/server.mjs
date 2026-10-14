import http from "node:http";
import { openGraph } from "./db.mjs";
import { decideFromGraph, validId } from "./decision.mjs";

// Only loopback is exposed. No automatic real-world actions: drafts only.
const gateway = await openGraph();
await gateway.graph.query("RETURN 1 AS alive");
const port = Number(process.env.APP_PORT || 18737);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  await gateway.close();
  throw new Error("APP_PORT invalid");
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DecisionGraph | Graph Hacks 2026</title>
<style>
:root{font-family:system-ui,sans-serif;color-scheme:dark;background:#0e1625;color:#e4eefb}
body{max-width:860px;margin:3rem auto;padding:0 1rem}
article{background:#19283c;border:1px solid #3d5773;border-radius:14px;padding:1.5rem;margin-top:1rem}
label{display:block;margin-bottom:.6rem}
input,button{font:inherit;border:1px solid #53779c;padding:.6rem;background:#121f32;color:white;border-radius:8px}
button{background:#214e7d;cursor:pointer;margin-left:.5rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}
small{color:#9dc0de}
</style></head><body>
<h1>DecisionGraph</h1><p>Company Brain · synthetic release ownership evidence · FalkorDB Cypher</p>
<article><h2>Should Project Orion be approved?</h2>
<p>Shows <strong>human-review drafts only</strong>, not an automatic approval. Every owner comes from a live FalkorDB graph path.</p>
<form id="f"><label>Project ID <input id="id" value="orion" maxlength="48" required></label>
<button type="submit">Read live evidence</button></form>
<pre id="result">Not queried yet.</pre><small>The official source, claim, effective time and competing claims are displayed. Missing or conflicting graph evidence leads to ABSTAIN.</small></article>
<p><small>Local-only app. Source data is entirely synthetic. This deterministic prototype is not yet an LLM tool-calling agent.</small></p>
<script>
document.querySelector("#f").addEventListener("submit",async e=>{
 e.preventDefault();
 const output=document.querySelector("#result"); output.textContent="Reading graph…";
 try{
  const r=await fetch("/api/decision",{method:"POST",headers:{"content-type":"application/json"},
   body:JSON.stringify({projectId:document.querySelector("#id").value})});
  const data=await r.json();
  output.textContent=JSON.stringify(data,null,2);
 }catch(err){output.textContent="Graph unavailable: "+String(err);}
});
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
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,"http://127.0.0.1");
    if(req.method==="GET"&&url.pathname==="/") return send(res,200,PAGE,"text/html");
    if(req.method==="GET"&&url.pathname==="/api/health") {
      try {
        await gateway.graph.query("RETURN 1 AS alive");
        return send(res,200,{ok:true,graph:gateway.config.name,source:"LIVE_FALKORDB"});
      }catch{
        return send(res,503,{ok:false,reason:"GRAPH_UNAVAILABLE"});
      }
    }
    if(req.method==="POST"&&url.pathname==="/api/decision") {
      const data=await parseJson(req);
      if(!validId(data?.projectId)) return send(res,400,{error:"INVALID_PROJECT_ID"});
      const result=await decideFromGraph(gateway.graph,{projectId:data.projectId});
      return send(res,result.reason==="GRAPH_UNAVAILABLE"?503:200,result);
    }
    return send(res,404,{error:"NOT_FOUND"});
  }catch(e){return send(res,400,{error:String(e.message).slice(0,100)});}
});
server.listen(port,"127.0.0.1",()=>console.log("DecisionGraph local http://127.0.0.1:"+port));
async function shutdown(){server.close();await gateway.close();}
process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);
