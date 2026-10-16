// Writes the corpus and the validated facts into FalkorDB. Structural edges (who resolved which
// ticket, who wrote which doc) come straight from the records; ownership and decisions come only
// from validated extractions, each linked to the source and quote that support it.
import {entityNames, mentions} from "./corpus.mjs";

// Labels cannot be query parameters, so each kind maps to a fixed label.
const KIND_LABEL = Object.freeze({
  "change-control": "ChangeControl", adr: "ADR", directory: "Directory", runbook: "Runbook",
  ticket: "Ticket", chat: "Message", wiki: "Wiki"
});
const labelFor = s => s.format === "comment" ? "Comment" : KIND_LABEL[s.kind];

export async function clearGraph(graph) {
  await graph.query("MATCH (n) DETACH DELETE n");
}

export async function writeOrg(graph, {org, catalog}) {
  await graph.query("UNWIND $rows AS r MERGE (t:Team {id:r.id}) SET t.name=r.name", {params: {rows: org.teams}});
  await graph.query("UNWIND $rows AS r MERGE (p:Person {id:r.id}) SET p.name=r.name, p.role=r.role " +
    "WITH p, r MATCH (t:Team {id:r.teamId}) MERGE (p)-[:MEMBER_OF]->(t)", {params: {rows: org.people}});
  await graph.query("UNWIND $rows AS r MATCH (p:Person {id:r.id}), (m:Person {id:r.managerId}) MERGE (p)-[:REPORTS_TO]->(m)",
    {params: {rows: org.people.filter(p => p.managerId && p.managerId !== p.id)}});
  await graph.query("UNWIND $rows AS r MATCH (t:Team {id:r.id}), (p:Person {id:r.leadId}) MERGE (t)-[:LED_BY]->(p)",
    {params: {rows: org.teams.filter(t => t.leadId)}});
  await graph.query("UNWIND $rows AS r MERGE (s:Service {id:r.id}) SET s.name=r.name, s.aliases=r.aliases", {params: {rows: catalog.services}});
  await graph.query("UNWIND $rows AS r MERGE (t:Topic {id:r.id}) SET t.name=r.name, t.aliases=r.aliases", {params: {rows: catalog.topics}});
  await graph.query("UNWIND $rows AS r MERGE (p:Project {id:r.id}) SET p.name=r.name, p.aliases=r.aliases " +
    "WITH p, r UNWIND r.serviceIds AS sid MATCH (s:Service {id:sid}) MERGE (p)-[:USES]->(s)", {params: {rows: catalog.projects}});
}

