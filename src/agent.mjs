// Company Brain agent. Nemotron routes a free-text question to one of three read-only graph tools
// and later phrases the result. Code checks everything the model says:
//  - the tool's subject must be an entity that exists in the graph AND that the question names;
//  - the point in time comes from a deterministic date parser, never from the model;
//  - the explanation is kept only if it names nobody outside the evidence and agrees with the result.
import {entityNames, firstName, mentions, plain} from "./corpus.mjs";
import {ownerOfProject, ownerOfService, OWNER_CYPHER, PROJECT_SERVICES_CYPHER} from "./decision.mjs";
import {DECISION_CHAIN_CYPHER, DECISION_DETAIL_CYPHER, PAGERANK_CYPHER, traceDecision, whoKnows, WHO_KNOWS_CYPHER} from "./knowledge.mjs";

export const ENTITIES_CYPHER = {
  projects: "MATCH (p:Project) OPTIONAL MATCH (p)-[:USES]->(s:Service) RETURN p.id AS id, p.name AS name, p.aliases AS aliases, collect(s.id) AS serviceIds ORDER BY p.id",
  services: "MATCH (s:Service) RETURN s.id AS id, s.name AS name, s.aliases AS aliases ORDER BY s.id",
  topics: "MATCH (t:Topic) RETURN t.id AS id, t.name AS name, t.aliases AS aliases ORDER BY t.id",
  decisions: "MATCH (d:Decision) WHERE d.recorded RETURN d.id AS id, d.title AS title ORDER BY d.id",
  people: "MATCH (p:Person) RETURN p.id AS id, p.name AS name ORDER BY p.id"
};

export async function loadEntities(graph) {
  const out = {};
  for (const [k, q] of Object.entries(ENTITIES_CYPHER)) out[k] = (await graph.query(q))?.data || [];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Time. "Who owned X on September 25?" must be answered as of that date, and vague times refuse.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const VAGUE = new RegExp(`\\b(last (week|month|year|quarter|sprint)|(a|one|two|few) (days?|weeks?|months?) ago|used to|previously|back then|earlier this (week|month|year)|next (week|month)|in ${MONTH_RE}(?!\\s*\\d))\\b`, "i");

const pad = n => String(n).padStart(2, "0");
const endOfDay = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d, 23, 59, 59));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString() : null;
};

/** Returns {asOf, matched, source} or {error, matched}. Pure; unit tested. */
export function parseQuestionTime(question, now = new Date()) {
  const q = String(question || "");
  const found = [];
  for (const m of q.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) found.push({text: m[0], y: +m[1], mo: +m[2], d: +m[3]});
  for (const m of q.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\b`, "gi"))) {
    found.push({text: m[0], y: m[3] ? +m[3] : now.getUTCFullYear(), mo: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, d: +m[2]});
  }
  for (const m of q.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(20\\d\\d))?\\b`, "gi"))) {
    found.push({text: m[0], y: m[3] ? +m[3] : now.getUTCFullYear(), mo: MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, d: +m[1]});
  }
  const dates = [...new Map(found.map(f => [`${f.y}-${f.mo}-${f.d}`, f])).values()];
  if (dates.length > 1) return {error: "AMBIGUOUS_TIME", matched: dates.map(d => d.text).join(" / ")};
  if (dates.length === 1) {
    const f = dates[0];
    const asOf = endOfDay(f.y, f.mo, f.d);
    if (!asOf) return {error: "AMBIGUOUS_TIME", matched: f.text};
    if (Date.parse(`${f.y}-${pad(f.mo)}-${pad(f.d)}T00:00:00Z`) > now.getTime()) return {error: "FUTURE_TIME", matched: f.text};
    return {asOf, matched: f.text, source: "question"};
  }
  if (/\byesterday\b/i.test(q)) {
    const y = new Date(now.getTime() - 86400000);
    return {asOf: endOfDay(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate()), matched: "yesterday", source: "question"};
  }
  const vague = VAGUE.exec(q);
  if (vague) return {error: "AMBIGUOUS_TIME", matched: vague[0]};
  return {asOf: now.toISOString(), matched: null, source: "now"};
}

// ---------------------------------------------------------------------------------------------
// Tools. Each subject is an enum of ids that exist in the graph right now.

