// "Who knows X?" and "Why did we decide Y?" over the company graph. Both are fixed, parameterized
// Cypher queries; the model only picks the subject.
import {ownerOfService, validId} from "./decision.mjs";

// Who has hands-on evidence about a service or topic, and how. Weights: resolving a ticket counts
// most, writing a runbook/ADR next, commenting on a ticket next, a chat mention least.
export const WHO_KNOWS_CYPHER = `
MATCH (t {id: $id})<-[:ABOUT|TAGGED]-(x:Ticket)<-[:RESOLVED]-(p:Person)
RETURN p.id AS personId, p.name AS name, 'resolved ticket' AS via, x.id AS item, 6 AS weight
UNION ALL
MATCH (t {id: $id})<-[:MENTIONS]-(x:Source)<-[:AUTHORED]-(p:Person) WHERE x.format = 'doc'
RETURN p.id AS personId, p.name AS name, 'wrote ' + x.kind AS via, x.id AS item, 4 AS weight
UNION ALL
MATCH (t {id: $id})<-[:ABOUT|TAGGED]-(:Ticket)<-[:ON]-(x:Comment)<-[:AUTHORED]-(p:Person)
RETURN p.id AS personId, p.name AS name, 'commented on ticket' AS via, x.id AS item, 2 AS weight
UNION ALL
MATCH (t {id: $id})<-[:MENTIONS]-(x:Message)<-[:AUTHORED]-(p:Person)
RETURN p.id AS personId, p.name AS name, 'discussed in chat' AS via, x.id AS item, 1 AS weight
`.trim();

// PageRank over who-worked-with-whom (shared tickets): a "go-to person" signal from FalkorDB's built-in algorithm.
export const PAGERANK_CYPHER =
  "CALL algo.pageRank('Person', 'COLLABORATED') YIELD node, score RETURN node.id AS personId, score";

export const TEAM_CYPHER = "MATCH (p:Person)-[:MEMBER_OF]->(t:Team) WHERE p.id IN $ids RETURN p.id AS personId, t.name AS team";

export async function whoKnows(graph, {subjectId, asOf}) {
  if (!validId(subjectId)) return {kind: "expertise", status: "ABSTAIN", reason: "INVALID_INPUT", subjectId};
  let subject, rows, ranks;
  try {
    subject = (await graph.query("MATCH (t {id: $id}) WHERE t:Service OR t:Topic RETURN t.name AS name, labels(t) AS labels",
      {params: {id: subjectId}}))?.data?.[0];
    if (!subject) return {kind: "expertise", status: "ABSTAIN", reason: "UNKNOWN_SUBJECT", subjectId};
    rows = (await graph.query(WHO_KNOWS_CYPHER, {params: {id: subjectId}}))?.data || [];
    ranks = new Map(((await graph.query(PAGERANK_CYPHER))?.data || []).map(r => [r.personId, Number(r.score)]));
  } catch {
    return {kind: "expertise", status: "ABSTAIN", reason: "GRAPH_UNAVAILABLE", subjectId};
  }
  const people = new Map();
  for (const r of rows) {
    const p = people.get(r.personId) || {id: r.personId, name: r.name, score: 0, evidence: []};
    if (!p.evidence.some(e => e.item === r.item && e.via === r.via)) {
      p.score += Number(r.weight);
      p.evidence.push({via: r.via, item: r.item});
    }
    people.set(r.personId, p);
  }
  const ranked = [...people.values()]
    .map(p => ({...p, pagerank: Number((ranks.get(p.id) || 0).toFixed(4))}))
    .sort((a, b) => b.score - a.score || b.pagerank - a.pagerank || a.id.localeCompare(b.id))
    .slice(0, 6);
  if (!ranked.length) return {kind: "expertise", status: "ABSTAIN", reason: "NO_GRAPH_EVIDENCE", subjectId, subjectName: subject.name};
  try {
    const teams = new Map(((await graph.query(TEAM_CYPHER, {params: {ids: ranked.map(p => p.id)}}))?.data || [])
      .map(r => [r.personId, r.team]));
    ranked.forEach(p => { p.team = teams.get(p.id) || null; });
  } catch { /* teams are optional context */ }
  const resolvers = new Set(rows.filter(r => r.via === "resolved ticket").map(r => r.personId));
  const isService = subject.labels?.includes("Service");
  const owner = isService ? await ownerOfService(graph, {serviceId: subjectId, asOf}) : null;
  return {
    kind: "expertise", status: "FOUND", subjectId, subjectName: subject.name, subjectType: isService ? "service" : "topic",
    people: ranked,
    busFactor: resolvers.size,
    busFactorWarning: resolvers.size <= 1,
    owner: owner ? {status: owner.status, reason: owner.reason || null, owner: owner.owner || null} : null
  };
}

