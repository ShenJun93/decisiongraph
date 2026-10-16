// Company Brain agent. Nemotron routes a free-text question to one of five read-only graph tools
// and later phrases the result. Code checks everything the model says:
//  - the tool's subject must be an entity that exists in the graph AND that the question names;
//  - the point in time comes from a deterministic date parser, never from the model;
//  - the explanation is kept only if it names nobody outside the evidence and agrees with the result.
// MODEL_PROVIDER=offline swaps the model for fixed routing rules and template answers (no API key needed).
import {entityNames, firstName, mentions, personNames, plain} from "./corpus.mjs";
import {OWNER_CYPHER, ownerOfProject, ownerOfService, PROJECT_SERVICES_CYPHER} from "./decision.mjs";
import {
  DECISION_CHAIN_CYPHER, DECISION_DETAIL_CYPHER, PAGERANK_CYPHER, PERSON_CYPHER, PERSON_DECISIONS_CYPHER,
  PERSON_KNOWS_CYPHER, profile, SEARCH_CYPHER, searchRecords, searchTerms, TEAM_PROFILE_CYPHER, traceDecision,
  whoKnows, WHO_KNOWS_CYPHER
} from "./knowledge.mjs";

export const ENTITIES_CYPHER = {
  projects: "MATCH (p:Project) OPTIONAL MATCH (p)-[:USES]->(s:Service) RETURN p.id AS id, p.name AS name, p.aliases AS aliases, collect(s.id) AS serviceIds ORDER BY p.id",
  services: "MATCH (s:Service) RETURN s.id AS id, s.name AS name, s.aliases AS aliases ORDER BY s.id",
  topics: "MATCH (t:Topic) RETURN t.id AS id, t.name AS name, t.aliases AS aliases ORDER BY t.id",
  decisions: "MATCH (d:Decision) WHERE d.recorded RETURN d.id AS id, d.title AS title ORDER BY d.id",
  people: "MATCH (p:Person) RETURN p.id AS id, p.name AS name ORDER BY p.id",
  teams: "MATCH (t:Team) RETURN t.id AS id, t.name AS name ORDER BY t.id"
};

export async function loadEntities(graph) {
  const out = {};
  for (const [k, q] of Object.entries(ENTITIES_CYPHER)) out[k] = (await graph.query(q))?.data || [];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Time. "Who owned X on September 25?" must be answered as of that date. Anything vaguer refuses
// instead of silently becoming "now".

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const WEEKDAY = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const VAGUE = [
  /\b(last|previous|past) (week|month|year|quarter|sprint|time|release)\b/i,
  new RegExp(`\\b(last|this|next) ${WEEKDAY}\\b`, "i"),
  new RegExp(`\\b(on )?${WEEKDAY}\\b`, "i"),
  /\b(\d+|a|an|one|two|three|few|couple of|several) (days?|weeks?|months?|years?) ago\b/i,
  /\b(in|during|throughout) (20\d\d)\b/i,
  new RegExp(`\\b(in|during|throughout|early|late|mid)[ -]${MONTH_RE}(?![a-z]*\\.?\\s*\\d{1,2}\\b)`, "i"),
  new RegExp(`\\b${MONTH_RE},?\\s+20\\d\\d\\b`, "i"),
  /\b(start|beginning|end|middle) of\b/i,
  /\bon the \d{1,2}(st|nd|rd|th)\b/i,
  /\b(used to|previously|back then|at the time|recently|earlier this|earlier today|this morning|last night|next (week|month))\b/i,
  /\b(before|after|since|until|prior to) (the )?(change|transfer|handover|reorg|migration|adr|cc|[a-z]+-\d+)/i
];
const RANGE = /\b(before|after|since|until|prior to|between)\b/i;

const pad = n => String(n).padStart(2, "0");
const endOfDay = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d, 23, 59, 59));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString() : null;
};

