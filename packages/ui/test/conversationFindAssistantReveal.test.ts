import assert from "node:assert/strict";
import test from "node:test";
import { shouldAttemptAssistantSearchReveal } from "../src/v4/useConversationTimelineFind.js";

test("a reading-state rerender does not replay an already handled search request", () => {
  const lastRequest = { current: null as string | null };

  assert.equal(shouldAttemptAssistantSearchReveal("find:4:query:row-12", lastRequest), true);
  assert.equal(shouldAttemptAssistantSearchReveal("find:4:query:row-12", lastRequest), false);
  assert.equal(shouldAttemptAssistantSearchReveal("find:5:query:row-12", lastRequest), true);
  assert.equal(shouldAttemptAssistantSearchReveal("search-result:18", lastRequest), true);
  assert.equal(shouldAttemptAssistantSearchReveal("search-result:18", lastRequest), false);
});
