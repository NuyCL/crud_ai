import type { Context, EvaluateRequest, EvaluationResult, FlagEvent, RecordEventsRequest, Scalar } from "./types.js";

/** The part of `localStorage` the SDK uses; any object with these three methods will do. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FlagClientOptions {
  /** Where the service listens, e.g. "https://flags.example.com". */
  baseUrl: string;
  /** The CLIENT key. Whatever is in a browser is public: never put the admin key here. */
  clientKey: string;
  /** Who the flags are evaluated for. Without an `id`, flags that need one (rollouts, variants) stay off. */
  user?: { id?: string; attributes?: Record<string, Scalar> };
  /** Poll for new values every N ms. Default 30000; 0 turns polling off. */
  pollIntervalMs?: number;
  /** Send queued events at most N ms after the first one was queued. Default 2000. */
  flushIntervalMs?: number;
  /** Give up on a request after N ms. Default 5000. */
  timeoutMs?: number;
  /** Replaces the global `fetch` (tests, or a polyfill). */
  fetch?: typeof fetch;
  /** Where the last answer is kept between page loads. Default `localStorage`; `null` keeps nothing. */
  storage?: StorageLike | null;
}

const MAX_BATCH = 100; // events per POST /v1/events (OpenAPI maxItems)
const MAX_QUEUE = 1000; // events kept while the service cannot be reached; older ones are dropped

type Results = Map<string, EvaluationResult>;

