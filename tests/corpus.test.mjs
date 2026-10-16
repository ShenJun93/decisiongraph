import test from "node:test";
import assert from "node:assert/strict";
import {loadCorpus, liveSource, parseFrontmatter, AUTHORITY} from "../src/corpus.mjs";

const c = loadCorpus();

test("corpus loads: every source has a known kind, an authority and a valid time", () => {
  assert.ok(c.sources.length >= 100);
  for (const s of c.sources) {
    assert.ok(s.kind in AUTHORITY, s.id);
    assert.equal(s.authority, AUTHORITY[s.kind]);
    assert.ok(Number.isFinite(Date.parse(s.at)), s.id);
  }
});

test("every person, service and topic a record points at exists", () => {
  const people = new Set(c.org.people.map(p => p.id));
  const services = new Set(c.catalog.services.map(s => s.id));
  const topics = new Set(c.catalog.topics.map(t => t.id));
  for (const s of c.sources) {
    if (s.author) assert.ok(people.has(s.author), s.id + " author");
    for (const k of ["reporter", "assignee", "resolvedBy"]) if (s[k]) assert.ok(people.has(s[k]), s.id + " " + k);
    if (s.serviceId) assert.ok(services.has(s.serviceId), s.id);
    for (const t of s.topicIds || []) assert.ok(topics.has(t), s.id + " topic " + t);
  }
  for (const p of c.catalog.projects) for (const sid of p.serviceIds) assert.ok(services.has(sid), p.id);
});

test("live items and frontmatter parse", () => {
  for (const item of c.live) assert.ok(liveSource(item).id.startsWith("live-"));
  assert.equal(parseFrontmatter("---\nid: a\ndate: 2026-10-12T19:00:00+07:00\n---\nbody").meta.date, "2026-10-12T19:00:00+07:00");
  assert.throws(() => parseFrontmatter("no frontmatter"));
});