/** Write sources and their validated facts. Safe to call again for a single live source. */
export async function writeSources(graph, sources, factsById, {catalog}) {
  const byLabel = new Map();
  for (const s of sources) {
    const label = labelFor(s);
    if (!label) throw new Error("no label for " + s.id);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push({id: s.id, kind: s.kind, authority: s.authority, title: s.title, at: s.at,
      text: s.text.slice(0, 4000), format: s.format, channel: s.channel || null, author: s.author});
  }
  for (const [label, rows] of byLabel) {
    await graph.query(`UNWIND $rows AS r MERGE (s:Source:${label} {id:r.id}) SET s.kind=r.kind, s.authority=r.authority, ` +
      "s.title=r.title, s.at=r.at, s.text=r.text, s.format=r.format, s.channel=r.channel", {params: {rows}});
  }
  const authored = sources.filter(s => s.author).map(s => ({id: s.id, author: s.author}));
  await graph.query("UNWIND $rows AS r MATCH (s:Source {id:r.id}), (p:Person {id:r.author}) MERGE (p)-[:AUTHORED]->(s)",
    {params: {rows: authored}});

  const tickets = sources.filter(s => s.format === "ticket");
  for (const [rel, key] of [["REPORTED", "reporter"], ["ASSIGNED", "assignee"], ["RESOLVED", "resolvedBy"]]) {
    await graph.query(`UNWIND $rows AS r MATCH (t:Ticket {id:r.id}), (p:Person {id:r.person}) MERGE (p)-[:${rel}]->(t)`,
      {params: {rows: tickets.filter(t => t[key]).map(t => ({id: t.id, person: t[key]}))}});
  }
  await graph.query("UNWIND $rows AS r MATCH (c:Comment {id:r.id}), (t:Ticket {id:r.ticket}) MERGE (c)-[:ON]->(t)",
    {params: {rows: sources.filter(s => s.format === "comment").map(s => ({id: s.id, ticket: s.ticketId}))}});
  await graph.query("UNWIND $rows AS r MATCH (s:Source {id:r.id}), (v:Service {id:r.service}) MERGE (s)-[:ABOUT]->(v)",
    {params: {rows: sources.filter(s => s.serviceId).map(s => ({id: s.id, service: s.serviceId}))}});
  await graph.query("UNWIND $rows AS r MATCH (s:Source {id:r.id}), (t:Topic {id:r.topic}) MERGE (s)-[:TAGGED]->(t)",
    {params: {rows: sources.flatMap(s => (s.topicIds || []).map(topic => ({id: s.id, topic})))}});

  // Deterministic mentions: a record that names a service or topic links to it.
  const mentionRows = [];
  for (const s of sources) {
    for (const e of [...catalog.services, ...catalog.topics]) {
      if (mentions(s.text + " " + s.title, entityNames(e))) mentionRows.push({id: s.id, target: e.id});
    }
  }
  await graph.query("UNWIND $rows AS r MATCH (s:Source {id:r.id}) MATCH (e {id:r.target}) WHERE e:Service OR e:Topic " +
    "MERGE (s)-[:MENTIONS]->(e)", {params: {rows: mentionRows}});

  const claims = [], decisions = [];
  for (const s of sources) {
    const f = factsById[s.id];
    if (!f) continue;
    for (const o of f.ownership || []) {
      claims.push({id: `${s.id}:${o.serviceId}:${o.ownerId}`, source: s.id, service: o.serviceId, owner: o.ownerId,
        effectiveAt: s.at, quote: o.quote});
    }
    for (const d of f.decisions || []) {
      decisions.push({...d, title: String(d.title).replace(/^ADR-\d{3}\s*[:\-]\s*/i, ""), source: s.id, at: s.at});
    }
  }
  await graph.query("UNWIND $rows AS r MATCH (src:Source {id:r.source}), (v:Service {id:r.service}), (p:Person {id:r.owner}) " +
    "MERGE (c:OwnershipClaim {id:r.id}) SET c.effectiveAt=r.effectiveAt, c.quote=r.quote " +
    "MERGE (src)-[a:ATTESTS]->(c) SET a.quote=r.quote MERGE (c)-[:ABOUT]->(v) MERGE (c)-[:NAMES_OWNER]->(p)",
    {params: {rows: claims}});
  await graph.query("UNWIND $rows AS r MATCH (src:Source {id:r.source}), (p:Person {id:r.decidedBy}) " +
    "MERGE (d:Decision {id:r.decisionId}) SET d.title=r.title, d.at=r.at, d.recorded=true " +
    "MERGE (src)-[x:RECORDS]->(d) SET x.quote=r.quote MERGE (d)-[:DECIDED_BY]->(p) " +
    "WITH d, r UNWIND r.serviceIds AS sid MATCH (v:Service {id:sid}) MERGE (d)-[:AFFECTS]->(v)",
    {params: {rows: decisions}});
  await graph.query("UNWIND $rows AS r MATCH (d:Decision {id:r.decisionId}) MERGE (old:Decision {id:r.supersedes}) " +
    "MERGE (d)-[:SUPERSEDES]->(old)", {params: {rows: decisions.filter(d => d.supersedes)}});
  return {claims: claims.length, decisions: decisions.length};
}

/** Edges derived from the whole graph; recomputed after every load or live update. */
export async function deriveEdges(graph) {
  // Records that cite a decision or ticket by id.
  await graph.query("MATCH (s:Source), (d:Decision) WHERE NOT (s)-[:RECORDS]->(d) AND s.text CONTAINS d.id " +
    "MERGE (s)-[:DISCUSSES]->(d)");
  await graph.query("MATCH (src:Source)-[:RECORDS]->(d:Decision), (t:Ticket) WHERE src.text CONTAINS t.id " +
    "MERGE (d)-[:MOTIVATED_BY]->(t)");
  // People who worked the same ticket (reported, assigned, resolved, commented) collaborated.
  await graph.query("MATCH ()-[c:COLLABORATED]->() DELETE c");
  await graph.query(
    "MATCH (t:Ticket) " +
    "OPTIONAL MATCH (p1:Person)-[:REPORTED|ASSIGNED|RESOLVED]->(t) " +
    "OPTIONAL MATCH (p2:Person)-[:AUTHORED]->(:Comment)-[:ON]->(t) " +
    "WITH t, collect(DISTINCT p1) + collect(DISTINCT p2) AS ps " +
    "UNWIND ps AS a UNWIND ps AS b WITH t, a, b WHERE a <> b " +
    "WITH a, b, count(DISTINCT t) AS w MERGE (a)-[c:COLLABORATED]->(b) SET c.weight=w");
}

export async function loadGraph(graph, corpus, extracted) {
  await clearGraph(graph);
  await writeOrg(graph, corpus);
  const counts = await writeSources(graph, corpus.sources, extracted, corpus);
  await deriveEdges(graph);
  try { await graph.query("CALL db.idx.fulltext.createNodeIndex('Source', 'title', 'text')"); } catch { /* exists */ }
  return counts;
}

export async function graphStats(graph) {
  const nodes = await graph.query("MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n ORDER BY n DESC");
  const rels = await graph.query("MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS n ORDER BY n DESC");
  return {nodes: nodes.data || [], relationships: rels.data || []};
}
