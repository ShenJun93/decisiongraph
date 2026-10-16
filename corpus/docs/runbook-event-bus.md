---
id: runbook-event-bus
kind: runbook
title: "Runbook: Event Bus (Kafka)"
author: vik
date: 2026-08-18T09:00:00Z
---

# Runbook: Event Bus (Kafka)

Vik Sharma owns the event bus and should be paged after the platform on-call has worked through the steps below.

The event bus is our Kafka cluster (five brokers, KRaft mode) plus the schema registry. Main topics: `orders`,
`clickstream`, `ledger-events` (see ADR-007), `catalog-updates` and the dead-letter topics `*.dlq`.

## Dashboards

- `Event Bus / Brokers` - under-replicated partitions, request latency, disk usage.
- `Event Bus / Consumers` - lag per consumer group.

## Alerts and first response

### UnderReplicatedPartitions > 0 for 10 min

1. Check broker pods: `kubectl get pods -n kafka`. A broker in CrashLoopBackOff is the usual cause.
2. Check disk on the affected broker. If it is above 85%, look for a topic whose retention was changed recently.
3. Do not restart more than one broker at a time.

### ConsumerLagHigh (any group > 50k messages for 15 min)

1. Find the group on the consumer dashboard and tell the consuming team in their channel.
2. If the lag started right after a broker restart, the group may be stuck rebalancing. Check the group state with
   `kafka-consumer-groups --describe --group <group>`.
3. Never reset offsets for someone else's consumer group without their OK.

### SchemaRegistryRejects

1. Read the rejected schema from the producer logs.
2. Compare with the registered version. Most rejects are a missing default on a new field.

## Changes

Broker upgrades and topic config changes go through the Tuesday platform change window. Topic configuration lives in
the Terraform module `platform-modules/kafka`; do not change retention by hand.
