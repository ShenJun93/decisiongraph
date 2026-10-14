import test from "node:test";
import assert from "node:assert/strict";
import {answerWithGraphTool,OWNER_LOOKUP_TOOL} from "../src/agent.mjs";
import {createLocalModel,localModelConfig} from "../src/local-model.mjs";

const asOf="2026-10-15T00:00:00.000Z";
const response=(name="get_project_owner_evidence",args='{"projectId":"orion"}')=>({
  choices:[{message:{tool_calls:[{id:"call_1",type:"function",
    function:{name,arguments:args}}]}}]
});
const synthetic=[{projectId:"orion",serviceId:"billing-gateway",claimId:"c-oct",
  effectiveAt:"2026-10-14T11:00:00.000Z",sourceId:"signed-change",sourceRank:90,
  ownerId:"ben",ownerName:"Ben (synthetic)"}];

test("LLM chooses one allowlisted tool; graph query supplies owner, not model text",async()=>{
  let modelCalls=0, graphCalls=0;
  const model=async(req)=>{
    modelCalls++;
    assert.equal(req.tool_choice,"required");
    assert.deepEqual(req.tools,[OWNER_LOOKUP_TOOL]);
    assert.match(req.messages[0].content,/MUST call/);
    return response();
  };
  const graph={async query(q,{params}){graphCalls++;assert.ok(q.includes("MATCH (project:Project"));assert.deepEqual(params,{projectId:"orion"});return synthetic;}};
  const out=await answerWithGraphTool({model,graph,projectId:"orion",asOf});
  assert.equal(modelCalls,1);assert.equal(graphCalls,1);
  assert.equal(out.status,"HUMAN_REVIEW_DRAFT");
  assert.equal(out.currentOwner.id,"ben");
  assert.equal(out.agentToolCallVerified,true);
  assert.equal(out.authorizedExternalActions,false);
});

test("model without tool call is not claimed to be agent",async()=>{
  let n=0;const graph={async query(){n++;return synthetic;}};
  const out=await answerWithGraphTool({model:async()=>({choices:[{message:{content:"Approve!"}}]}),graph,asOf});
  assert.equal(out.reason,"MODEL_TOOL_CALL_REQUIRED");assert.equal(n,0);
});

test("unrecognized or malicious tool calls never reach graph",async()=>{
  let n=0;const graph={async query(){n++;return synthetic;}};
  for (const bad of [response("delete_project"),response("get_project_owner_evidence",'{"projectId":"other"}'),
    response("get_project_owner_evidence",'{"projectId":"orion","force":true}'),
    response("get_project_owner_evidence","{")]) {
    const out=await answerWithGraphTool({model:async()=>bad,graph,asOf});
    assert.equal(out.status,"ABSTAIN");
  }
  assert.equal(n,0);
});

test("real graph outage is an abstain even after valid LLM tool selection",async()=>{
  const out=await answerWithGraphTool({model:async()=>response(),
    graph:{async query(){throw new Error("ECONNREFUSED")}},asOf});
  assert.equal(out.status,"ABSTAIN");
  assert.equal(out.reason,"GRAPH_UNAVAILABLE");
  assert.equal(out.agentToolCallVerified,true);
  assert.equal(out.proposedAction,null);
});

test("incomplete graph provenance never becomes a review draft",async()=>{
  const out=await answerWithGraphTool({model:async()=>response(),
    graph:{async query(){return [{...synthetic[0],sourceId:""}]}},asOf});
  assert.equal(out.reason,"INCOMPLETE_GRAPH_PROVENANCE");
  assert.equal(out.authorizedExternalActions,false);
});

test("model failure and invalid project ID abstain without querying graph",async()=>{
  let n=0;const graph={async query(){n++;return synthetic;}};
  const failed=await answerWithGraphTool({model:async()=>{throw Error("offline");},graph,asOf});
  assert.equal(failed.reason,"LOCAL_MODEL_UNAVAILABLE");
  const invalid=await answerWithGraphTool({model:async()=>response(),graph,projectId:"../secret",asOf});
  assert.equal(invalid.reason,"INVALID_AGENT_REQUEST");
  assert.equal(n,0);
});

test("model runtime cannot route requests to paid/remote endpoints",()=>{
  assert.throws(()=>localModelConfig({LOCAL_LLM_URL:"https://api.openai.com/v1/chat/completions",LOCAL_LLM_MODEL:"x"}));
  assert.throws(()=>localModelConfig({LOCAL_LLM_URL:"http://192.168.1.1:18080/v1/chat/completions",LOCAL_LLM_MODEL:"x"}));
  assert.throws(()=>localModelConfig({LOCAL_LLM_URL:"http://127.0.0.1:18080/v1/chat/completions"}));
  assert.equal(localModelConfig({LOCAL_LLM_URL:"http://127.0.0.1:18080/v1/chat/completions",LOCAL_LLM_MODEL:"verified-licensed-model"}).model,"verified-licensed-model");
});

test("local adapter issues a one-call tools payload without key or external actions",async()=>{
  let hits=0;
  const stub=async(url,options)=>{
    hits++;
    assert.match(url,/^http:\/\/127\.0\.0\.1:/);
    assert.equal(options.method,"POST");
    assert.equal(options.headers.authorization,undefined);
    const payload=JSON.parse(options.body);
    assert.equal(payload.model,"license-verified");
    assert.equal(payload.tool_choice,"required");
    return {ok:true,headers:{get(){return null;}},async text(){return JSON.stringify(response());}};
  };
  const model=createLocalModel({endpoint:"http://127.0.0.1:18080/v1/chat/completions",model:"license-verified"},stub);
  assert.deepEqual(await model({messages:[],tools:[OWNER_LOOKUP_TOOL],tool_choice:"required"}),response());
  assert.equal(hits,1);
});