/** Returns {asOf, matched, source} or {error, matched}. Pure; unit tested. */
export function parseQuestionTime(question, now = new Date()) {
  const q = String(question || "");
  const found = [], bad = [];
  for (const m of q.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) found.push({text: m[0], y: +m[1], mo: +m[2], d: +m[3]});
  for (const m of q.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d\d)\b/g)) {
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) found.push({text: m[0], y: +m[3], mo: b, d: a});
    else if (b > 12 && a <= 12) found.push({text: m[0], y: +m[3], mo: a, d: b});
    else if (a === b) found.push({text: m[0], y: +m[3], mo: a, d: b});
    else bad.push(m[0]); // 3/4/2026: March 4 or 3 April?
  }
  for (const m of q.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\b(?!\\s*:)`, "gi"))) {
    found.push({text: m[0], y: m[3] ? +m[3] : now.getUTCFullYear(), mo: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, d: +m[2]});
  }
  for (const m of q.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(20\\d\\d))?\\b`, "gi"))) {
    found.push({text: m[0], y: m[3] ? +m[3] : now.getUTCFullYear(), mo: MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, d: +m[1]});
  }
  if (bad.length) return {error: "AMBIGUOUS_TIME", matched: bad[0]};
  const dates = [...new Map(found.map(f => [`${f.y}-${f.mo}-${f.d}`, f])).values()];
  if (dates.length > 1) return {error: "AMBIGUOUS_TIME", matched: dates.map(d => d.text).join(" / ")};
  if (dates.length === 1) {
    const f = dates[0];
    const asOf = endOfDay(f.y, f.mo, f.d);
    if (!asOf) return {error: "AMBIGUOUS_TIME", matched: f.text};
    const range = RANGE.exec(q);
    if (range) return {error: "AMBIGUOUS_TIME", matched: `${range[0]} ${f.text}`}; // a range, not a moment
    if (Date.parse(`${f.y}-${pad(f.mo)}-${pad(f.d)}T00:00:00Z`) > now.getTime()) return {error: "FUTURE_TIME", matched: f.text};
    return {asOf, matched: f.text, source: "question"};
  }
  if (/\byesterday\b/i.test(q)) {
    const y = new Date(now.getTime() - 86400000);
    return {asOf: endOfDay(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate()), matched: "yesterday", source: "question"};
  }
  for (const re of VAGUE) {
    const m = re.exec(q);
    if (m) return {error: "AMBIGUOUS_TIME", matched: m[0]};
  }
  return {asOf: now.toISOString(), matched: null, source: "now"};
}

// ---------------------------------------------------------------------------------------------
// Tools. Each subject is an enum of ids that exist in the graph right now.

export function agentTools(e) {
  const tool = (name, description, ids) => ({type: "function", function: {name, description,
    parameters: {type: "object", properties: {subjectId: {type: "string", enum: ids}}, required: ["subjectId"], additionalProperties: false}}});
  return [
    tool("owner_of", "Who owns, is responsible for, or should sign off a project or service (and their team and team lead).",
      [...e.projects.map(p => p.id), ...e.services.map(s => s.id)]),
    tool("who_knows", "Who has hands-on knowledge of a service or topic (resolved tickets, wrote runbooks/ADRs, discussed it): who to ask.",
      [...e.services.map(s => s.id), ...e.topics.map(t => t.id)]),
    tool("trace_decision", "Why something was decided: an architecture decision (ADR), or the decisions about a service or topic, with sources and what superseded what.",
      [...e.decisions.map(d => d.id), ...e.services.map(s => s.id), ...e.topics.map(t => t.id)]),
    tool("person_or_team", "About a person or a team: their team and lead, what they own, what they know, what they decided.",
      [...e.people.map(p => p.id), ...e.teams.map(t => t.id)]),
    {type: "function", function: {name: "search_records",
      description: "Full-text search of the company's records (docs, tickets, chat) for words from the question, when no other tool fits.",
      parameters: {type: "object", properties: {query: {type: "string", maxLength: 80, description: "2-5 words copied from the question"}},
        required: ["query"], additionalProperties: false}}}
  ];
}

const STOPWORDS = new Set(["about", "after", "before", "where", "which", "their", "there", "these", "those", "would", "should"]);
const keywords = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length >= 5 && !STOPWORDS.has(w));

const decisionNames = d => {
  const n = d.id.split("-")[1];
  return [d.id, `adr${n}`, `adr ${n}`, `adr-${Number(n)}`, `adr ${Number(n)}`, d.title].filter(Boolean).map(s => s.toLowerCase());
};
const decisionNamed = (question, d) => {
  if (mentions(question, decisionNames(d))) return true;
  const q = new Set(keywords(question));
  return keywords(d.title).filter(w => q.has(w)).length >= 2; // e.g. "transactional outbox"
};
const teamNames = t => [t.name, t.id, `${t.name} team`].map(s => s.toLowerCase());

