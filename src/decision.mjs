// Ownership policy. A parameterized Cypher query reads every ownership claim about a service with
// its source and quote; this pure function then names an owner or abstains. Nothing here trusts a
// model: the model only chose which service or project to ask about.
import {MIN_NAMING_AUTHORITY, validTime} from "./corpus.mjs";

export const MAX_EVIDENCE_ROWS = 50;

// OPTIONAL MATCH keeps claims whose source or owner is missing, so the policy sees the gap and
// abstains instead of silently choosing from the remaining rows.
export const OWNER_CYPHER = `
MATCH (svc:Service {id: $serviceId})
OPTIONAL MATCH (claim:OwnershipClaim)-[:ABOUT]->(svc)
OPTIONAL MATCH (src:Source)-[att:ATTESTS]->(claim)
OPTIONAL MATCH (claim)-[:NAMES_OWNER]->(owner:Person)
RETURN svc.id AS serviceId, svc.name AS serviceName,
       claim.id AS claimId, claim.effectiveAt AS effectiveAt,
       src.id AS sourceId, src.kind AS sourceKind, src.title AS sourceTitle, src.authority AS authority,
       att.quote AS quote, owner.id AS ownerId, owner.name AS ownerName
LIMIT ${MAX_EVIDENCE_ROWS}
`.trim();

export const PROJECT_SERVICES_CYPHER =
  "MATCH (p:Project {id: $projectId})-[:USES]->(s:Service) RETURN p.name AS projectName, s.id AS serviceId ORDER BY s.id";

export const validId = s => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(s);

const abstain = (serviceId, asOf, reason, extra = {}) =>
  ({status: "ABSTAIN", reason, serviceId, asOf, ...extra});

const evidenceRow = r => ({claimId: r.claimId, ownerId: r.ownerId, ownerName: r.ownerName, sourceId: r.sourceId,
  sourceKind: r.sourceKind, sourceTitle: r.sourceTitle, authority: Number(r.authority), effectiveAt: r.effectiveAt,
  quote: r.quote});

/** Pure policy over the rows of OWNER_CYPHER. */
export function resolveOwner(rows, {serviceId, asOf}) {
  if (!validId(serviceId) || !validTime(asOf)) return abstain(serviceId, asOf, "INVALID_INPUT");
  if (!Array.isArray(rows) || !rows.length) return abstain(serviceId, asOf, "UNKNOWN_SERVICE");
  // At the cap a conflicting claim may have been cut off: refuse rather than pick.
  if (rows.length >= MAX_EVIDENCE_ROWS) return abstain(serviceId, asOf, "EVIDENCE_RESULT_LIMIT");
  const serviceName = rows[0].serviceName;
  const claims = rows.filter(r => r.claimId != null);
  if (!claims.length) return abstain(serviceId, asOf, "NO_GRAPH_EVIDENCE", {serviceName});
  const atMs = Date.parse(asOf);
  const valid = [];
  for (const r of claims) {
    const rank = Number(r.authority);
    if (r.sourceId == null || r.ownerId == null || !validTime(r.effectiveAt) ||
        r.authority == null || !Number.isInteger(rank) || rank < 0 || rank > 100) {
      return abstain(serviceId, asOf, "INCOMPLETE_GRAPH_PROVENANCE", {serviceName, broken: r.claimId});
    }
    if (Date.parse(r.effectiveAt) > atMs) continue; // not yet in effect at asOf
    valid.push(evidenceRow(r));
  }
  if (!valid.length) return abstain(serviceId, asOf, "NO_EVIDENCE_AT_THAT_TIME", {serviceName});
  valid.sort((a, b) => b.authority - a.authority || Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) ||
    a.claimId.localeCompare(b.claimId));
  const winner = valid[0];
  const evidence = valid;
  if (winner.authority < MIN_NAMING_AUTHORITY) {
    return abstain(serviceId, asOf, "LOW_AUTHORITY_ONLY", {serviceName, evidence});
  }
  // Same authority and the same instant (timestamps compared as instants, not strings).
  const tied = valid.filter(r => r.authority === winner.authority && Date.parse(r.effectiveAt) === Date.parse(winner.effectiveAt));
  if (new Set(tied.map(r => r.ownerId)).size > 1) {
    return abstain(serviceId, asOf, "UNRESOLVED_EQUAL_AUTHORITY_CONFLICT", {serviceName, competing: tied, evidence});
  }
  return {
    status: "OWNER", serviceId, serviceName, asOf,
    owner: {id: winner.ownerId, name: winner.ownerName},
    basis: winner,
    outranked: valid.filter(r => r.claimId !== winner.claimId),
    path: [
      {from: `Source:${winner.sourceId}`, rel: "ATTESTS", to: "OwnershipClaim"},
      {from: "OwnershipClaim", rel: "ABOUT", to: `Service:${serviceId}`},
      {from: "OwnershipClaim", rel: "NAMES_OWNER", to: `Person:${winner.ownerId}`}
    ]
  };
}

export async function ownerOfService(graph, {serviceId, asOf}) {
  if (!validId(serviceId) || !validTime(asOf)) return abstain(serviceId, asOf, "INVALID_INPUT");
  try {
    const reply = await graph.query(OWNER_CYPHER, {params: {serviceId}});
    return resolveOwner(reply?.data ?? reply, {serviceId, asOf});
  } catch (err) {
    return abstain(serviceId, asOf, "GRAPH_UNAVAILABLE", {diagnostic: String(err?.code || err?.name || "GRAPH_QUERY_ERROR")});
  }
}

/** A project answer is one decision per service it uses; it never collapses conflicts into one name. */
export async function ownerOfProject(graph, {projectId, asOf}) {
  const empty = reason => ({kind: "owner", status: "ABSTAIN", reason, projectId, asOf, services: []});
  if (!validId(projectId) || !validTime(asOf)) return empty("INVALID_INPUT");
  let rows;
  try { rows = (await graph.query(PROJECT_SERVICES_CYPHER, {params: {projectId}}))?.data || []; }
  catch { return empty("GRAPH_UNAVAILABLE"); }
  if (!rows.length) return empty("UNKNOWN_PROJECT");
  const services = [];
  for (const r of rows) services.push(await ownerOfService(graph, {serviceId: r.serviceId, asOf}));
  const named = services.filter(s => s.status === "OWNER").length;
  return {kind: "owner", projectId, projectName: rows[0].projectName, asOf, services,
    status: named === services.length ? "OWNER" : named ? "PARTIAL" : "ABSTAIN"};
}