export function agentTools(e) {
  const tool = (name, description, ids) => ({type: "function", function: {name, description,
    parameters: {type: "object", properties: {subjectId: {type: "string", enum: ids}}, required: ["subjectId"], additionalProperties: false}}});
  return [
    tool("owner_of", "Who owns, is responsible for, or should sign off a project or service. Reads ownership claims with their sources.",
      [...e.projects.map(p => p.id), ...e.services.map(s => s.id)]),
    tool("who_knows", "Who has hands-on knowledge of a service or topic (resolved tickets, wrote runbooks/ADRs, discussed it): who to ask.",
      [...e.services.map(s => s.id), ...e.topics.map(t => t.id)]),
    tool("trace_decision", "Why something was decided: an architecture decision (ADR) or the decisions affecting a service, with sources and what superseded what.",
      [...e.decisions.map(d => d.id), ...e.services.map(s => s.id)])
  ];
}

const decisionNames = d => {
  const n = d.id.split("-")[1];
  return [d.id, `adr${n}`, `adr ${n}`, `adr-${Number(n)}`, `adr ${Number(n)}`, d.title].filter(Boolean).map(s => s.toLowerCase());
};

/** The subject must be something the question actually names (or a service of a project it names). */
export function grounded(question, subjectId, e) {
  const find = list => list.find(x => x.id === subjectId);
  const project = find(e.projects), service = find(e.services), topic = find(e.topics), decision = find(e.decisions);
  if (decision) return mentions(question, decisionNames(decision));
  const self = project || service || topic;
  if (!self) return false;
  if (mentions(question, entityNames(self))) return true;
  if (service) return e.projects.some(p => (p.serviceIds || []).includes(subjectId) && mentions(question, entityNames(p)));
  return false;
}

// ---------------------------------------------------------------------------------------------
// Explanations.

export const REASON_TEXT = Object.freeze({
  UNRESOLVED_EQUAL_AUTHORITY_CONFLICT: "equally authoritative records name different owners for the same moment",
  LOW_AUTHORITY_ONLY: "only low-authority sources (chat or wiki) name an owner",
  NO_GRAPH_EVIDENCE: "no record in the graph names an owner",
  NO_EVIDENCE_AT_THAT_TIME: "no record named an owner at that time",
  INCOMPLETE_GRAPH_PROVENANCE: "an ownership claim has no attesting source",
  EVIDENCE_RESULT_LIMIT: "too many claims to be sure none was missed",
  GRAPH_UNAVAILABLE: "the graph could not be read",
  UNKNOWN_SERVICE: "the service is not in the graph",
  UNKNOWN_PROJECT: "the project is not in the graph",
  UNKNOWN_DECISION: "the decision is not in the graph",
  UNKNOWN_SUBJECT: "the subject is not in the graph",
  AMBIGUOUS_TIME: "the question's time is too vague; ask with a specific date",
  FUTURE_TIME: "the graph cannot know the future",
  NOT_IN_GRAPH: "the question names nothing the company graph knows about",
  OUT_OF_SCOPE: "I answer questions about who owns what, who knows what, and why decisions were made"
});
const day = s => String(s || "").slice(0, 10);

export function templateExplanation(r) {
  if (r.kind === "owner") {
    const lines = (r.services || []).map(s => s.status === "OWNER"
      ? `${s.serviceName}: ${firstName(s.owner.name)}, per ${s.basis.sourceId} (${s.basis.sourceKind}, authority ${s.basis.authority}, ${day(s.basis.effectiveAt)}).`
      : `${s.serviceName || s.serviceId}: no owner named, because ${REASON_TEXT[s.reason] || s.reason}.`);
    return [...lines, "This is a draft for human review, not an approval."].join(" ");
  }
  if (r.kind === "expertise") {
    if (r.status !== "FOUND") return `I cannot say who knows this: ${REASON_TEXT[r.reason] || r.reason}.`;
    const [top, ...rest] = r.people;
    let s = `For ${r.subjectName}, ${firstName(top.name)} has the most hands-on evidence (${top.evidence.length} records)` +
      (rest.length ? `, then ${rest.slice(0, 2).map(p => firstName(p.name)).join(" and ")}.` : ".");
    if (r.busFactorWarning) s += ` Bus factor ${r.busFactor}: ${r.busFactor ? "only one person has" : "nobody has"} resolved tickets here.`;
    return s;
  }
  if (r.kind === "decision") {
    if (r.status !== "FOUND") return `I cannot trace this decision: ${REASON_TEXT[r.reason] || r.reason}.`;
    const cur = r.decisions.filter(d => d.current);
    return cur.map(d => `${d.id} "${d.title}" is current (decided by ${firstName(d.deciderName)} on ${day(d.at)}` +
      (d.supersedes.length ? `, supersedes ${d.supersedes.join(", ")}` : "") + ").").join(" ") +
      (r.asked && !r.decisions.find(d => d.id === r.asked)?.current ? ` ${r.asked} is superseded.` : "");
  }
  return REASON_TEXT[r.reason] || "No answer.";
}

