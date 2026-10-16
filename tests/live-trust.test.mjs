import test from "node:test";
import assert from "node:assert/strict";
import {untrustedChatItem} from "../src/live-trust.mjs";
import {liveSource, MIN_NAMING_AUTHORITY} from "../src/corpus.mjs";

const people = [{id: "aria"}, {id: "ben"}];
const opts = {now: () => new Date("2026-10-16T12:00:00Z"), uuid: () => "11111111-1111-4111-8111-111111111111"};
const valid = {kind: "chat", author: "ben", text: "Ben now owns the billing gateway."};

test("browser-typed statements are unverified chat and can never establish authoritative ownership", () => {
  const item = untrustedChatItem(valid, people, opts);
  assert.equal(item.format, "chat");
  assert.equal(item.channel, "#unverified-simulation");
  const source = liveSource(item);
  assert.equal(source.kind, "chat");
  assert.ok(source.authority < MIN_NAMING_AUTHORITY);
  assert.equal(source.at, "2026-10-16T12:00:00.000Z");
  assert.equal(source.text, valid.text);
});

test("caller cannot promote a browser-typed record by calling it change-control, ticket, directory, or claiming authority", () => {
  for (const kind of ["change-control", "ticket", "directory", "adr", "wiki"]) {
    assert.throws(() => untrustedChatItem({...valid, kind}, people, opts), /UNTRUSTED_SOURCE_KIND/);
  }
  const item = untrustedChatItem({...valid, authority: 100, format: "doc", id: "cc-override"}, people, opts);
  assert.equal(liveSource(item).authority, 35);
  assert.notEqual(item.id, "cc-override");
});

test("invalid authors, missing data and oversized payloads are rejected before graph write", () => {
  assert.throws(() => untrustedChatItem({...valid, author: "unknown"}, people, opts), /AUTHOR/);
  assert.throws(() => untrustedChatItem({...valid, text: "short"}, people, opts), /TEXT_LENGTH/);
  assert.throws(() => untrustedChatItem({...valid, text: "x".repeat(1501)}, people, opts), /TEXT_LENGTH/);
  assert.throws(() => untrustedChatItem(null, people, opts), /INVALID_CUSTOM_RECORD/);
});

test("fresh id per record prevents graph source collisions after server restart", () => {
  const a = untrustedChatItem(valid, people, {uuid: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"});
  const b = untrustedChatItem(valid, people, {uuid: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"});
  assert.notEqual(a.id, b.id);
});