// ---------------------------------------------------------------------------------------------

export const DECISION_CHAIN_CYPHER = `
MATCH (d:Decision {id: $id})
OPTIONAL MATCH (d)-[:SUPERSEDES*1..6]->(older:Decision)
OPTIONAL MATCH (newer:Decision)-[:SUPERSEDES*1..6]->(d)
RETURN collect(DISTINCT older.id) AS older, collect(DISTINCT newer.id) AS newer
`.trim();

export const DECISION_DETAIL_CYPHER = `
MATCH (d:Decision {id: $id})
OPTIONAL MATCH (src:Source)-[rec:RECORDS]->(d)
OPTIONAL MATCH (d)-[:DECIDED_BY]->(p:Person)
RETURN d.id AS id, d.title AS title, d.at AS at, d.recorded AS recorded,
       src.id AS sourceId, src.title AS sourceTitle, src.kind AS sourceKind, rec.quote AS quote,
       p.id AS deciderId, p.name AS deciderName
LIMIT 1
`.trim();

export const DECISION_LINKS_CYPHER = `
MATCH (d:Decision {id: $id})
OPTIONAL MATCH (d)-[:AFFECTS]->(s:Service)
OPTIONAL MATCH (d)-[:SUPERSEDES]->(o:Decision)
OPTIONAL MATCH (d)-[:MOTIVATED_BY]->(t:Ticket)
OPTIONAL MATCH (x:Source)-[:DISCUSSES]->(d)
RETURN collect(DISTINCT s.id) AS services, collect(DISTINCT o.id) AS supersedes,
       collect(DISTINCT t.id) AS motivatedBy, collect(DISTINCT x.id) AS discussedIn
`.trim();

// Decisions about a service (AFFECTS) or a topic (the recording ADR mentions it).
export const SERVICE_DECISIONS_CYPHER = `
MATCH (d:Decision)
WHERE (d)-[:AFFECTS]->(:Service {id: $id}) OR (:Topic {id: $id})<-[:MENTIONS]-(:Source)-[:RECORDS]->(d)
OPTIONAL MATCH (newer:Decision)-[:SUPERSEDES]->(d)
RETURN d.id AS id, d.at AS at, count(newer) = 0 AS current ORDER BY at
`.trim();

const DECISION_ID = /^ADR-\d{3}$/;

async function decisionDetail(graph, id) {
  const d = (await graph.query(DECISION_DETAIL_CYPHER, {params: {id}}))?.data?.[0];
  if (!d) return null;
  const links = (await graph.query(DECISION_LINKS_CYPHER, {params: {id}}))?.data?.[0] || {};
  return {...d, services: links.services || [], supersedes: links.supersedes || [],
    motivatedBy: links.motivatedBy || [], discussedIn: (links.discussedIn || []).slice(0, 8)};
}

