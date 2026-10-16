// Trust boundary for interactive demo records. A browser user is NOT the change-control authority.
// Canned, organizer-owned change-control fixtures may be used in the demo, but user-typed text
// remains unverified chat regardless of any caller-supplied document kind or claimed authority.
import {randomUUID} from "node:crypto";

export function untrustedChatItem(input, people, {now = () => new Date(), uuid = randomUUID} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_CUSTOM_RECORD");
  if (input.kind != null && input.kind !== "chat") throw new Error("UNTRUSTED_SOURCE_KIND");
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length < 10 || text.length > 1500) throw new Error("TEXT_LENGTH");
  if (!Array.isArray(people) || !people.some(p => p.id === input.author)) throw new Error("AUTHOR");
  const at = now().toISOString();
  // UUID avoids overwriting an older claim after a server restart (a sequential id did not).
  return {id: "live-custom-" + uuid(), format: "chat", channel: "#unverified-simulation",
    author: input.author, at, text};
}
