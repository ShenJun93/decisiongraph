# DecisionGraph — a Company Brain that refuses to guess

**Graph Hacks: Context for AI Agents (WeMakeDevs × FalkorDB, October 2026) · Track: Company Brain**

Ask "who should sign off the Orion release?" and most AI assistants will name someone. They will name
someone even when the company's own records disagree: an old directory entry, a newer change-control
record, a chat message from yesterday. DecisionGraph keeps that company knowledge in **FalkorDB** as a
provenance graph. Every ownership claim is linked to the source that attests it, the source's authority,
and when it took effect. The agent answers only from that graph:

- **One credible owner**: it names them, shows the exact graph path behind the answer, lists the claims it
  outranked, and drafts a review task for a human (never an approval).
- **Evidence that conflicts or is incomplete**: it **abstains** and says why, instead of picking a winner.

All data is synthetic. Nothing is ever approved, sent or executed: the only output is a draft.

## Demo

- Video: _link added at submission_
- Run it locally in about 5 minutes (below). The UI is at http://127.0.0.1:18737.

| Question | Graph evidence | Answer |
|---|---|---|
| Who should sign off the Orion release? | Signed change-control (authority 90, Oct 14) vs older directory entry (90, Sep 20) vs chat note (35) | **Ben**, with the path and the two outranked claims |
| Who owns the ML pipeline behind Vega? | HR system of record (95) vs a newer wiki edit (20) | **Cora** |
| Can I ship Nova today, and who approves it? | Two change-control records, same authority (80), same instant, different owners | **Abstain**: equal-authority conflict |
| Who is responsible for Lyra's search index? | A claim that no source attests | **Abstain**: incomplete provenance |

The UI also runs a **live counterfactual** on a separate graph to prove the graph, not the model, drives
the answer: read the owner (Ben), change one `NAMES_OWNER` edge (→ Aria), add an equal-authority
conflicting claim (→ abstain), then restore (→ Ben).

## How it works

```
question ──► Nemotron (tool call, project chosen from the graph's own project list)
                │  get_project_owner_evidence({projectId})        ← only tool, read-only
                ▼
          FalkorDB  ── parameterized Cypher (below) ──► provenance rows
                ▼
          provenance policy (src/decision.mjs): authority → recency → tie / gap check
                ▼
          HUMAN_REVIEW_DRAFT (owner + path + outranked claims)   or   ABSTAIN (reason)
                ▼
          Nemotron writes a ≤3-sentence explanation from that result only;
          it is kept only if it agrees with the decision, otherwise a fixed template is used
```

The model chooses *which project* the question is about and *how to phrase* the answer. It never writes
Cypher, never sees anything the graph did not return, and cannot change the decision: the project ID must
be one the graph listed, the tool takes exactly one argument, and an explanation that names a different
owner or claims approval is discarded.

### Graph model

```
(Project {id, name}) -[:USES]-> (Service {id, name})
(OwnershipClaim {id, effectiveAt}) -[:ABOUT]-> (Service)
(Source {id, rank 0..100}) -[:ATTESTS]-> (OwnershipClaim)
(OwnershipClaim) -[:NAMES_OWNER]-> (Person {id, name})
```

Why a graph: the question "who owns this?" is a path question. The answer depends on which claim is
about which service, who attests it and how much that source is trusted. In a flat document store those
relationships live in prose; here they are edges the agent can query, count and explain.

### Cypher

The agent lists projects:

```cypher
MATCH (p:Project) RETURN p.id AS id, p.name AS name ORDER BY p.id LIMIT 100
```

and reads one project's provenance (`src/decision.mjs`):

```cypher
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
```

`OPTIONAL MATCH` is deliberate. With plain `MATCH`, a claim that has no source simply disappears from
the result, and the agent would confidently pick from what is left. Keeping it as a row with a null
source lets the policy see the gap and abstain (the Lyra case).

### The decision policy (`src/decision.mjs`)

1. Any row with missing provenance (no source, rank, owner or valid time) → **abstain**.
2. Claims that take effect after "now" are ignored. More than one service for the project → abstain.
3. Highest source authority wins, then the most recent effective time (compared as UTC instants, so
   `12:00Z` and `19:00+07:00` are the same moment).
4. Two different owners at the same top authority and instant → **abstain**, listing both.
5. 50 rows (the query limit) → abstain, because a conflicting claim might have been cut off.

## Run it locally

Requirements: Node 24, Docker with a running Linux engine, a free NVIDIA API key.

```bash
docker compose up -d graph            # FalkorDB on 127.0.0.1:16379 (pinned image digest)
npm install --ignore-scripts
cp .env.example .env                  # add your nvapi- key from https://build.nvidia.com
npm run smoke                         # real write + read of a probe node
npm run seed                          # synthetic company graph (4 projects)
npm start                             # http://127.0.0.1:18737
```

Command-line equivalents:

```bash
npm run ask                           # the four demo questions through Nemotron + FalkorDB
npm run ask -- "Who owns Vega?"       # your own question
npm run graph:counterfactual          # live counterfactual on the separate acceptance graph
npm test                              # 34 offline tests (mock graph and mock model)
docker compose stop graph
```

`MODEL_PROVIDER=local` with `LOCAL_LLM_URL` / `LOCAL_LLM_MODEL` runs the same agent on a loopback
OpenAI-compatible server (llama.cpp) instead of NVIDIA's API.

## Safety choices

- The graph host, the app and the local-model endpoint are loopback-only; the hosted model may only call
  `https://integrate.api.nvidia.com`. The API key is read from `.env` (git-ignored) and sent only as a
  bearer header.
- One read-only tool with a closed project enum. No user-supplied Cypher is ever executed.
- Output is a draft with `requiresHumanApproval: true` and `authorizedExternalActions: false`.
- Model failure, graph outage and malformed tool calls all end in **abstain**, never in a guess.

## Tests and evidence

- `npm test`: 34 tests covering the policy (ties, timezones, gaps, row cap), the agent (tool scope,
  explanation check, model and graph failures) and the NVIDIA adapter.
- `evidence/`: dated logs of the live runs (FalkorDB smoke, seed, counterfactual, Nemotron tool calls).

## Built during the hackathon, with AI assistance

All code was written after the event opened (15 Oct 2026, 00:01 IST). It was built with AI coding
assistants (Anthropic Claude via Claude Code), and the agent itself runs on NVIDIA Nemotron. The
participant reviewed and ran the code, and understands the design above. Data is synthetic; names carry
a "(synthetic)" suffix.

## Limits

- The demo graph is small and synthetic: four projects, eight claims. The policy is general, but the
  source authorities are hand-set.
- One question type (ownership/sign-off). Other company questions would need their own read-only tools
  and policies.
- The explanation check is a guard, not a proof: it rejects text that names the wrong owner or claims
  approval, and falls back to a fixed template.

License: MIT.