/** Every entity the question names, by kind. */
export function namedEntities(question, e) {
  return {
    projects: e.projects.filter(x => mentions(question, entityNames(x))),
    services: e.services.filter(x => mentions(question, entityNames(x))),
    topics: e.topics.filter(x => mentions(question, entityNames(x))),
    decisions: e.decisions.filter(d => decisionNamed(question, d)),
    people: e.people.filter(p => mentions(question, personNames(p))),
    teams: e.teams.filter(t => mentions(question, teamNames(t)))
  };
}
const anyNamed = n => Object.values(n).some(list => list.length);

/** The subject must be something the question actually names (or a service of a project it names). */
export function grounded(question, tool, args, e) {
  if (tool === "search_records") {
    const terms = searchTerms(args.query);
    const q = String(question).toLowerCase();
    return terms.length > 0 && terms.every(t => q.includes(t));
  }
  const id = args.subjectId;
  const find = list => list.find(x => x.id === id);
  const decision = find(e.decisions);
  if (decision) return decisionNamed(question, decision);
  const person = find(e.people);
  if (person) return mentions(question, personNames(person));
  const team = find(e.teams);
  if (team) return mentions(question, teamNames(team));
  const service = find(e.services);
  const self = find(e.projects) || service || find(e.topics);
  if (!self) return false;
  if (mentions(question, entityNames(self))) return true;
  if (service) return e.projects.some(p => (p.serviceIds || []).includes(id) && mentions(question, entityNames(p)));
  return false;
}

// ---------------------------------------------------------------------------------------------
// Fixed routing rules: used when MODEL_PROVIDER=offline (no API key). Same tools, same checks.

const longest = list => [...list].sort((a, b) => (b.name || "").length - (a.name || "").length)[0];

