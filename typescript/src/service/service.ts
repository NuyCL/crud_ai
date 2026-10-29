// The use cases. Every method takes what the handler decoded from the request and either returns
// a result or throws ServiceError (see errors.ts). Nothing here knows about HTTP.
import { evaluate } from "../evaluation/index.js";
import type { AuditAction, AuditLog, EvaluationResult, Flag, Results, VariantResult } from "../model/index.js";
import { ExistsError } from "../repository/index.js";
import type { AuditEntry, Page, Repository } from "../repository/index.js";
import { erfc } from "./erfc.js";
import { notFound, ServiceError, validationError } from "./errors.js";
import { parseEvaluateRequest, parseEvents, parseFlagInput } from "./parse.js";

/** The fewest exposures per variant for which a p-value is reported (BR-42). */
const MIN_SAMPLE_FOR_SIGNIFICANCE = 30;

/** UTC ISO 8601 with millisecond precision, e.g. 2026-01-31T08:00:00.123Z. */
export type Clock = () => string;
const systemClock: Clock = () => new Date().toISOString();

export class Service {
  constructor(
    private readonly repo: Repository,
    private readonly now: Clock = systemClock,
  ) {}

  // ---------------------------------------------------------------- flags

  /** Validates `raw` and stores a new flag together with its audit entry (BR-01, BR-02, BR-07, BR-08). */
  createFlag(raw: unknown): Flag {
    const draft = parseFlagInput(raw);
    const at = this.now();
    const flag: Flag = { ...draft, createdAt: at, updatedAt: at };
    try {
      this.repo.tx((tx) => {
        tx.insertFlag(flag);
        tx.appendAudit(auditEntry("create", flag.key, null, flag, at));
      });
    } catch (e) {
      if (e instanceof ExistsError) throw new ServiceError("FLAG_EXISTS", `flag ${JSON.stringify(flag.key)} already exists`);
      throw e;
    }
    return flag;
  }

  /** @throws ServiceError FLAG_NOT_FOUND (BR-05) */
  getFlag(key: string): Flag {
    const flag = this.repo.getFlag(key);
    if (flag === null) throw notFound(key);
    return flag;
  }

  listFlags(limit: number, offset: number): Page<Flag> {
    return this.repo.listFlags(limit, offset);
  }

  /** Replaces the flag at `key`; fields the body leaves out go back to their defaults (BR-03, BR-05, BR-09). */
  updateFlag(key: string, raw: unknown): Flag {
    const draft = parseFlagInput(raw);
    if (draft.key !== key) {
      throw new ServiceError("KEY_IMMUTABLE", `key cannot be changed from ${JSON.stringify(key)} to ${JSON.stringify(draft.key)}`);
    }
    const at = this.now();
    return this.repo.tx((tx) => {
      const old = tx.getFlag(key);
      if (old === null) throw notFound(key);
      // ISO strings of one format sort like the instants they denote: never let updatedAt go backwards.
      const updatedAt = at < old.updatedAt ? old.updatedAt : at;
      const flag: Flag = { ...draft, createdAt: old.createdAt, updatedAt };
      tx.updateFlag(flag);
      tx.appendAudit(auditEntry("update", key, old, flag, at));
      return flag;
    });
  }

  /** Removes a flag and records it in the audit log (BR-06). */
  deleteFlag(key: string): void {
    const at = this.now();
    this.repo.tx((tx) => {
      const old = tx.getFlag(key);
      if (old === null) throw notFound(key);
      tx.deleteFlag(key);
      tx.appendAudit(auditEntry("delete", key, old, null, at));
    });
  }

  listAudit(flagKey: string | undefined, limit: number, offset: number): Page<AuditLog> {
    return this.repo.listAudit(flagKey, limit, offset);
  }

  // ------------------------------------------------------------- evaluate

  /**
   * Evaluates flags for the context in `raw`. It writes nothing (BR-22). The result is a Map, not
   * an object: its keys include names the client chose, and assigning `obj["__proto__"] = ...` on
   * an object would replace its prototype instead of adding an entry.
   */
  evaluate(raw: unknown): Map<string, EvaluationResult> {
    const req = parseEvaluateRequest(raw);
    const results = new Map<string, EvaluationResult>();
    if (req.flags === null) {
      for (const flag of this.repo.listAllFlags()) results.set(flag.key, evaluate(flag, req.context));
    } else {
      for (const key of req.flags) results.set(key, evaluate(this.repo.getFlag(key), req.context)); // unknown key: FLAG_NOT_FOUND (BR-21)
    }
    return results;
  }

  // --------------------------------------------------------------- events

  /** Validates and stores a batch of events; returns how many it contained (BR-43, BR-44). */
  recordEvents(raw: unknown): number {
    const events = parseEvents(raw);
    this.repo.recordEvents(events);
    return events.length;
  }

  /** The experiment report of a flag for a goal (BR-42, BR-46). */
  results(flagKey: string, goal: string): Results {
    if (goal === "") throw validationError("goal is required"); // before the existence check (BR-51)
    const flag = this.getFlag(flagKey);
    const { exposures, conversions } = this.repo.variantCounts(flagKey, goal);

    const rows: VariantResult[] = flag.variants.map((v) => {
      const exposed = exposures.get(v.key) ?? 0;
      const converted = conversions.get(v.key) ?? 0;
      return { variant: v.key, exposures: exposed, conversions: converted, rate: exposed > 0 ? converted / exposed : 0, pValue: null, significant: false };
    });
    const control = rows[0];
    if (control !== undefined) {
      // Every other variant is compared with the first one, the control.
      for (const row of rows.slice(1)) {
        row.pValue = twoProportionPValue(control, row);
        row.significant = row.pValue !== null && row.pValue < 0.05;
      }
    }
    return { flagKey, goal, variants: rows };
  }
}

/** A snapshot of the flag as the API returns it, for before/after in the audit log. */
function auditEntry(action: AuditAction, flagKey: string, before: Flag | null, after: Flag | null, createdAt: string): AuditEntry {
  return { flagKey, action, before, after, createdAt };
}

/**
 * The pooled, two-sided two-proportion z-test of BR-42. Null when either group is too small or
 * the standard error is 0 (everybody converted, or nobody did).
 */
function twoProportionPValue(control: VariantResult, treatment: VariantResult): number | null {
  if (control.exposures < MIN_SAMPLE_FOR_SIGNIFICANCE || treatment.exposures < MIN_SAMPLE_FOR_SIGNIFICANCE) return null;
  const n1 = control.exposures;
  const n2 = treatment.exposures;
  const pooled = (control.conversions + treatment.conversions) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const z = (treatment.rate - control.rate) / se;
  return erfc(Math.abs(z) / Math.SQRT2);
}
