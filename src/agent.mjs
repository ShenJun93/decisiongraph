// Model-selected tool call, deterministic graph evidence, no automated external actions.
// The model is NOT trusted to authorize a release or invent graph evidence.
import {decideFromGraph, validId} from "./decision.mjs";

export const OWNER_LOOKUP_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "get_project_owner_evidence",
    description: "Read live FalkorDB provenance paths and return an abstain-or-human-review draft. Never approves a release.",
    parameters: {
      type: "object",
      properties: {projectId: {type: "string", description: "Exact project ID provided by the user"}},
      required: ["projectId"],
      additionalProperties: false
    }
  }
});

function stop(projectId, reason) {
  return {status:"ABSTAIN",reason,projectId,proposedAction:null,authorizedExternalActions:false,
    agentToolCallVerified:false};
}

export async function answerWithGraphTool({model,graph,projectId="orion",
  question="Who owns this release?",asOf=new Date().toISOString()}={}) {
  if (!validId(projectId) || typeof question!=="string" || question.length<1 || question.length>600) {
    return stop(projectId,"INVALID_AGENT_REQUEST");
  }
  if (typeof model!=="function" || !graph || typeof graph.query!=="function") {
    return stop(projectId,"DEPENDENCY_UNAVAILABLE");
  }
  let reply;
  try {
    reply=await model({
      messages:[
        {role:"system",content:"You are a company-graph evidence router. You MUST call get_project_owner_evidence exactly once with the exact project ID from the user. Do not approve changes, create actions, invent sources, or request additional tools."},
        {role:"user",content:JSON.stringify({question,projectId})}
      ],
      tools:[OWNER_LOOKUP_TOOL],tool_choice:"required",temperature:0
    });
  } catch {
    return stop(projectId,"LOCAL_MODEL_UNAVAILABLE");
  }
  const calls=reply?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length!==1) {
    return stop(projectId,"MODEL_TOOL_CALL_REQUIRED");
  }
  const call=calls[0];
  if (call?.type!=="function" || call.function?.name!=="get_project_owner_evidence" ||
      typeof call.function?.arguments!=="string" || call.function.arguments.length>512) {
    return stop(projectId,"UNAUTHORIZED_MODEL_TOOL");
  }
  let args;
  try { args=JSON.parse(call.function.arguments); } catch {
    return stop(projectId,"INVALID_MODEL_TOOL_ARGUMENTS");
  }
  if (!args || Object.keys(args).length!==1 || args.projectId!==projectId) {
    return stop(projectId,"MODEL_PROJECT_SCOPE_MISMATCH");
  }
  // This is a real parameterized Cypher query when connected to a live graph.
  // The model does not write Cypher, choose endpoints or authorize real actions.
  const evidence=await decideFromGraph(graph,{projectId,asOf});
  return {...evidence,agentToolCallVerified:true,
    agentTool:"get_project_owner_evidence",
    agentInterpretation:"NOT_TRUSTED_FOR_APPROVAL",
    authorizedExternalActions:false};
}
