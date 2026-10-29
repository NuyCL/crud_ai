// Types of the requests and responses the SDK uses, written from spec/openapi.yaml (components.schemas and the
// bodies of /v1/evaluate and /v1/events). test/spec.test.mjs checks the enums against the spec file.

/** A value an attribute (or a rule) can hold. */
export type Scalar = string | number | boolean;

/** Why a flag evaluated the way it did. The SDK never branches on it: it only reads `enabled` and `variant`. */
export type Reason =
  | "FLAG_NOT_FOUND"
  | "DISABLED"
  | "TARGETING_MISS"
  | "MISSING_USER_ID"
  | "NOT_IN_ROLLOUT"
  | "ON"
  | "VARIANT";

/** components.schemas.Context */
export interface Context {
  userId?: string;
  attributes?: Record<string, Scalar>;
}

/** POST /v1/evaluate, request body. Omitting `flags` evaluates every flag (BR-23). */
export interface EvaluateRequest {
  flags?: string[];
  context?: Context;
}

/** components.schemas.EvaluationResult */
export interface EvaluationResult {
  enabled: boolean;
  variant: string | null;
  reason: Reason;
}

/** POST /v1/evaluate, 200 response. */
export interface EvaluateResponse {
  results: Record<string, EvaluationResult>;
}

/** components.schemas.Event, exposure form. `timestamp` is RFC 3339 (BR-43). */
export interface ExposureEvent {
  type: "exposure";
  userId: string;
  flagKey: string;
  variant: string;
  timestamp?: string;
}

/** components.schemas.Event, conversion form. */
export interface ConversionEvent {
  type: "conversion";
  userId: string;
  goal: string;
  timestamp?: string;
}

export type FlagEvent = ExposureEvent | ConversionEvent;

/** POST /v1/events, request body: 1 to 100 events. */
export interface RecordEventsRequest {
  events: FlagEvent[];
}

/** POST /v1/events, 202 response. */
export interface RecordEventsResponse {
  accepted: number;
}

/** components.schemas.Error, the body of every 4xx and 5xx answer. */
export interface ErrorResponse {
  error: { code: string; message: string };
}
