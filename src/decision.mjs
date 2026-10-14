// Graph-first, fail-closed human-review draft. Pure selection logic is separately tested.
// A deterministic decision workflow is NOT advertised as an LLM agent.
export const MAX_EVIDENCE_ROWS = 50;
// Preserve every service and ownership claim in the query, including rows with
// missing owners/sources. Silent inner joins can hide contradictory evidence.
export const LOOKUP_CYPHER = `
MATCH (project:Project {id: $projectId})-[:USES]->(service:Service)
OPTIONAL MATCH (claim:OwnershipClaim)-[:ABOUT]->(service)
OPTIONAL MATCH (source:Source)-[:ATTESTS]->(claim)
OPTIONAL MATCH (claim)-[:NAMES_OWNER]->(owner:Person)
RETURN project.id AS projectId, service.id AS serviceId,
       claim.id AS claimId, claim.effectiveAt AS effectiveAt,
       source.id AS sourceId, source.rank AS sourceRank,
       owner.id AS ownerId, owner.name AS ownerName
ORDER BY source.rank DESC, claim.effectiveAt DESC
LIMIT 50
`.trim();

export function validId(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(s);
}

function abstain(projectId, asOf, reason, extra = {}) {
  return {
    status: "ABSTAIN", reason, projectId, asOf,
    proposedAction: null, authorizedExternalActions: false, ...extra
  };
}

function validTime(s) {
  if (typeof s !== "string") return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}T/.test(s);
}

export function resolveEvidence(rows, {projectId = "orion", asOf = "2026-10-14T20:00:00.000Z"} = {}) {
  if (!validId(projectId) || !validTime(asOf)) return abstain(projectId, asOf, "INVALID_INPUT");
  if (!Array.isArray(rows)) return abstain(projectId, asOf, "INVALID_GRAPH_RESPONSE");
  if (!rows.length) return abstain(projectId, asOf, "NO_GRAPH_EVIDENCE");
  // The Cypher result is capped. At the cap we cannot prove an equal-authority
  // conflicting claim was not omitted: fail closed instead of picking a winner.
  if (rows.length >= MAX_EVIDENCE_ROWS) return abstain(projectId, asOf, "EVIDENCE_RESULT_LIMIT");
  const atMs = Date.parse(asOf);
  const normalized = [];
  for (const r of rows) {
    if (!r || r.projectId !== projectId || !validId(r.serviceId) ||
        !validId(r.claimId) || !validId(r.sourceId) || !validId(r.ownerId) ||
        typeof r.ownerName !== "string" || !r.ownerName.trim() ||
        !validTime(r.effectiveAt) ||
        r.sourceRank === null || r.sourceRank === undefined || r.sourceRank === "" ||
        !Number.isInteger(Number(r.sourceRank)) ||
        Number(r.sourceRank) < 0 || Number(r.sourceRank) > 100) {
      return abstain(projectId, asOf, "INCOMPLETE_GRAPH_PROVENANCE");
    }
    if (Date.parse(r.effectiveAt) > atMs) continue; // Future claims cannot decide a current release.
    normalized.push({
      projectId, serviceId: r.serviceId, claimId: r.claimId,
      sourceId: r.sourceId, sourceRank: Number(r.sourceRank),
      effectiveAt: r.effectiveAt, ownerId: r.ownerId, ownerName: r.ownerName
    });
  }
  if (!normalized.length) return abstain(projectId, asOf, "NO_CURRENT_EVIDENCE");
  const services = [...new Set(normalized.map(r => r.serviceId))];
  if (services.length !== 1) return abstain(projectId, asOf, "AMBIGUOUS_PROJECT_SERVICE");
  normalized.sort((a, b) => b.sourceRank - a.sourceRank ||
      Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) ||
      a.claimId.localeCompare(b.claimId));
  const winner = normalized[0];
  // Different valid timezone offsets can represent the same instant.
  // Compare parsed instants, not raw timestamp strings, for authority ties.
  const winnerMs = Date.parse(winner.effectiveAt);
  const coequal = normalized.filter(r =>
    r.sourceRank === winner.sourceRank && Date.parse(r.effectiveAt) === winnerMs);
  if (new Set(coequal.map(r => r.ownerId)).size > 1) {
    return abstain(projectId, asOf, "UNRESOLVED_EQUAL_AUTHORITY_CONFLICT", {
      competing: coequal.map(r => ({
        ownerId: r.ownerId, sourceId: r.sourceId, claimId: r.claimId,
        authority: r.sourceRank, effectiveAt: r.effectiveAt
      }))
    });
  }
  const rejected = normalized.filter(r => r.ownerId !== winner.ownerId).map(r => ({
    ownerId: r.ownerId, sourceId: r.sourceId, claimId: r.claimId,
    authority: r.sourceRank, effectiveAt: r.effectiveAt
  }));
  return {
    status: "HUMAN_REVIEW_DRAFT", projectId, asOf,
    serviceId: winner.serviceId,
    currentOwner: {id: winner.ownerId, name: winner.ownerName},
    basis: {
      claimId: winner.claimId, sourceId: winner.sourceId,
      authority: winner.sourceRank, effectiveAt: winner.effectiveAt,
      path: [
        `Project:${projectId} -USES-> Service:${winner.serviceId}`,
        `OwnershipClaim:${winner.claimId} -ABOUT-> Service:${winner.serviceId}`,
        `Source:${winner.sourceId} -ATTESTS-> OwnershipClaim:${winner.claimId}`,
        `OwnershipClaim:${winner.claimId} -NAMES_OWNER-> Person:${winner.ownerId}`
      ]
    },
    contradictoryEvidence: rejected,
    proposedAction: {
      type: "DRAFT_HUMAN_REVIEW_TASK",
      summary: `Ask ${winner.ownerName} to review release of project ${projectId}; do not auto-approve.`,
      status: "DRAFT_ONLY", requiresHumanApproval: true
    },
    authorizedExternalActions: false
  };
}

export async function decideFromGraph(graph, {projectId = "orion", asOf = new Date().toISOString()} = {}) {
  if (!validId(projectId) || !validTime(asOf)) return abstain(projectId, asOf, "INVALID_INPUT");
  try {
    const reply = await graph.query(LOOKUP_CYPHER, {params: {projectId}});
    const rows = Array.isArray(reply) ? reply
      : (Array.isArray(reply?.data) ? reply.data : reply?.rows);
    return resolveEvidence(rows, {projectId, asOf});
  } catch (err) {
    return abstain(projectId, asOf, "GRAPH_UNAVAILABLE", {
      // Never turn graph failure into an LLM/hard-coded confident answer.
      diagnostic: String(err?.code || err?.name || "GRAPH_QUERY_ERROR")
    });
  }
}
