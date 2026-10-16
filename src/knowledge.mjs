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

export const SERVICE_DECISIONS_CYPHER =
  "MATCH (d:Decision)-[:AFFECTS]->(:Service {id: $id}) RETURN d.id AS id, NOT ()-[:SUPERSEDES]->(d) AS current ORDER BY d.at";

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