export async function traceDecision(graph, {subjectId}) {
  try {
    if (DECISION_ID.test(subjectId || "")) {
      const chain = (await graph.query(DECISION_CHAIN_CYPHER, {params: {id: subjectId}}))?.data?.[0];
      const asked = await decisionDetail(graph, subjectId);
      if (!asked) return {kind: "decision", status: "ABSTAIN", reason: "UNKNOWN_DECISION", subjectId};
      const ids = [...new Set([...(chain?.newer || []), subjectId, ...(chain?.older || [])])];
      const decisions = [];
      for (const id of ids) { const d = await decisionDetail(graph, id); if (d) decisions.push(d); }
      // A decision is current when nothing in the chain supersedes it.
      const superseded = new Set(decisions.flatMap(d => d.supersedes));
      decisions.forEach(d => { d.current = !superseded.has(d.id); });
      decisions.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
      const current = decisions.filter(d => d.current).map(d => d.id);
      return {kind: "decision", status: "FOUND", subjectId, asked: asked.id, current: current.join(", "),
        supersededBy: (chain?.newer || []).length ? current.join(", ") : null, decisions};
    }
    if (!validId(subjectId)) return {kind: "decision", status: "ABSTAIN", reason: "INVALID_INPUT", subjectId};
    const rows = (await graph.query(SERVICE_DECISIONS_CYPHER, {params: {id: subjectId}}))?.data || [];
    if (!rows.length) return {kind: "decision", status: "ABSTAIN", reason: "NO_GRAPH_EVIDENCE", subjectId};
    const decisions = [];
    for (const r of rows) { const d = await decisionDetail(graph, r.id); if (d) decisions.push({...d, current: Boolean(r.current)}); }
    decisions.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    return {kind: "decision", status: "FOUND", subjectId, current: decisions.filter(d => d.current).map(d => d.id).join(", "),
      decisions};
  } catch {
    return {kind: "decision", status: "ABSTAIN", reason: "GRAPH_UNAVAILABLE", subjectId};
  }
}

// ---------------------------------------------------------------------------------------------
// A person or a team: where they sit, what they own (by the same policy), what they know, what they decided.

export const PERSON_CYPHER = `
MATCH (p:Person {id: $id})
OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
OPTIONAL MATCH (t)-[:LED_BY]->(lead:Person)
OPTIONAL MATCH (p)-[:REPORTS_TO]->(m:Person)
RETURN p.id AS id, p.name AS name, p.role AS role, t.id AS teamId, t.name AS team,
       lead.id AS leadId, lead.name AS leadName, m.id AS managerId, m.name AS managerName
`.trim();

export const PERSON_KNOWS_CYPHER = `
MATCH (p:Person {id: $id})-[:RESOLVED]->(:Ticket)-[:ABOUT|TAGGED]->(x)
RETURN x.id AS subjectId, x.name AS subject, count(*) AS resolved ORDER BY resolved DESC, subjectId LIMIT 5
`.trim();

export const PERSON_DECISIONS_CYPHER = `
MATCH (d:Decision)-[:DECIDED_BY]->(:Person {id: $id})
OPTIONAL MATCH (newer:Decision)-[:SUPERSEDES]->(d)
RETURN d.id AS id, d.title AS title, d.at AS at, count(newer) = 0 AS current ORDER BY d.at
`.trim();

export const TEAM_PROFILE_CYPHER = `
MATCH (t:Team {id: $id})
OPTIONAL MATCH (t)-[:LED_BY]->(lead:Person)
OPTIONAL MATCH (m:Person)-[:MEMBER_OF]->(t)
RETURN t.id AS id, t.name AS name, lead.id AS leadId, lead.name AS leadName,
       collect(m.id) AS members, collect(m.name) AS memberNames
`.trim();

async function servicesOwnedBy(graph, ids, asOf) {
  const services = (await graph.query("MATCH (s:Service) RETURN s.id AS id ORDER BY s.id"))?.data || [];
  const owned = [];
  for (const s of services) {
    const r = await ownerOfService(graph, {serviceId: s.id, asOf});
    if (r.status === "OWNER" && ids.includes(r.owner.id)) {
      owned.push({serviceId: s.id, serviceName: r.serviceName, ownerId: r.owner.id, ownerName: r.owner.name,
        sourceId: r.basis.sourceId, sourceKind: r.basis.sourceKind, quote: r.basis.quote});
    }
  }
  return owned;
}

