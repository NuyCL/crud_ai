// Types shared by every layer. The JSON shape follows spec/openapi.yaml, so a value of
// these types can be sent as it is.

/** The only kinds of value a rule or an attribute may hold. */
export type Scalar = string | number | boolean;

export type Operator = "eq" | "neq" | "in" | "not_in";

/** `value` is a Scalar for eq/neq and a non-empty array of Scalars for in/not_in. */
export interface Rule {
  attribute: string;
  operator: Operator;
  value: Scalar | Scalar[];
}

export interface Variant {
  key: string;
  weight: number;
}

/** Timestamps are UTC ISO 8601 strings with millisecond precision. */
export interface Flag {
  key: string;
  description: string;
  enabled: boolean;
  rules: Rule[];
  rolloutPercent: number;
  variants: Variant[];
  createdAt: string;
  updatedAt: string;
}

/** What a client sends, once validated and with defaults applied; the service adds the timestamps. */
export type FlagDraft = Omit<Flag, "createdAt" | "updatedAt">;

/**
 * Attribute names are ordinary strings. Build the record with `Object.create(null)` so that names
 * such as `constructor` or `__proto__` are plain keys and never reach Object.prototype.
 */
export type Attributes = Readonly<Record<string, Scalar>>;

/** `userId` is not an attribute: rules cannot target it. */
export interface Context {
  userId?: string;
  attributes?: Attributes;
}

export type Reason =
  | "FLAG_NOT_FOUND"
  | "DISABLED"
  | "TARGETING_MISS"
  | "MISSING_USER_ID"
  | "NOT_IN_ROLLOUT"
  | "ON"
  | "VARIANT";

/** `variant` is null unless `reason` is VARIANT. */
export interface EvaluationResult {
  enabled: boolean;
  variant: string | null;
  reason: Reason;
}

export type AuditAction = "create" | "update" | "delete";

/** `before` and `after` are whole flags, or null when there was none. */
export interface AuditLog {
  id: number;
  flagKey: string;
  action: AuditAction;
  before: Flag | null;
  after: Flag | null;
  createdAt: string;
}

export type Event =
  | { type: "exposure"; userId: string; flagKey: string; variant: string }
  | { type: "conversion"; userId: string; goal: string };

export interface VariantResult {
  variant: string;
  exposures: number;
  conversions: number;
  rate: number;
  pValue: number | null;
  significant: boolean;
}

export interface Results {
  flagKey: string;
  goal: string;
  variants: VariantResult[];
}
