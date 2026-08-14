export const MAX_STORE_SESSIONS: number;
export function sessionId(signature: string): string;
export function findReusableSession<T extends { signature: string }>(sessions: T[], signature: string): T | null;
export function closeSession<T extends { id: string }>(sessions: T[], activeSessionId: string | null, closingId: string): { sessions: T[]; activeSessionId: string | null };
export function restoreSessions<T>(state: unknown): T[];