export async function profile(graph, {subjectId, asOf}) {
  if (!validId(subjectId)) return {kind: "profile", status: "ABSTAIN", reason: "INVALID_INPUT", subjectId};
  try {
    const team = (await graph.query(TEAM_PROFILE_CYPHER, {params: {id: subjectId}}))?.data?.[0];
    if (team?.id) {
      const members = team.members.map((id, i) => ({id, name: team.memberNames[i]}));
      return {kind: "profile", status: "FOUND", subjectType: "team", subjectId, name: team.name,
        lead: team.leadId ? {id: team.leadId, name: team.leadName} : null, members,
        owns: await servicesOwnedBy(graph, team.members, asOf)};
    }
    const p = (await graph.query(PERSON_CYPHER, {params: {id: subjectId}}))?.data?.[0];
    if (!p?.id) return {kind: "profile", status: "ABSTAIN", reason: "UNKNOWN_SUBJECT", subjectId};
    const knows = (await graph.query(PERSON_KNOWS_CYPHER, {params: {id: subjectId}}))?.data || [];
    const decided = (await graph.query(PERSON_DECISIONS_CYPHER, {params: {id: subjectId}}))?.data || [];
    return {kind: "profile", status: "FOUND", subjectType: "person", subjectId, name: p.name, role: p.role,
      team: p.team, lead: p.leadId ? {id: p.leadId, name: p.leadName} : null,
      manager: p.managerId ? {id: p.managerId, name: p.managerName} : null,
      owns: await servicesOwnedBy(graph, [subjectId], asOf), knows, decided};
  } catch {
    return {kind: "profile", status: "ABSTAIN", reason: "GRAPH_UNAVAILABLE", subjectId};
  }
}

// ---------------------------------------------------------------------------------------------
// Full-text search over every source record (FalkorDB full-text index on Source.title and Source.text).

export const SEARCH_CYPHER = `
CALL db.idx.fulltext.queryNodes('Source', $query) YIELD node, score
RETURN node.id AS id, node.kind AS kind, node.title AS title, node.text AS text, node.authority AS authority,
       node.at AS at, score
ORDER BY score DESC LIMIT 6
`.trim();

const STOP = new Set(["the", "and", "for", "with", "why", "did", "does", "what", "who", "how", "was", "were", "are",
  "our", "use", "used", "using", "about", "from", "that", "this", "have", "has", "had", "into", "when", "where",
  "which", "find", "search", "mention", "mentions", "mentioned", "record", "records", "doc", "docs", "any", "all"]);
/** Search terms: plain words only, so nothing reaches the full-text query syntax except words. */
export const searchTerms = q => [...new Set(String(q || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
  .filter(w => w.length >= 3 && !STOP.has(w)))].slice(0, 6);

function snippet(text, terms) {
  const sentences = String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const hit = sentences.find(s => terms.some(t => s.toLowerCase().includes(t))) || sentences[0] || "";
  return hit.length > 260 ? hit.slice(0, 257) + "..." : hit;
}

export async function searchRecords(graph, {query}) {
  const terms = searchTerms(query);
  if (!terms.length) return {kind: "search", status: "ABSTAIN", reason: "INVALID_INPUT", query};
  try {
    let rows = (await graph.query(SEARCH_CYPHER, {params: {query: terms.join(" ")}}))?.data || [];
    let mode = "all terms";
    if (!rows.length && terms.length > 1) {
      rows = (await graph.query(SEARCH_CYPHER, {params: {query: terms.join(" | ")}}))?.data || [];
      mode = "any term";
    }
    if (!rows.length) return {kind: "search", status: "ABSTAIN", reason: "NO_GRAPH_EVIDENCE", query, terms};
    return {kind: "search", status: "FOUND", query, terms, mode,
      results: rows.map(r => ({id: r.id, kind: r.kind, title: r.title, authority: r.authority, at: r.at,
        score: Number(Number(r.score).toFixed(3)), snippet: snippet(r.text, terms)}))};
  } catch {
    return {kind: "search", status: "ABSTAIN", reason: "GRAPH_UNAVAILABLE", query};
  }
}
