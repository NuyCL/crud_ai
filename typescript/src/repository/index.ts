// What the service needs from storage. The service depends on these interfaces, not on SQLite.
// Everything is synchronous because better-sqlite3 is: an operation cannot be interleaved with
// another one, so a transaction never has to be held open across an await.
import type { AuditAction, AuditLog, Event, Flag } from "../model/index.js";

/** Thrown when a flag does not exist. */
export class NotFoundError extends Error {
  constructor(key: string) {
    super(`flag ${JSON.stringify(key)} not found`);
    this.name = "NotFoundError";
  }
}

/** Thrown when inserting a flag whose key is taken. */
export class ExistsError extends Error {
  constructor(key: string) {
    super(`flag ${JSON.stringify(key)} already exists`);
    this.name = "ExistsError";
  }
}

/** An audit entry as it is written: the repository assigns the id. */
export interface AuditEntry {
  flagKey: string;
  action: AuditAction;
  before: Flag | null;
  after: Flag | null;
  createdAt: string;
}

/** Operations that must commit or roll back together: a flag change and its audit entry. */
export interface Tx {
  getFlag(key: string): Flag | null;
  /** @throws ExistsError */
  insertFlag(flag: Flag): void;
  /** Replaces everything except `createdAt`. @throws NotFoundError */
  updateFlag(flag: Flag): void;
  /** @throws NotFoundError */
  deleteFlag(key: string): void;
  appendAudit(entry: AuditEntry): void;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface Repository {
  /**
   * Runs `fn` in a transaction: if it throws, everything it did is rolled back and the error
   * propagates. `fn` must be synchronous; one that returns a promise is rejected, because the
   * transaction would already be committed by the time the promise settles.
   */
  tx<T>(fn: (tx: Tx) => T): T;

  getFlag(key: string): Flag | null;
  /** One page ordered by key ascending, and the total count. */
  listFlags(limit: number, offset: number): Page<Flag>;
  listAllFlags(): Flag[];
  /** One page, newest first. An undefined `flagKey` means every flag. */
  listAudit(flagKey: string | undefined, limit: number, offset: number): Page<AuditLog>;

  /**
   * Stores all events or none. The first exposure of a (flag, user) wins and repeated
   * conversions of a (goal, user) count once.
   */
  recordEvents(events: Event[]): void;
  /** Per variant key: users exposed, and how many of them converted on `goal`. */
  variantCounts(flagKey: string, goal: string): { exposures: Map<string, number>; conversions: Map<string, number> };

  close(): void;
}
