---
id: runbook-ml-pipeline
kind: runbook
title: "Runbook: ML Pipeline"
author: cora
date: 2026-10-01T09:00:00Z
---

# Runbook: ML Pipeline

Cora Lindqvist owns the ML pipeline (ml-pipeline) and is the escalation point after the data on-call.

The ML pipeline trains, evaluates and promotes the fraud models used by payment scoring. It runs as a set of DAGs on
the shared Kubernetes platform: `features_snapshot` (daily), `train_fraud` (weekly, Sunday 02:00 UTC),
`evaluate_and_promote` (after each training run) and `shadow_score` (continuous while a candidate model exists).

## Dashboards

- `ML Pipeline / DAG runs` - status and duration per DAG.
- `Fraud Models / Drift` - population stability index per feature, score distribution by day of week.

## Alerts and first response

### TrainFraudFailed

1. Open the failed task logs. Most failures are the training set query timing out against the warehouse.
2. Re-run the DAG from the failed task, not from the start; the feature snapshot is already written.
3. If two consecutive runs fail, keep the current production model and open a ticket.

### FraudModelDrift (PSI > 0.2 on any top-20 feature)

1. Check the day of week. Weekend traffic is lower and skews some velocity features; the threshold was adjusted in
   ML-30, so a weekend alert now usually means real drift.
2. Compare with the shadow model's scores if a candidate exists.
3. Do not roll back a model without the risk team's agreement.

### PromotionBlocked

Promotion stops when the candidate's precision at the operating threshold is below production's. That is expected
behaviour, not an incident. Note it on the training ticket.

## On-call

Data on-call handles first response. Rotation and handover notes are in the data team's on-call doc.
