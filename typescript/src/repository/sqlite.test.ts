import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, type TestContext } from "node:test";
import type { Event, Flag } from "../model/index.js";
import { ExistsError, NotFoundError } from "./index.js";
import type { AuditEntry } from "./index.js";
import { SqliteRepository } from "./sqlite.js";

function open(t: TestContext): SqliteRepository {
  const repo = new SqliteRepository(":memory:");
  t.after(() => repo.close());
  return repo;
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ffservice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const flag = (key: string, extra: Partial<Flag> = {}): Flag => ({
  key, description: "d", enabled: true, rules: [], rolloutPercent: 100, variants: [],
  createdAt: "2026-01-31T08:00:00.123Z", updatedAt: "2026-01-31T08:00:00.123Z", ...extra,
});

const insert = (repo: SqliteRepository, f: Flag): void => repo.tx((tx) => tx.insertFlag(f));
const audit = (flagKey: string, action: AuditEntry["action"], before: Flag | null, after: Flag | null): AuditEntry => ({
  flagKey, action, before, after, createdAt: "2026-01-31T08:00:00.000Z",
});

describe("flags", () => {
  test("insert then get round-trips every field, including non-ASCII text and rule values", (t) => {
    const repo = open(t);
    const f = flag("checkout", {
      description: "ธง 🚩 café", enabled: false, rolloutPercent: 25,
      rules: [
        { attribute: "country", operator: "in", value: ["TH", "SG"] },
        { attribute: "age", operator: "eq", value: 18 },
        { attribute: "beta", operator: "eq", value: true },
      ],
      variants: [{ key: "z", weight: 10 }, { key: "a", weight: 90 }], // not alphabetical on purpose
    });
    insert(repo, f);
    assert.deepEqual(repo.getFlag("checkout"), f);
  });

  test("an unknown flag is null", (t) => assert.equal(open(t).getFlag("nope"), null));

  test("inserting a taken key throws ExistsError and keeps the original", (t) => {
    const repo = open(t);
    insert(repo, flag("dup"));
    assert.throws(() => insert(repo, flag("dup", { description: "second" })), ExistsError);
    assert.equal(repo.getFlag("dup")?.description, "d");
  });

  test("update replaces the fields but keeps createdAt", (t) => {
    const repo = open(t);
    insert(repo, flag("u"));
    repo.tx((tx) => tx.updateFlag(flag("u", { description: "changed", enabled: false, createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" })));
    const got = repo.getFlag("u");
    assert.equal(got?.description, "changed");
    assert.equal(got?.enabled, false);
    assert.equal(got?.updatedAt, "2026-02-01T00:00:00.000Z");
    assert.equal(got?.createdAt, "2026-01-31T08:00:00.123Z");
  });

  test("updating or deleting an unknown flag throws NotFoundError", (t) => {
    const repo = open(t);
    assert.throws(() => repo.tx((tx) => tx.updateFlag(flag("ghost"))), NotFoundError);
    assert.throws(() => repo.tx((tx) => tx.deleteFlag("ghost")), NotFoundError);
  });

  test("delete removes the flag, and the key can be used again", (t) => {
    const repo = open(t);
    insert(repo, flag("gone"));
    repo.tx((tx) => tx.deleteFlag("gone"));
    assert.equal(repo.getFlag("gone"), null);
    insert(repo, flag("gone", { description: "second life" }));
    assert.equal(repo.getFlag("gone")?.description, "second life");
  });

  test("listFlags is sorted by key, paged, and reports the total", (t) => {
    const repo = open(t);
    for (const k of ["m", "b", "z", "a", "k"]) insert(repo, flag(k));
    const keys = (p: { items: Flag[] }) => p.items.map((f) => f.key);
    const first = repo.listFlags(2, 0);
    assert.deepEqual([keys(first), first.total], [["a", "b"], 5]);
    const second = repo.listFlags(2, 2);
    assert.deepEqual([keys(second), second.total], [["k", "m"], 5]);
    const past = repo.listFlags(2, 100);
    assert.deepEqual([past.items, past.total], [[], 5]);
    assert.deepEqual(repo.listAllFlags().map((f) => f.key), ["a", "b", "k", "m", "z"]);
  });
});

describe("transactions", () => {
  test("a failed transaction rolls back the flag and its audit entry together", (t) => {
    const repo = open(t);
    assert.throws(
      () =>
        repo.tx((tx) => {
          tx.insertFlag(flag("rolled-back"));
          tx.appendAudit(audit("rolled-back", "create", null, flag("rolled-back")));
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(repo.getFlag("rolled-back"), null);
    assert.equal(repo.listAudit(undefined, 10, 0).total, 0);
  });

  test("whatever is thrown rolls back and leaves the repository usable, even a non-Error", (t) => {
    const repo = open(t);
    for (const thrown of [new Error("x"), "a string", 42, { code: 1 }, undefined]) {
      assert.throws(() => repo.tx((tx) => { tx.insertFlag(flag("p")); throw thrown; }));
      assert.equal(repo.getFlag("p"), null, `after throwing ${String(thrown)}`);
    }
    insert(repo, flag("still-works"));
    assert.ok(repo.getFlag("still-works"));
  });

  test("an async callback is rejected and nothing it did survives (better-sqlite3 would commit it)", (t) => {
    const repo = open(t);
    const asyncCallback = async (tx: Parameters<Parameters<typeof repo.tx>[0]>[0]) => {
      tx.insertFlag(flag("async-flag")); // the synchronous part runs before the first await
      await Promise.resolve();
    };
    assert.throws(() => repo.tx(asyncCallback as never), /synchronous/);
    assert.equal(repo.getFlag("async-flag"), null);
  });

  test("tx returns what the callback returns", (t) => {
    const repo = open(t);
    assert.equal(repo.tx(() => 42), 42);
  });
});

describe("audit log", () => {
  test("is newest first, filterable, pageable, and keeps null before/after", (t) => {
    const repo = open(t);
    const f = flag("x");
    repo.tx((tx) => tx.appendAudit(audit("x", "create", null, f)));
    repo.tx((tx) => tx.appendAudit(audit("y", "create", null, flag("y"))));
    repo.tx((tx) => tx.appendAudit(audit("x", "delete", f, null)));

    const all = repo.listAudit(undefined, 10, 0);
    assert.equal(all.total, 3);
    assert.ok(all.items[0]!.id > all.items[1]!.id && all.items[1]!.id > all.items[2]!.id, "ids must decrease down the list");

    const xs = repo.listAudit("x", 10, 0);
    assert.deepEqual(xs.items.map((e) => e.action), ["delete", "create"]);
    assert.equal(xs.total, 2);
    assert.deepEqual(xs.items[0]!.before, f);
    assert.equal(xs.items[0]!.after, null);
    assert.equal(xs.items[1]!.before, null);
    assert.equal(JSON.parse(JSON.stringify(xs.items[0])).after, null, "a missing 'after' must serialise as null");

    assert.deepEqual(repo.listAudit("nobody", 10, 0), { items: [], total: 0 });
    const page = repo.listAudit(undefined, 1, 2);
    assert.deepEqual([page.total, page.items.length, page.items[0]!.action, page.items[0]!.flagKey], [3, 1, "create", "x"]);
  });
});

describe("events", () => {
  const exposure = (flagKey: string, userId: string, variant: string): Event => ({ type: "exposure", userId, flagKey, variant });
  const conversion = (goal: string, userId: string): Event => ({ type: "conversion", userId, goal });
  const asObject = (m: Map<string, number>) => Object.fromEntries(m);

  test("the first exposure wins and duplicates count once", (t) => {
    const repo = open(t);
    repo.recordEvents([
      exposure("f", "u1", "control"), exposure("f", "u1", "control"),
      exposure("f", "u2", "control"), exposure("f", "u2", "treatment"), // the second variant is ignored
      exposure("f", "u3", "treatment"),
      exposure("other", "u1", "treatment"), // another flag is independent
    ]);
    assert.deepEqual(asObject(repo.variantCounts("f", "g").exposures), { control: 2, treatment: 1 });
  });

  test("conversions count once per user and only for users exposed to the flag, whatever the order", (t) => {
    const repo = open(t);
    repo.recordEvents([conversion("buy", "u1"), conversion("buy", "u1"), conversion("buy", "u9"), conversion("signup", "u2")]);
    repo.recordEvents([exposure("f", "u1", "control"), exposure("f", "u2", "treatment")]);
    assert.deepEqual(asObject(repo.variantCounts("f", "buy").conversions), { control: 1 });
    assert.deepEqual(asObject(repo.variantCounts("f", "signup").conversions), { treatment: 1 });
    assert.deepEqual(asObject(repo.variantCounts("f", "never").conversions), {});
  });

  test("a batch is all or nothing", (t) => {
    const repo = open(t);
    assert.throws(() => repo.recordEvents([exposure("f", "u1", "control"), { type: "bogus", userId: "u2" } as unknown as Event]), /unknown event type/);
    assert.deepEqual(asObject(repo.variantCounts("f", "g").exposures), {});
  });

  test("a variant named like an Object.prototype member is just a name", (t) => {
    const repo = open(t);
    repo.recordEvents([exposure("f", "u1", "constructor"), exposure("f", "u2", "__proto__")]);
    const counts = repo.variantCounts("f", "g").exposures;
    assert.equal(counts.get("constructor"), 1);
    assert.equal(counts.get("__proto__"), 1);
  });
});

describe("files", () => {
  test("data survives closing and reopening a file database", (t) => {
    const path = join(tempDir(t), "flags.db");
    const first = new SqliteRepository(path);
    insert(first, flag("persisted"));
    first.close();
    const second = new SqliteRepository(path);
    t.after(() => second.close());
    assert.ok(second.getFlag("persisted"));
  });

  test("paths with characters that are special in URIs create the file exactly there", (t) => {
    const dir = tempDir(t);
    for (const name of ["a b.db", "q?mark.db", "hash#tag.db", "pct%41.db", "ไทย.db"]) {
      const path = join(dir, name);
      const repo = new SqliteRepository(path);
      insert(repo, flag("x"));
      repo.close();
      assert.ok(existsSync(path), `no database file at ${name}`);
      const again = new SqliteRepository(path);
      assert.ok(again.getFlag("x"), `data not found after reopening ${name}`);
      again.close();
    }
  });
});
