# DecisionGraph — Graph Hacks: Context for AI Agents (October 2026)

**Track candidate:** Company Brain (Track 03). Started after the official October 15, 2026 01:31 ICT opening. **Work in progress: not a submitted or prize-ready agent.**

## Scope and safety
A synthetic Project Orion release question is resolved by querying a FalkorDB knowledge graph. Three provenance-tagged ownership claims disagree. The policy considers source authority, effective time and equal-rank collisions, then returns either a traceable **human-review draft** or **ABSTAIN**. No payments, real releases, messages, approvals or external side effects are executed. No personal or restricted data is used. The deterministic graph workflow is now accompanied by a restricted **LLM-driven tool-call orchestration adapter**. Unit tests use a stub model; until a legally licensed local model and FalkorDB both run for a real end-to-end attempt, **genuine LLM+FalkorDB operation is NOT YET VERIFIED**.

## Run locally (Node >= 24, Docker Desktop with a healthy Linux daemon)
1. Confirm free disk and Docker memory first. This project does not manage or prune other projects' containers or volumes.
2. `docker compose up -d graph` — pinned `falkordb/falkordb:v4.20.4`, port `127.0.0.1:16379`, dedicated volume and container, bounded 1.5 GiB RAM.
3. `npm install --ignore-scripts` (pinned `falkordb@6.8.0`). No paid API or LLM model.
4. `node scripts/smoke.mjs` — actual FalkorDB write and read of a unique probe node.
5. `node scripts/seed.mjs` — idempotently create synthetic graph fixture.
6. `node src/server.mjs`, open `http://127.0.0.1:18737`; POST `/api/decision` with `{"projectId":"orion"}`.
7. `npm test` — offline unit and negative tests (22 PASS on Oct 15); these use simulated graph/model calls, NOT live DB evidence.
8. `node scripts/counterfactual-acceptance.mjs` **only after FalkorDB is healthy** — in separate graph `gh2026_companybrain_acceptance`, verify live baseline owner, mutate one synthetic ownership link, confirm answer changes, force a same-rank conflict and require ABSTAIN, then restore test edges even on error. A mock-backed test for this protocol passed, actual live query still BLOCKED by Docker.
9. `node scripts/agent-demo.mjs` **only after a lawful tool-calling model on loopback and FalkorDB are both available**; does not silently use a paid/cloud API or unlicensed model. Genuine LLM model call remains UNVERIFIED.
10. `docker compose stop graph` when finished; do not delete other Docker data.

**Environment:** optional `GRAPH_HOST=127.0.0.1`, `GRAPH_PORT=16379`, `GRAPH_NAME=gh2026_companybrain_owner`, `APP_PORT=18737`. Only localhost is accepted for graph and web ports.

## Graph data model
- `(Project {id,name})-[:USES]->(Service {id,name})`
- `(OwnershipClaim {id,effectiveAt})-[:ABOUT]->(Service)`
- `(Source {id,rank})-[:ATTESTS]->(OwnershipClaim)`
- `(OwnershipClaim)-[:NAMES_OWNER]->(Person {id,name})`

The source rank (0..100) and latest effective timestamp jointly select a candidate. Two different owners with equal top rank and timestamp cause `ABSTAIN`. Invalid/missing source fields, future-only claims, multiple services and disconnected/unavailable FalkorDB also abstain. At the bounded query limit of 50 returned rows, provenance may be truncated, so the result fails closed as `EVIDENCE_RESULT_LIMIT`.

## Key parameterized Cypher query
```cypher
MATCH (project:Project {id: $projectId})-[:USES]->(service:Service)
MATCH (claim:OwnershipClaim)-[:ABOUT]->(service)
MATCH (source:Source)-[:ATTESTS]->(claim)
MATCH (claim)-[:NAMES_OWNER]->(owner:Person)
RETURN project.id AS projectId, service.id AS serviceId,
  claim.id AS claimId, claim.effectiveAt AS effectiveAt,
  source.id AS sourceId, source.rank AS sourceRank,
  owner.id AS ownerId, owner.name AS ownerName
ORDER BY source.rank DESC, claim.effectiveAt DESC
LIMIT 50
```
Full query: `src/decision.mjs`; graph fixtures in `src/fixtures.mjs` and `scripts/seed.mjs`. All queries are bounded; no user-provided Cypher executes.

## Evidence and remaining eligibility gates
- Local policy tests can be run without Docker and have been executed; actual graph read/write must be confirmed independently via `smoke.mjs` before any working-demo claim.
- The official October rules require FalkorDB to be essential and a **working agent**, not an attractive static graph. Genuine LLM tool-calling, interactive counterfactual query, graph-outage acceptance, video and a public repository are still required.
- `falkordb/falkordb:v4.20.4` is a version tag; capture immutable image digest after a successful pull/start and update to a digest pin before public publication.
- AI assistance used for code writing. Owner must inspect, understand, verify and approve the final submission; never auto-submit. Project status: **OWNER_CONFIRMED/PORTAL_UNVERIFIED**, **NOT_SUBMITTED**.
- Official rules: https://www.wemakedevs.org/hackathons/falkordb/rules . Submission closes October 19, 2026 01:29 ICT.
