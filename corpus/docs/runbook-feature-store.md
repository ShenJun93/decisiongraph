---
id: runbook-feature-store
kind: runbook
title: "Runbook: Feature Store"
author: jun
date: 2026-09-10T09:00:00Z
---

# Runbook: Feature Store

Jun Park owns the feature store and is the second-line escalation after the data on-call.

The feature store serves online features (merchant velocity, card velocity, device reputation) to the fraud scoring
path and keeps an offline copy in the analytics warehouse for training. Since ADR-009 the online layer runs on a
Redis cluster (three shards, one replica each) on the shared Kubernetes platform.

## Dashboards

- `Feature Store / Online` - read latency p50/p99, hit ratio, keys per feature group.
- `Feature Store / Freshness` - age of the newest write per feature group.

## Alerts and first response

### FeatureStoreReadLatencyHigh (p99 > 15 ms for 5 min)

1. Check whether a backfill is running (`kubectl get jobs -n features`). Backfills in dual-write mode can saturate a
   shard. Pause the job with `kubectl patch job <name> -p '{"spec":{"suspend":true}}'` if fraud scoring is affected.
2. Look at the per-shard CPU panel. One hot shard usually means a new feature group with a skewed key; note it in the
   incident channel.
3. If all shards are hot, scale the read replicas through the Terraform module (`features/redis`), not by hand.

### FeatureStoreStale (newest write older than 20 min)

1. Check the streaming writer deployment logs for Kafka consumer errors.
2. Confirm the event bus is healthy (see the event bus runbook).
3. If the writer is crash-looping on a bad record, move the record to the dead-letter topic with the `skip-offset`
   script and restart the writer.

## Backfills

Backfills read from the warehouse and write to Redis. Always run the verification step afterwards; it samples 1% of
keys and compares them with the offline copy. A mismatch above 0.1% means the backfill should be re-run.

## Escalation

Data on-call first, then the feature store owner listed at the top of this page.
