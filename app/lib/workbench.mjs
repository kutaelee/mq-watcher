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

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

export function collectSnapshotFacts(result) {
  const facts = new Map();
  for (const item of result?.destinations ?? []) {
    facts.set(`destination\u0000${item.type}:${item.name}`, item.occurrences ?? 1);
  }
  for (const item of result?.subscriptions ?? []) {
    facts.set(`subscription\u0000${item.rawId}`, item.occurrences ?? 1);
  }
  for (const record of result?.structured?.records ?? []) {
    const destination = record.destination?.name ?? "Unknown";
    increment(facts, `command\u0000${record.command}:${destination}`);
  }
  for (const item of result?.files ?? []) {
    facts.set(`journal-bytes\u0000${item.path}`, item.size ?? 0);
  }
  for (const [kind, value] of Object.entries(result?.correlation?.counts ?? {})) {
    facts.set(`correlation\u0000${kind}`, Number(value) || 0);
  }
  return facts;
}

export function buildSnapshotDiff(left, right) {
  const a = collectSnapshotFacts(left);
  const b = collectSnapshotFacts(right);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x.localeCompare(y));
  return keys.flatMap((compound) => {
    const [category, key] = compound.split("\u0000");
    const leftObserved = a.has(compound);
    const rightObserved = b.has(compound);
    const leftValue = a.get(compound) ?? null;
    const rightValue = b.get(compound) ?? null;
    if (leftObserved && rightObserved && leftValue === rightValue) return [];
    return [{
      id: `${category}:${key}`,
      category,
      key,
      leftValue,
      rightValue,
      delta: typeof leftValue === "number" && typeof rightValue === "number" ? rightValue - leftValue : null,
      status: !leftObserved ? "not-observed-left" : !rightObserved ? "not-observed-right" : "changed",
    }];
  });
}
