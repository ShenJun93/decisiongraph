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

// ---------------------------------------------------------------------------------------------
// Free-text questions. The model picks the project (only projects that exist in the graph) and
// writes a short explanation; the graph policy decides. The explanation is checked against the
// decision and replaced by a template if it disagrees, so the model cannot override the graph.

export const PROJECTS_CYPHER =
  "MATCH (p:Project) RETURN p.id AS id, p.name AS name ORDER BY p.id LIMIT 100";

export async function listProjects(graph) {
  const reply = await graph.query(PROJECTS_CYPHER);
  const rows = Array.isArray(reply) ? reply : (reply?.data || []);
  return rows.filter(r => validId(r?.id) && typeof r?.name === "string")
    .map(r => ({id: r.id, name: r.name.slice(0, 80)}));
}

function projectTool(ids) {
  return {
    type: "function",
    function: {
      name: "get_project_owner_evidence",
      description: "Read live FalkorDB provenance paths for one project and return an abstain-or-human-review draft. Never approves a release.",
      parameters: {
        type: "object",
        properties: {projectId: {type: "string", enum: ids, description: "Project ID from the company graph"}},
        required: ["projectId"],
        additionalProperties: false
      }
    }
  };
}

const firstName = s => String(s || "").split(/[\s(]/)[0];

/** A fixed, evidence-only explanation used when the model's text is missing or disagrees. */
export function templateExplanation(d) {
  if (d.status === "HUMAN_REVIEW_DRAFT") {
    const others = d.contradictoryEvidence?.length || 0;
    return `${firstName(d.currentOwner.name)} is the current owner of ${d.serviceId}, per source ${d.basis.sourceId} ` +
      `(authority ${d.basis.authority}, effective ${d.basis.effectiveAt}). ${others} competing claim(s) were outranked. ` +
      "This is a draft for human review, not an approval.";
  }
  const why = {
    UNRESOLVED_EQUAL_AUTHORITY_CONFLICT: "two equally authoritative sources name different owners at the same time",
    INCOMPLETE_GRAPH_PROVENANCE: "an ownership claim in the graph has no attesting source",
    NO_GRAPH_EVIDENCE: "the graph has no ownership claim for this project",
    GRAPH_UNAVAILABLE: "the graph could not be read"
  }[d.reason] || "the graph evidence is not sufficient";
  return `I cannot name an owner: ${why}. A human needs to resolve this before anyone acts.`;
}

/** True when free text is consistent with the decision (names the owner, or clearly refuses). */
export function explanationAgrees(text, d) {
  if (typeof text !== "string" || text.length < 10 || text.length > 1200) return false;
  const t = text.toLowerCase();
  if (/\b(is approved|approve the release|i approve|go ahead and (release|deploy|ship))\b/.test(t)) return false;
  if (d.status === "HUMAN_REVIEW_DRAFT") {
    const owner = firstName(d.currentOwner?.name).toLowerCase();
    return Boolean(owner) && t.includes(owner);
  }
  return /\b(cannot|unable|not enough|not sufficient|refuse|abstain|conflict|no attesting|no source|human)\b/.test(t) ||
    t.includes("can't") || t.includes("cannot");
}

export async function askCompanyBrain({model, graph, question, asOf = new Date().toISOString()} = {}) {
  if (typeof question !== "string" || question.trim().length < 3 || question.length > 600) {
    return {...stop(null, "INVALID_AGENT_REQUEST"), question};
  }
  if (typeof model !== "function" || !graph || typeof graph.query !== "function") {
    return {...stop(null, "DEPENDENCY_UNAVAILABLE"), question};
  }
  let projects;
  try { projects = await listProjects(graph); } catch {
    return {...stop(null, "GRAPH_UNAVAILABLE"), question};
  }
  if (!projects.length) return {...stop(null, "NO_PROJECTS_IN_GRAPH"), question};
  const ids = projects.map(p => p.id);
  const trace = [];

  let reply;
  try {
    reply = await model({
      messages: [
        {role: "system", content: "You route company questions to the company knowledge graph. You MUST call " +
          "get_project_owner_evidence exactly once, with the project the user asks about. Projects in the graph: " +
          projects.map(p => `${p.id} = ${p.name}`).join("; ") +
          ". Do not approve anything, invent sources or answer from memory."},
        {role: "user", content: question}
      ],
      tools: [projectTool(ids)], tool_choice: "required", temperature: 0
    });
  } catch {
    return {...stop(null, "MODEL_UNAVAILABLE"), question};
  }
  const calls = reply?.choices?.[0]?.message?.tool_calls;
  const call = Array.isArray(calls) ? calls[0] : null;
  if (!Array.isArray(calls) || calls.length !== 1 || call?.function?.name !== "get_project_owner_evidence" ||
      typeof call.function?.arguments !== "string" || call.function.arguments.length > 512) {
    return {...stop(null, "MODEL_TOOL_CALL_REQUIRED"), question};
  }
  let args;
  try { args = JSON.parse(call.function.arguments); } catch {
    return {...stop(null, "INVALID_MODEL_TOOL_ARGUMENTS"), question};
  }
  if (!args || Object.keys(args).length !== 1 || !ids.includes(args.projectId)) {
    return {...stop(args?.projectId ?? null, "MODEL_PROJECT_SCOPE_MISMATCH"), question};
  }
  trace.push({step: "model_tool_call", tool: "get_project_owner_evidence", projectId: args.projectId});

  const decision = await decideFromGraph(graph, {projectId: args.projectId, asOf});
  trace.push({step: "graph_query", status: decision.status, reason: decision.reason || null});

  let explanation = null, explanationSource = "template";
  try {
    const second = await model({
      messages: [
        {role: "system", content: "Explain the graph decision below to a busy engineer in at most 3 sentences. " +
          "Use only the given evidence. Name the owner if status is HUMAN_REVIEW_DRAFT; if status is ABSTAIN, say " +
          "clearly that no owner can be named and why. Never say a release is approved."},
        {role: "user", content: JSON.stringify({question, decision})}
      ],
      temperature: 0
    });
    const text = second?.choices?.[0]?.message?.content;
    if (explanationAgrees(text, decision)) { explanation = text.trim(); explanationSource = "model"; }
    else trace.push({step: "model_explanation_rejected"});
  } catch {
    trace.push({step: "model_explanation_unavailable"});
  }
  if (!explanation) explanation = templateExplanation(decision);
  trace.push({step: "explanation", source: explanationSource});

  return {...decision, question, explanation, explanationSource, trace,
    agentToolCallVerified: true, agentTool: "get_project_owner_evidence",
    agentInterpretation: "NOT_TRUSTED_FOR_APPROVAL", authorizedExternalActions: false};
}
