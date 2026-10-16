---
id: wiki-ml-pipeline
kind: wiki
title: "ML Pipeline overview"
author: dev
date: 2026-10-13T14:00:00Z
---

# ML Pipeline overview

_Last edited 2026-10-13. Community page; corrections welcome._

Dev Mehta owns the ML pipeline and reviews changes to the training DAGs.

## What it does

The pipeline takes daily feature snapshots from the feature store's offline copy, trains the fraud model once a week,
evaluates the candidate against production, and promotes it if it wins on precision at the operating threshold. A
promoted model is served by the scoring sidecar next to the payments API.

## New training schedule (from 2026-10-19)

- `features_snapshot` moves from 01:00 to 00:30 UTC to finish before the warehouse maintenance window.
- `train_fraud` stays weekly but moves from Sunday to Saturday night, so a failed run can be retried before Monday
  traffic.
- `shadow_score` now runs for at least 72 hours before any promotion.

## Useful links

- Runbook for alerts and first response (data on-call).
- Project Vega planning doc.
- Drift dashboard: `Fraud Models / Drift`.

## FAQ

**Can I add a feature to the model myself?** Add it to the feature store first, then open a ticket with the backfill
plan. The training set query picks up new features only after a full snapshot.

**Where are old models kept?** In the model registry, tagged by training date. We keep the last twelve.
