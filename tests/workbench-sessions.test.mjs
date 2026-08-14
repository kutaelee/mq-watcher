import assert from "node:assert/strict";
import test from "node:test";
import { closeSession, findReusableSession, MAX_STORE_SESSIONS, restoreSessions, sessionId } from "../app/lib/workbench.mjs";

test("session IDs and duplicate lookup are deterministic", () => {
  assert.equal(sessionId("3:store:1:abc"), sessionId("3:store:1:abc"));
  assert.notEqual(sessionId("3:store:1:abc"), sessionId("3:store:1:def"));
  const existing = { id: "a", signature: "same" };
  assert.equal(findReusableSession([existing], "same"), existing);
});

test("closing the active tab selects the nearest remaining tab", () => {
  const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(closeSession(sessions, "b", "b"), {
    sessions: [{ id: "a" }, { id: "c" }],
    activeSessionId: "c",
  });
});

test("restoration is bounded and marks cached sessions", () => {
  const sessions = Array.from({ length: MAX_STORE_SESSIONS + 2 }, (_, index) => ({
    id: `s${index}`,
    signature: `sig${index}`,
    result: { signature: `sig${index}` },
  }));
  const restored = restoreSessions({ sessions });
  assert.equal(restored.length, MAX_STORE_SESSIONS);
  assert.ok(restored.every((session) => session.restored && session.status === "ready"));
});