function isScalar(v: unknown): v is Scalar {
  return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/** The results of an answer, or null if it does not look like one. Entries that do not fit the schema are skipped. */
function parseResults(body: unknown): Results | null {
  const raw = (body as { results?: unknown } | null)?.results;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Results = new Map();
  for (const [key, entry] of Object.entries(raw)) {
    const r = entry as Partial<EvaluationResult> | null;
    if (r && typeof r.enabled === "boolean" && (r.variant === null || typeof r.variant === "string") && typeof r.reason === "string") {
      out.set(key, { enabled: r.enabled, variant: r.variant, reason: r.reason });
    }
  }
  return out;
}

export class FlagClient {
  readonly #baseUrl: string;
  readonly #clientKey: string;
  readonly #userId: string | undefined;
  readonly #context: Context;
  readonly #pollMs: number;
  readonly #flushMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #storage: StorageLike | null;
  readonly #cacheKey: string;
  readonly #listeners = new Set<() => void>();
  readonly #exposed = new Set<string>();
  readonly #ready: Promise<void>;
  #results: Results = new Map();
  #queue: FlagEvent[] = [];
  #flushing: Promise<void> | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  /** Throws only for a configuration that cannot work (no baseUrl or no clientKey). Everything else is handled. */
  constructor(options: FlagClientOptions) {
    if (typeof options?.baseUrl !== "string" || options.baseUrl === "") throw new TypeError("FlagClient: baseUrl is required");
    if (typeof options.clientKey !== "string" || options.clientKey === "") throw new TypeError("FlagClient: clientKey is required");
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#clientKey = options.clientKey;
    const id = options.user?.id;
    this.#userId = typeof id === "string" && id !== "" ? id : undefined;
    const attributes = Object.fromEntries(Object.entries(options.user?.attributes ?? {}).filter(([, v]) => isScalar(v)));
    this.#context = { ...(this.#userId === undefined ? {} : { userId: this.#userId }), ...(Object.keys(attributes).length > 0 ? { attributes } : {}) };
    this.#pollMs = options.pollIntervalMs ?? 30_000;
    this.#flushMs = options.flushIntervalMs ?? 2000;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.#storage = options.storage === undefined ? FlagClient.#defaultStorage() : options.storage;
    this.#cacheKey = `ffsdk:v1:${this.#baseUrl}|${this.#userId ?? ""}|${JSON.stringify(this.#context.attributes ?? {})}`;
    this.#results = this.#readCache() ?? new Map();
    this.#ready = this.#refresh().then(() => this.#schedulePoll());
  }

  /** Resolves once the first answer is in, or once it is clear there will be none (then the cache or the defaults serve). Never rejects. */
  ready(): Promise<void> {
    return this.#ready;
  }

  /** Whether the flag is on for this user; `fallback` when its value is not known. Never throws. */
  isEnabled(key: string, fallback = false): boolean {
    try {
      return this.#results.get(key)?.enabled ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** The variant this user is in; `fallback` when the flag has none or is not known. The first read of a flag's variant is reported as an exposure. Never throws. */
  getVariant(key: string, fallback: string): string {
    try {
      const variant = this.#results.get(key)?.variant;
      if (typeof variant !== "string") return fallback;
      this.#expose(key, variant);
      return variant;
    } catch {
      return fallback;
    }
  }

  /** Records a conversion for this user. Does nothing without a user id. Never throws. */
  track(goal: string): void {
    try {
      if (this.#userId !== undefined && typeof goal === "string" && goal !== "") {
        this.#enqueue({ type: "conversion", userId: this.#userId, goal, timestamp: new Date().toISOString() });
      }
    } catch {
      // a broken page must not come from analytics
    }
  }

  /** Calls `listener` after a poll brought different values. Returns the function that removes it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Sends what is queued now. Resolves when it is sent or has failed; never rejects. */
  flush(): Promise<void> {
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    this.#flushing ??= this.#sendAll().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  /** Stops polling, drops listeners and sends what is queued (without waiting for it). Safe to call twice. */
  close(): void {
    this.#closed = true;
    clearTimeout(this.#pollTimer);
    this.#listeners.clear();
    void this.flush();
  }

  // ---------------------------------------------------------------- loading

  async #refresh(): Promise<void> {
    const body: EvaluateRequest = { context: this.#context };
    const answer = await this.#post("/v1/evaluate", body);
    const results = answer?.status === 200 ? parseResults(answer.body) : null;
    if (results === null || this.#closed) return;
    const changed = JSON.stringify([...results]) !== JSON.stringify([...this.#results]);
    this.#results = results;
    if (changed) {
      this.#writeCache();
      for (const listener of [...this.#listeners]) {
        try {
          listener();
        } catch {
          // one listener's bug must not stop the others
        }
      }
    }
  }

  #schedulePoll(): void {
    if (this.#closed || !(this.#pollMs > 0)) return;
    this.#pollTimer = setTimeout(() => {
      void this.#refresh().then(() => this.#schedulePoll());
    }, this.#pollMs);
    unref(this.#pollTimer);
  }

  // ----------------------------------------------------------------- events

  #expose(flagKey: string, variant: string): void {
    if (this.#userId === undefined || this.#exposed.has(flagKey)) return;
    this.#exposed.add(flagKey);
    this.#enqueue({ type: "exposure", userId: this.#userId, flagKey, variant, timestamp: new Date().toISOString() });
  }

  #enqueue(event: FlagEvent): void {
    this.#queue.push(event);
    this.#trim();
    if (this.#queue.length >= MAX_BATCH) {
      void this.flush();
    } else if (this.#flushTimer === undefined && !this.#closed) {
      this.#flushTimer = setTimeout(() => void this.flush(), this.#flushMs);
      unref(this.#flushTimer);
    }
  }

  /** Past MAX_QUEUE the oldest events go: what happened last is the more useful to keep. */
  #trim(): void {
    if (this.#queue.length > MAX_QUEUE) this.#queue.splice(0, this.#queue.length - MAX_QUEUE);
  }

  async #sendAll(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, MAX_BATCH);
      const body: RecordEventsRequest = { events: batch };
      const answer = await this.#post("/v1/events", body);
      const status = answer?.status ?? 0;
      // 202: sent. 4xx: the service will never take this batch, so keep nothing. No answer or 5xx: try again later.
      if (status >= 400 && status < 500) continue;
      if (status !== 202) {
        this.#queue.unshift(...batch);
        this.#trim();
        if (!this.#closed) {
          this.#flushTimer = setTimeout(() => void this.flush(), this.#flushMs);
          unref(this.#flushTimer);
        }
        return;
      }
    }
  }

  // ---------------------------------------------------------------- network

  /** POST JSON; `null` when there is no answer at all (network, timeout). Never throws. */
  async #post(path: string, payload: unknown): Promise<{ status: number; body: unknown } | null> {
    const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
    const timer = setTimeout(() => controller?.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#baseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Client-Key": this.#clientKey },
        body: JSON.stringify(payload),
        ...(controller ? { signal: controller.signal } : {}),
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // an answer that is not JSON still has a status
      }
      return { status: response.status, body };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ cache

  static #defaultStorage(): StorageLike | null {
    try {
      return globalThis.localStorage ?? null; // reading it can throw (blocked cookies, sandboxed iframe)
    } catch {
      return null;
    }
  }

  #readCache(): Results | null {
    try {
      const text = this.#storage?.getItem(this.#cacheKey);
      return text ? parseResults(JSON.parse(text)) : null;
    } catch {
      return null;
    }
  }

  #writeCache(): void {
    try {
      this.#storage?.setItem(this.#cacheKey, JSON.stringify({ results: Object.fromEntries(this.#results) }));
    } catch {
      // storage full or blocked: the in-memory copy still works
    }
  }
}

/** A pending timer must not keep a Node process alive (a browser's timers have no `unref`). */
function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}