export function routeOffline(question, e) {
  const q = String(question).toLowerCase();
  const n = namedEntities(question, e);
  if (/\b(why|decided|decision|decide|adr)\b/.test(q)) {
    if (n.decisions.length) return {tool: "trace_decision", args: {subjectId: n.decisions[0].id}};
    const s = longest([...n.services, ...n.topics]);
    if (s) return {tool: "trace_decision", args: {subjectId: s.id}};
  }
  if (/\b(who knows|knows? (the )?most|expert|who (should|can|do) i ask|who to ask|familiar with|knowledge of)\b/.test(q)) {
    const s = longest([...n.services, ...n.topics]);
    if (s) return {tool: "who_knows", args: {subjectId: s.id}};
  }
  if (/\b(own|owns|owned|owner|sign(s|ed)? off|sign-off|responsible|accountable|approve[sd]?|in charge)\b/.test(q)) {
    if (n.projects.length) return {tool: "owner_of", args: {subjectId: longest(n.projects).id}};
    if (n.services.length) return {tool: "owner_of", args: {subjectId: longest(n.services).id}};
  }
  if (n.people.length) return {tool: "person_or_team", args: {subjectId: n.people[0].id}};
  if (n.teams.length) return {tool: "person_or_team", args: {subjectId: n.teams[0].id}};
  if (/\b(find|search|mention|mentions|mentioned|records?|docs?|where)\b/.test(q)) {
    const terms = searchTerms(q).filter(t => !["find", "search", "mention", "mentions", "mentioned", "records", "record", "docs", "where"].includes(t));
    if (terms.length) return {tool: "search_records", args: {query: terms.slice(0, 4).join(" ")}};
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Explanations.

export const REASON_TEXT = Object.freeze({
  UNRESOLVED_EQUAL_AUTHORITY_CONFLICT: "equally authoritative records name different owners for the same moment",
  LOW_AUTHORITY_ONLY: "only low-authority sources (chat or wiki) name an owner",
  NO_GRAPH_EVIDENCE: "no record in the graph supports an answer",
  NO_EVIDENCE_AT_THAT_TIME: "no record named an owner at that time",
  INCOMPLETE_GRAPH_PROVENANCE: "an ownership claim has no attesting source",
  EVIDENCE_RESULT_LIMIT: "too many claims to be sure none was missed",
  GRAPH_UNAVAILABLE: "the graph could not be read",
  MODEL_UNAVAILABLE: "the model could not be reached",
  UNKNOWN_SERVICE: "the service is not in the graph",
  UNKNOWN_PROJECT: "the project is not in the graph",
  UNKNOWN_DECISION: "the decision is not in the graph",
  UNKNOWN_SUBJECT: "the subject is not in the graph",
  INVALID_INPUT: "the request was not valid",
  INVALID_QUESTION: "the question is empty or too long",
  AMBIGUOUS_TIME: "the time in the question is not a single specific date; ask with one, e.g. \"on 2026-09-25\"",
  FUTURE_TIME: "the graph cannot know the future",
  NOT_IN_GRAPH: "the question names nothing the company graph knows about",
  SUBJECT_MISMATCH: "the model picked a subject the question does not name, so the answer was refused",
  OUT_OF_SCOPE: "I answer who owns what, who knows what, why things were decided, who is on which team, and what the records say"
});
const day = s => String(s || "").slice(0, 10);
const list = xs => xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];

export function templateExplanation(r) {
  if (r.kind === "owner") {
    const lines = (r.services || []).map(s => s.status === "OWNER"
      ? `${s.serviceName}: ${firstName(s.owner.name)}` + (s.owner.team ? ` (${s.owner.team} team, lead ${firstName(s.owner.lead?.name)})` : "") +
        `, per ${s.basis.sourceId} (${s.basis.sourceKind}, authority ${s.basis.authority}, effective ${day(s.basis.effectiveAt)}).`
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
      (d.supersedes.length ? `, supersedes ${d.supersedes.join(", ")}` : "") +
      (d.motivatedBy?.length ? `, motivated by ${d.motivatedBy.join(", ")}` : "") + ").").join(" ") +
      (r.asked && !r.decisions.find(d => d.id === r.asked)?.current ? ` ${r.asked} is superseded.` : "");
  }
  if (r.kind === "profile") {
    if (r.status !== "FOUND") return `I cannot describe this: ${REASON_TEXT[r.reason] || r.reason}.`;
    const owns = r.owns.length ? `owns ${list(r.owns.map(o => `${o.serviceName} (${o.sourceId})`))}` : "owns no service on record";
    if (r.subjectType === "team") {
      return `The ${r.name} team is led by ${r.lead ? firstName(r.lead.name) : "nobody on record"}; its members ${owns.replace(/^owns/, "own")}.`;
    }
    return `${r.name} (${r.role || "role unknown"}, ${r.team || "no team"} team, lead ${r.lead ? firstName(r.lead.name) : "unknown"}) ${owns}` +
      (r.knows.length ? `; has resolved tickets on ${list(r.knows.map(k => k.subject))}` : "") +
      (r.decided.length ? `; decided ${list(r.decided.map(d => d.id + (d.current ? "" : " (superseded)")))}` : "") + ".";
  }
  if (r.kind === "search") {
    if (r.status !== "FOUND") return `No record matches "${(r.terms || []).join(" ")}".`;
    const top = r.results[0];
    return `${r.results.length} records match "${r.terms.join(" ")}". Most relevant: ${top.id} (${top.kind}, ${day(top.at)}): "${top.snippet}"`;
  }
  return REASON_TEXT[r.reason] || "No answer.";
}

const APPROVAL = /\b(is approved|are approved|approve the release|i approve|you can ship|cleared to (ship|release)|go ahead and (release|deploy|ship))\b/;
const REFUSAL = /\b(cannot|can't|unable|no owner|not enough|insufficient|abstain|conflict|unresolved|unclear|ambiguous)\b/;
const LEAK = /\b(claimId|serviceId|sourceId|subjectId|ownerId|busFactorWarning)\b|\b[A-Z]{3,}(_[A-Z]{2,})+\b/;

/** Keep model text only if it names nobody outside the evidence and agrees with the graph's result. */
export function explanationAgrees(text, r, people) {
  if (typeof text !== "string" || text.trim().length < 10 || text.length > 1200) return false;
  if (LEAK.test(text)) return false; // internal field names or reason codes
  if ((text.match(/[.!?](\s|$)/g) || []).length > 4) return false; // asked for at most three sentences
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
    // An outranked person must not be described as the owner. Quoting a record is fine; asserting it is not.
    const unquoted = t.replace(/"[^"]{0,300}"/g, '""');
    for (const p of people) {
      if (winners.has(p.id)) continue;
      const f = firstName(p.name).toLowerCase();
      if (new RegExp(`\\b${f}\\b[^.;]{0,25}\\b(owns|owned|is the (current )?owner|was the owner|remains|is responsible|was responsible|is listed as|should sign)`).test(unquoted) ||
          new RegExp(`\\b(owned by|owner is|owner was|signed off by|sign off is|sign-off is)\\s+${f}\\b`).test(unquoted)) return false;
    }
    if (named.length < (r.services || []).length && !REFUSAL.test(t)) return false;
    return true;
  }
  if (r.kind === "expertise") {
    if (r.status !== "FOUND") return REFUSAL.test(t);
    if (/\b(owner|owns|owned|ownership)\b/.test(t.replace(/"[^"]{0,300}"/g, '""'))) return false; // expertise is not ownership
    return mentions(t, [firstName(r.people[0].name).toLowerCase()]);
  }
  if (r.kind === "decision") {
    if (r.status !== "FOUND") return REFUSAL.test(t);
    return r.decisions.filter(d => d.current).every(d => t.includes(d.id.toLowerCase()));
  }
  if (r.kind === "profile") return r.status === "FOUND" && mentions(t, [firstName(r.name).toLowerCase()]);
  if (r.kind === "search") return r.status === "FOUND" && r.results.some(x => t.includes(x.id.toLowerCase()));
  return false;
}

const EXPLAIN_FOCUS = {
  owner: "Name the owner of each service in the result with the record that supports it (and their team lead if " +
    "given). For a service with status ABSTAIN, say clearly that no owner can be named and why. Only the named owner " +
    "may be called the owner. Do not mention services that are not in the result.",
  expertise: "Say who knows the subject best and why (resolved tickets, documents, comments), citing record ids. " +
    "If there is a bus-factor warning, say the bus factor. Do not discuss ownership.",
  decision: "Say which decision is current, who decided it and when, what it superseded and which ticket motivated it, " +
    "citing record ids.",
  profile: "Summarise the person or team: team and lead, what they own (with record ids), what they know, what they decided.",
  search: "Say which records mention the words and quote the most relevant snippet with its record id."
};

/** Remove citation artefacts such as 【...】 and normalise punctuation before checking or showing model text. */
export const tidy = s => plain(String(s || "")).replace(/【[^】]{0,200}】/g, "").replace(/\s+([.,;:])/g, "$1")
  .replace(/[ \t]{2,}/g, " ").trim();

const compact = r => JSON.stringify(r, (k, v) => (k === "text" ? undefined : v)).slice(0, 6000);

// ---------------------------------------------------------------------------------------------

export const CYPHER_BY_TOOL = {
  owner_of: [PROJECT_SERVICES_CYPHER, OWNER_CYPHER],
  who_knows: [WHO_KNOWS_CYPHER, PAGERANK_CYPHER],
  trace_decision: [DECISION_CHAIN_CYPHER, DECISION_DETAIL_CYPHER],
  person_or_team: [PERSON_CYPHER, PERSON_KNOWS_CYPHER, PERSON_DECISIONS_CYPHER, TEAM_PROFILE_CYPHER, OWNER_CYPHER],
  search_records: [SEARCH_CYPHER]
};

async function runTool(graph, tool, args, e, asOf) {
  if (tool === "owner_of") {
    if (e.projects.some(p => p.id === args.subjectId)) return ownerOfProject(graph, {projectId: args.subjectId, asOf});
    const s = await ownerOfService(graph, {serviceId: args.subjectId, asOf});
    return {kind: "owner", serviceId: args.subjectId, asOf, services: [s], status: s.status === "OWNER" ? "OWNER" : "ABSTAIN"};
  }
  if (tool === "who_knows") return whoKnows(graph, {subjectId: args.subjectId, asOf});
  if (tool === "trace_decision") return traceDecision(graph, {subjectId: args.subjectId});
  if (tool === "person_or_team") return profile(graph, {subjectId: args.subjectId, asOf});
  return searchRecords(graph, {query: args.query});
}

function validCall(tool, args, tools) {
  const t = tools.find(x => x.function.name === tool);
  if (!t || !args || typeof args !== "object") return false;
  if (tool === "search_records") {
    return Object.keys(args).length === 1 && typeof args.query === "string" && args.query.length <= 80 && searchTerms(args.query).length > 0;
  }
  return Object.keys(args).length === 1 && t.function.parameters.properties.subjectId.enum.includes(args.subjectId);
}

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
  const named = namedEntities(question, e);
  let tool, args;

  if (model.offline) {
    const route = routeOffline(question, e);
    trace.push({step: "offline_route", tool: route?.tool || null, subjectId: route?.args?.subjectId || route?.args?.query || null});
    if (!route) return refuse("OUT_OF_SCOPE");
    ({tool, args} = route);
  } else {
    const names = (label, xs, f) => `${label}: ` + xs.map(f).join("; ");
    const routeMessages = [
      {role: "system", content: "You route questions about Larkspur Systems to its company knowledge graph. Call exactly " +
        "ONE tool with the subject the user names: owner_of for who owns / is responsible for / should sign off something " +
        "(including everything a project depends on); who_knows for who knows something or who to ask; trace_decision for " +
        "why something was decided; person_or_team for questions about a person or a team; search_records only when " +
        "nothing else fits. If the question is not about this company, do not call a tool; answer in one sentence that " +
        "you only answer questions about this company's owners, experts, decisions, teams and records.\n" +
        names("Projects", e.projects, p => `${p.id} = ${p.name}`) + "\n" +
        names("Services", e.services, s => `${s.id} = ${s.name}`) + "\n" +
        names("Topics", e.topics, t => `${t.id} = ${t.name}`) + "\n" +
        names("Decisions", e.decisions, d => `${d.id} = ${d.title}`) + "\n" +
        names("People", e.people, p => `${p.id} = ${p.name}`) + "\n" +
        names("Teams", e.teams, t => `${t.id} = ${t.name}`) + "\n" +
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
      const retry = anyNamed(named);
      trace.push({step: "model_no_tool", retry});
      if (!retry) return refuse("OUT_OF_SCOPE");
      try {
        reply = await model({messages: routeMessages, tools, tool_choice: "required", temperature: 0, max_tokens: 2048, thinking: false});
        calls = reply?.choices?.[0]?.message?.tool_calls;
      } catch { return refuse("MODEL_UNAVAILABLE"); }
      if (!Array.isArray(calls) || !calls.length) return refuse("OUT_OF_SCOPE");
    }
    tool = calls[0]?.function?.name;
    try { args = JSON.parse(calls[0]?.function?.arguments || "null"); } catch { args = null; }
    if (calls.length !== 1 || !validCall(tool, args, tools)) {
      trace.push({step: "model_tool_call_rejected", tool: tool || null});
      return refuse(anyNamed(named) ? "SUBJECT_MISMATCH" : "NOT_IN_GRAPH");
    }
    trace.push({step: "model_tool_call", tool, subjectId: args.subjectId || args.query});
  }

  if (!grounded(question, tool, args, e)) {
    trace.push({step: "grounding_failed", tool, subjectId: args.subjectId || args.query});
    return refuse(anyNamed(named) ? "SUBJECT_MISMATCH" : "NOT_IN_GRAPH", {tool, subjectId: args.subjectId || null});
  }

  const result = await runTool(graph, tool, args, e, time.asOf);
  trace.push({step: "graph_query", tool, status: result.status, reason: result.reason || null});

  let explanation = null, explanationSource = "template";
  if (!model.offline) {
    try {
      const second = await model({
        messages: [
          {role: "system", content: "Explain the graph result below to a busy engineer in at most 3 sentences. Use only " +
            "the given evidence and refer to records by their id (for example cc-1031). Do not mention internal field " +
            "names or codes. Never say anything is approved. " + EXPLAIN_FOCUS[result.kind]},
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
  }
  if (!explanation) explanation = templateExplanation(result);
  trace.push({step: "explanation", source: explanationSource});
  return done({...result, tool, subjectId: args.subjectId || null, query: args.query || null, time, explanation,
    explanationSource, cypher: CYPHER_BY_TOOL[tool]});
}