const APPROVAL = /\b(is approved|are approved|approve the release|i approve|you can ship|cleared to (ship|release)|go ahead and (release|deploy|ship))\b/;
const REFUSAL = /\b(cannot|can't|unable|no owner|not enough|insufficient|abstain|conflict|unresolved|unclear|ambiguous)\b/;

/** Keep model text only if it names nobody outside the evidence and agrees with the graph's result. */
export function explanationAgrees(text, r, people) {
  if (typeof text !== "string" || text.trim().length < 10 || text.length > 1200) return false;
  const t = plain(text).toLowerCase();
  if (APPROVAL.test(t)) return false;
  const evidence = JSON.stringify(r).toLowerCase();
  for (const p of people) {
    const f = firstName(p.name).toLowerCase();
    if (mentions(t, [f]) && !evidence.includes(`"${p.id}"`)) return false;
  }
  if (r.kind === "owner") {
    const named = (r.services || []).filter(s => s.status === "OWNER");
    const winners = new Set(named.map(s => s.owner.id));
    for (const s of named) if (!mentions(t, [firstName(s.owner.name).toLowerCase()])) return false;
    // An outranked person must not be described as the owner.
    for (const p of people) {
      if (winners.has(p.id)) continue;
      const f = firstName(p.name).toLowerCase();
      // Quoting a record ("Dev owns the search index") is fine; asserting it is not.
      const unquoted = t.replace(/"[^"]{0,300}"/g, '""');
      if (new RegExp(`\\b${f}\\b[^.]{0,20}\\b(owns|is the (current )?owner|remains the owner|is responsible)`).test(unquoted)) return false;
    }
    if (named.length < (r.services || []).length && !REFUSAL.test(t)) return false;
    return true;
  }
  if (r.kind === "expertise") return r.status !== "FOUND" ? REFUSAL.test(t) : mentions(t, [firstName(r.people[0].name).toLowerCase()]);
  if (r.kind === "decision") {
    if (r.status !== "FOUND") return REFUSAL.test(t);
    return r.decisions.filter(d => d.current).every(d => t.includes(d.id.toLowerCase()));
  }
  return false;
}

const EXPLAIN_FOCUS = {
  owner: "Name the owner of each service in the result with the record that supports it. For a service with status " +
    "ABSTAIN, say clearly that no owner can be named and why. Do not mention services that are not in the result.",
  expertise: "Say who knows the subject best and why (resolved tickets, documents, comments), citing record ids. " +
    "If busFactorWarning is true, say the bus factor. Do not discuss ownership.",
  decision: "Say which decision is current, who decided it and when, what it superseded and which ticket motivated it, " +
    "citing record ids."
};

/** Remove citation artefacts such as 【...】 and normalise punctuation before checking or showing model text. */
export const tidy = s => plain(String(s || "")).replace(/\u3010[^\u3011]{0,200}\u3011/g, "").replace(/\s+([.,;:])/g, "$1")
  .replace(/[ \t]{2,}/g, " ").trim();

const compact = r => JSON.stringify(r, (k, v) => (k === "text" ? undefined : v)).slice(0, 6000);

// ---------------------------------------------------------------------------------------------

export const CYPHER_BY_TOOL = {
  owner_of: [PROJECT_SERVICES_CYPHER, OWNER_CYPHER],
  who_knows: [WHO_KNOWS_CYPHER, PAGERANK_CYPHER],
  trace_decision: [DECISION_CHAIN_CYPHER, DECISION_DETAIL_CYPHER]
};

export async function askCompanyBrain({model, graph, question, now = new Date()} = {}) {
  const trace = [];
  const done = (r, extra = {}) => ({question, trace, ...r, ...extra});
  const refuse = (reason, extra = {}) => done({status: reason === "OUT_OF_SCOPE" ? "OUT_OF_SCOPE" : "ABSTAIN", reason,
    explanation: (REASON_TEXT[reason] || reason).replace(/^./, c => c.toUpperCase()) + ".", explanationSource: "template", ...extra});

  if (typeof question !== "string" || question.trim().length < 3 || question.length > 600) return refuse("INVALID_QUESTION");
  if (typeof model !== "function" || !graph?.query) return refuse("DEPENDENCY_UNAVAILABLE");

  const time = parseQuestionTime(question, now);
  trace.push({step: "time", matched: time.matched, asOf: time.asOf || null, error: time.error || null});
  if (time.error) return refuse(time.error);

  let e;
  try { e = await loadEntities(graph); } catch { return refuse("GRAPH_UNAVAILABLE"); }
  const tools = agentTools(e);
  const list = (label, xs, f) => `${label}: ` + xs.map(f).join("; ");
  const routeMessages = [
        {role: "system", content: "You route questions about Larkspur Systems to its company knowledge graph. " +
          "If the question asks who owns/is responsible for/should sign off something (including everything a project " +
          "depends on), who knows something or who to ask, " +
          "or why something was decided, call exactly ONE tool with the subject the user names. If the user names nothing " +
          "in the lists below, or asks about anything else, do not call a tool; answer in one sentence that you can only " +
          "answer ownership, expertise and decision questions about this company.\n" +
          list("Projects", e.projects, p => `${p.id} = ${p.name}`) + "\n" +
          list("Services", e.services, s => `${s.id} = ${s.name}`) + "\n" +
          list("Topics", e.topics, t => `${t.id} = ${t.name}`) + "\n" +
          list("Decisions", e.decisions, d => `${d.id} = ${d.title}`) + "\n" +
          "Never approve anything, never invent people or sources, never answer from memory."},
        {role: "user", content: question}
      ];
  let reply;
  try {
    reply = await model({messages: routeMessages, tools, tool_choice: "auto", temperature: 0, max_tokens: 2048, thinking: false});
  } catch {
    return refuse("MODEL_UNAVAILABLE");
  }
  let calls = reply?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || !calls.length) {
    // The model declined a tool. If the question still names something in the graph, ask once more with a
    // tool required; the grounding check below still applies.
    const named = [...e.projects, ...e.services, ...e.topics].some(x => mentions(question, entityNames(x))) ||
      e.decisions.some(d => mentions(question, decisionNames(d)));
    trace.push({step: "model_no_tool", retry: named});
    if (!named) return refuse("OUT_OF_SCOPE");
    try {
      reply = await model({messages: routeMessages, tools, tool_choice: "required", temperature: 0, max_tokens: 2048, thinking: false});
      calls = reply?.choices?.[0]?.message?.tool_calls;
    } catch { return refuse("MODEL_UNAVAILABLE"); }
    if (!Array.isArray(calls) || !calls.length) return refuse("OUT_OF_SCOPE");
  }
  const call = calls[0];
  const tool = call?.function?.name;
  let args;
  try { args = JSON.parse(call?.function?.arguments || "null"); } catch { args = null; }
  const allowed = tools.find(t => t.function.name === tool)?.function.parameters.properties.subjectId.enum || [];
  if (calls.length !== 1 || !args || Object.keys(args).length !== 1 || !allowed.includes(args.subjectId)) {
    trace.push({step: "model_tool_call_rejected", tool: tool || null});
    return refuse("NOT_IN_GRAPH");
  }
  const subjectId = args.subjectId;
  trace.push({step: "model_tool_call", tool, subjectId});
  if (!grounded(question, subjectId, e)) {
    trace.push({step: "grounding_failed", subjectId});
    return refuse("NOT_IN_GRAPH", {tool, subjectId});
  }

  const asOf = time.asOf;
  let result;
  if (tool === "owner_of") {
    result = e.projects.some(p => p.id === subjectId)
      ? await ownerOfProject(graph, {projectId: subjectId, asOf})
      : await (async () => {
        const s = await ownerOfService(graph, {serviceId: subjectId, asOf});
        return {kind: "owner", serviceId: subjectId, asOf, services: [s], status: s.status === "OWNER" ? "OWNER" : "ABSTAIN"};
      })();
  } else if (tool === "who_knows") {
    result = await whoKnows(graph, {subjectId, asOf});
  } else {
    result = await traceDecision(graph, {subjectId});
  }
  trace.push({step: "graph_query", tool, status: result.status, reason: result.reason || null});

  let explanation = null, explanationSource = "template";
  try {
    const second = await model({
      messages: [
        {role: "system", content: "Explain the graph result below to a busy engineer in at most 3 sentences. Use only " +
          "the given evidence and cite record ids. Never say anything is approved. " + EXPLAIN_FOCUS[result.kind]},
        {role: "user", content: compact({question, result})}
      ],
      temperature: 0, max_tokens: 1500, thinking: false
    });
    const text = tidy(second?.choices?.[0]?.message?.content);
    if (explanationAgrees(text, result, e.people)) { explanation = text; explanationSource = "model"; }
    else trace.push({step: "model_explanation_rejected", text: text.slice(0, 400)});
  } catch {
    trace.push({step: "model_explanation_unavailable"});
  }
  if (!explanation) explanation = templateExplanation(result);
  trace.push({step: "explanation", source: explanationSource});
  return done({...result, tool, subjectId, time, explanation, explanationSource, cypher: CYPHER_BY_TOOL[tool]});
}
