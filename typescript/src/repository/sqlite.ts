import Database from "better-sqlite3";
import type { AuditAction, AuditLog, Event, Flag, Rule, Variant } from "../model/index.js";
import { ExistsError, NotFoundError } from "./index.js";
import type { AuditEntry, Page, Repository, Tx } from "./index.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flags (
  key             TEXT PRIMARY KEY,
  description     TEXT NOT NULL,
  enabled         INTEGER NOT NULL,
  rules           TEXT NOT NULL,
  rollout_percent INTEGER NOT NULL,
  variants        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  flag_key   TEXT NOT NULL,
  action     TEXT NOT NULL,
  before     TEXT,
  after      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_flag_key ON audit_logs (flag_key, id);
CREATE TABLE IF NOT EXISTS exposures (
  flag_key TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  variant  TEXT NOT NULL,
  PRIMARY KEY (flag_key, user_id)
);
CREATE TABLE IF NOT EXISTS conversions (
  goal    TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (goal, user_id)
);
`;

const FLAG_COLUMNS = "key, description, enabled, rules, rollout_percent, variants, created_at, updated_at";

interface FlagRow {
  key: string;
  description: string;
  enabled: number;
  rules: string;
  rollout_percent: number;
  variants: string;
  created_at: string;
  updated_at: string;
}

interface AuditRow {
  id: number;
  flag_key: string;
  action: string;
  before: string | null;
  after: string | null;
  created_at: string;
}

function toFlag(row: FlagRow): Flag {
  return {
    key: row.key,
    description: row.description,
    enabled: row.enabled !== 0,
    rules: JSON.parse(row.rules) as Rule[],
    rolloutPercent: row.rollout_percent,
    variants: JSON.parse(row.variants) as Variant[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite implementation of Repository. */
export class SqliteRepository implements Repository {
  private readonly db: Database.Database;

  /**
   * Opens (and creates, if needed) the database at `path`; ":memory:" gives a private in-memory
   * one. `path` is a file name, not a URI, so characters such as `?` `#` `%` need no escaping.
   */
  constructor(path: string) {
    this.db = new Database(path, { timeout: 5000 });
    if (path !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: (tx: Tx) => T): T {
    const run = this.db.transaction((): T => {
      const result = fn(new SqliteTx(this.db));
      if (isThenable(result)) {
        // better-sqlite3 commits as soon as the callback returns. An async callback would
        // "succeed" before doing any of its work and could never be rolled back.
        throw new TypeError("repository.tx callbacks must be synchronous");
      }
      return result;
    });
    return run();
  }

  getFlag(key: string): Flag | null {
    return getFlag(this.db, key);
  }

  listFlags(limit: number, offset: number): Page<Flag> {
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM flags").get() as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT ${FLAG_COLUMNS} FROM flags ORDER BY key ASC LIMIT ? OFFSET ?`)
      .all(limit, offset) as FlagRow[];
    return { items: rows.map(toFlag), total };
  }

  listAllFlags(): Flag[] {
    return (this.db.prepare(`SELECT ${FLAG_COLUMNS} FROM flags ORDER BY key ASC`).all() as FlagRow[]).map(toFlag);
  }

  listAudit(flagKey: string | undefined, limit: number, offset: number): Page<AuditLog> {
    const where = flagKey === undefined ? "" : " WHERE flag_key = ?";
    const args = flagKey === undefined ? [] : [flagKey];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs${where}`).get(...args) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT id, flag_key, action, before, after, created_at FROM audit_logs${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as AuditRow[];
    const items = rows.map(
      (r): AuditLog => ({
        id: r.id,
        flagKey: r.flag_key,
        action: r.action as AuditAction,
        before: r.before === null ? null : (JSON.parse(r.before) as Flag),
        after: r.after === null ? null : (JSON.parse(r.after) as Flag),
        createdAt: r.created_at,
      }),
    );
    return { items, total };
  }

  recordEvents(events: Event[]): void {
    const exposure = this.db.prepare("INSERT OR IGNORE INTO exposures (flag_key, user_id, variant) VALUES (?, ?, ?)");
    const conversion = this.db.prepare("INSERT OR IGNORE INTO conversions (goal, user_id) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const e of events) {
        switch (e.type) {
          case "exposure":
            exposure.run(e.flagKey, e.userId, e.variant);
            break;
          case "conversion":
            conversion.run(e.goal, e.userId);
            break;
          default:
            throw new Error(`unknown event type ${JSON.stringify((e as { type: unknown }).type)}`);
        }
      }
    })();
  }

  variantCounts(flagKey: string, goal: string): { exposures: Map<string, number>; conversions: Map<string, number> } {
    const toMap = (rows: { variant: string; n: number }[]) => new Map(rows.map((r) => [r.variant, r.n]));
    const exposures = this.db
      .prepare("SELECT variant, COUNT(*) AS n FROM exposures WHERE flag_key = ? GROUP BY variant")
      .all(flagKey) as { variant: string; n: number }[];
    // A conversion counts only for users exposed to this flag (BR-41), however the two events were ordered.
    const conversions = this.db
      .prepare(
        `SELECT e.variant AS variant, COUNT(*) AS n FROM exposures e
         JOIN conversions c ON c.user_id = e.user_id AND c.goal = ?
         WHERE e.flag_key = ? GROUP BY e.variant`,
      )
      .all(goal, flagKey) as { variant: string; n: number }[];
    return { exposures: toMap(exposures), conversions: toMap(conversions) };
  }
}

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function getFlag(db: Database.Database, key: string): Flag | null {
  const row = db.prepare(`SELECT ${FLAG_COLUMNS} FROM flags WHERE key = ?`).get(key) as FlagRow | undefined;
  return row === undefined ? null : toFlag(row);
}

class SqliteTx implements Tx {
  constructor(private readonly db: Database.Database) {}

  getFlag(key: string): Flag | null {
    return getFlag(this.db, key);
  }

  insertFlag(flag: Flag): void {
    if (this.db.prepare("SELECT 1 FROM flags WHERE key = ?").get(flag.key) !== undefined) throw new ExistsError(flag.key);
    this.db
      .prepare(`INSERT INTO flags (${FLAG_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        flag.key,
        flag.description,
        flag.enabled ? 1 : 0,
        JSON.stringify(flag.rules),
        flag.rolloutPercent,
        JSON.stringify(flag.variants),
        flag.createdAt,
        flag.updatedAt,
      );
  }

  updateFlag(flag: Flag): void {
    const result = this.db
      .prepare(
        "UPDATE flags SET description = ?, enabled = ?, rules = ?, rollout_percent = ?, variants = ?, updated_at = ? WHERE key = ?",
      )
      .run(flag.description, flag.enabled ? 1 : 0, JSON.stringify(flag.rules), flag.rolloutPercent, JSON.stringify(flag.variants), flag.updatedAt, flag.key);
    if (result.changes === 0) throw new NotFoundError(flag.key);
  }

  deleteFlag(key: string): void {
    if (this.db.prepare("DELETE FROM flags WHERE key = ?").run(key).changes === 0) throw new NotFoundError(key);
  }

  appendAudit(entry: AuditEntry): void {
    this.db
      .prepare("INSERT INTO audit_logs (flag_key, action, before, after, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        entry.flagKey,
        entry.action,
        entry.before === null ? null : JSON.stringify(entry.before),
        entry.after === null ? null : JSON.stringify(entry.after),
        entry.createdAt,
      );
  }
}
