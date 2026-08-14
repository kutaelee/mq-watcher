export const MAX_STORE_SESSIONS = 6;

export function sessionId(signature) {
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `store-${(hash >>> 0).toString(16)}`;
}

export function findReusableSession(sessions, signature) {
  return sessions.find((session) => session.signature === signature) ?? null;
}

export function closeSession(sessions, activeSessionId, closingId) {
  const index = sessions.findIndex((session) => session.id === closingId);
  if (index < 0) return { sessions, activeSessionId };
  const next = sessions.filter((session) => session.id !== closingId);
  if (activeSessionId !== closingId) return { sessions: next, activeSessionId };
  return {
    sessions: next,
    activeSessionId: next[Math.min(index, next.length - 1)]?.id ?? null,
  };
}

export function restoreSessions(state) {
  if (!state || !Array.isArray(state.sessions)) return [];
  return state.sessions.slice(0, MAX_STORE_SESSIONS).filter((session) =>
    session && typeof session.id === "string" && session.result && session.signature,
  ).map((session) => ({
    ...session,
    status: "ready",
    progress: null,
    error: "",
    restored: true,
  }));
}
