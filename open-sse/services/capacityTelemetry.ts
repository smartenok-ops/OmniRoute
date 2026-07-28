/**
 * Bounded in-memory capacity telemetry for the status endpoint.
 *
 * The hot path only updates a minute bucket and never writes to the database.
 * Provider entries are capped at 128 and Codex account entries at 64; entries
 * older than 24 hours are discarded. Account keys remain process-local and are
 * represented in snapshots with a per-process HMAC label.
 */

import { createHmac, randomBytes } from "node:crypto";

const RETENTION_MINUTES = 24 * 60;
const MAX_PROVIDERS = 128;
const MAX_CODEX_ACCOUNTS = 64;
const MASK_KEY = randomBytes(32);
const CODEX_PLAN_TYPES = new Set(["free", "plus", "pro", "team", "business", "enterprise", "edu"]);

type Bucket = {
  inflightPeak: number;
  queuePeak: number;
  waits: number;
  waitMs: number;
  rejected: number;
  upstream429: number;
  upstream502: number;
  upstream503: number;
};

type Entry = {
  buckets: Map<number, Bucket>;
  lastSeenAt: number;
};

type ActiveAttempt = {
  provider: string;
  accountKey: string | null;
  stream: boolean;
};

export type SemaphoreStatus = Record<
  string,
  { running: number; queued: number; maxConcurrency: number; blockedUntil: string | null }
>;
export type RateLimitStatus = Record<
  string,
  { queued?: number; running?: number; executing?: number }
>;

export type CapacityConnection = {
  id?: unknown;
  provider?: unknown;
  isActive?: unknown;
  rateLimitedUntil?: unknown;
  maxConcurrent?: unknown;
  rateLimitOverrides?: unknown;
  providerSpecificData?: unknown;
};

export type CapacityQuotaSnapshot = {
  provider?: unknown;
  accountId?: unknown;
  status?: unknown;
  lastQuotaPercent?: unknown;
  lastResetAt?: unknown;
};

const providerEntries = new Map<string, Entry>();
const codexAccountEntries = new Map<string, Entry>();
const activeAttempts = new Map<symbol, ActiveAttempt>();

function minute(nowMs = Date.now()): number {
  return Math.floor(nowMs / 60_000);
}

function splitSemaphoreKey(key: string): { provider: string; accountKey: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  return { provider: key.slice(0, separator), accountKey: key.slice(separator + 1) };
}

function evictOldBuckets(entry: Entry, nowMinute: number): void {
  const oldestMinute = nowMinute - RETENTION_MINUTES + 1;
  for (const bucketMinute of entry.buckets.keys()) {
    if (bucketMinute < oldestMinute) entry.buckets.delete(bucketMinute);
  }
}

function evictOldest(entries: Map<string, Entry>, maxEntries: number): void {
  if (entries.size < maxEntries) return;
  let oldestKey: string | null = null;
  let oldestSeenAt = Infinity;
  for (const [key, entry] of entries) {
    if (entry.lastSeenAt < oldestSeenAt) {
      oldestKey = key;
      oldestSeenAt = entry.lastSeenAt;
    }
  }
  if (oldestKey) entries.delete(oldestKey);
}

function entryFor(
  entries: Map<string, Entry>,
  key: string,
  maxEntries: number,
  nowMs: number
): Entry {
  let entry = entries.get(key);
  if (!entry) {
    evictOldest(entries, maxEntries);
    entry = { buckets: new Map(), lastSeenAt: nowMs };
    entries.set(key, entry);
  }
  entry.lastSeenAt = nowMs;
  evictOldBuckets(entry, minute(nowMs));
  return entry;
}

function bucketFor(entry: Entry, nowMs: number): Bucket {
  const bucketMinute = minute(nowMs);
  let bucket = entry.buckets.get(bucketMinute);
  if (!bucket) {
    bucket = {
      inflightPeak: 0,
      queuePeak: 0,
      waits: 0,
      waitMs: 0,
      rejected: 0,
      upstream429: 0,
      upstream502: 0,
      upstream503: 0,
    };
    entry.buckets.set(bucketMinute, bucket);
  }
  return bucket;
}

function forTelemetryEntries(
  provider: string,
  accountKey: string | null,
  nowMs: number,
  callback: (bucket: Bucket) => void
): void {
  callback(bucketFor(entryFor(providerEntries, provider, MAX_PROVIDERS, nowMs), nowMs));
  if (provider === "codex" && accountKey) {
    callback(
      bucketFor(entryFor(codexAccountEntries, accountKey, MAX_CODEX_ACCOUNTS, nowMs), nowMs)
    );
  }
}

/** Record a semaphore state transition. */
export function recordSemaphoreState(
  semaphoreKey: string,
  state: { running: number; queued: number }
): void {
  const parts = splitSemaphoreKey(semaphoreKey);
  if (!parts) return;
  const nowMs = Date.now();
  forTelemetryEntries(parts.provider, parts.accountKey, nowMs, (bucket) => {
    bucket.inflightPeak = Math.max(bucket.inflightPeak, Math.max(0, state.running));
    bucket.queuePeak = Math.max(bucket.queuePeak, Math.max(0, state.queued));
  });
}

/** Record a completed wait or a capacity rejection. */
export function recordSemaphoreQueueEvent(
  semaphoreKey: string,
  event: "wait" | "rejected",
  waitMs = 0
): void {
  const parts = splitSemaphoreKey(semaphoreKey);
  if (!parts) return;
  const nowMs = Date.now();
  forTelemetryEntries(parts.provider, parts.accountKey, nowMs, (bucket) => {
    if (event === "wait") {
      bucket.waits += 1;
      bucket.waitMs += Math.max(0, Math.round(waitMs));
    } else {
      bucket.rejected += 1;
    }
  });
}

/** Counts upstream attempt responses relevant to capacity planning. */
export function recordUpstreamCapacityStatus(
  provider: string,
  accountKey: string | null | undefined,
  status: number
): void {
  if (status !== 429 && status !== 502 && status !== 503) return;
  const nowMs = Date.now();
  forTelemetryEntries(provider, accountKey ?? null, nowMs, (bucket) => {
    if (status === 429) bucket.upstream429 += 1;
    if (status === 502) bucket.upstream502 += 1;
    if (status === 503) bucket.upstream503 += 1;
  });
}

/**
 * Track an in-flight upstream operation without retaining request, model, or
 * credential data. The returned finalizer is idempotent so stream cancellation
 * and normal completion can safely race.
 */
export function beginUpstreamCapacityAttempt({
  provider,
  accountKey,
  stream,
}: {
  provider: string;
  accountKey?: string | null;
  stream: boolean;
}): (status?: number) => void {
  const token = Symbol("capacity-attempt");
  activeAttempts.set(token, { provider, accountKey: accountKey ?? null, stream });
  let finished = false;
  return (status?: number) => {
    if (finished) return;
    finished = true;
    activeAttempts.delete(token);
    if (typeof status === "number") recordUpstreamCapacityStatus(provider, accountKey, status);
  };
}

/** Snapshot only active attempt totals; no request metadata is retained. */
export function getActiveUpstreamCapacityCounts(): {
  activeUpstreamAttempts: number;
  activeUpstreamStreams: number;
} {
  let activeUpstreamStreams = 0;
  for (const attempt of activeAttempts.values()) {
    if (attempt.stream) activeUpstreamStreams += 1;
  }
  return { activeUpstreamAttempts: activeAttempts.size, activeUpstreamStreams };
}

function maskAccount(accountKey: string): string {
  return `codex-${createHmac("sha256", MASK_KEY).update(accountKey).digest("hex").slice(0, 10)}`;
}

function parseDateMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function finitePositive(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function planType(value: unknown): string {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const candidate =
    record?.chatgptPlanType ??
    record?.workspacePlanType ??
    record?.chatgpt_plan_type ??
    record?.workspace_plan_type;
  if (typeof candidate !== "string") return "unknown";
  const normalized = candidate.trim().toLowerCase();
  return CODEX_PLAN_TYPES.has(normalized) ? normalized : "unknown";
}

function configuredConcurrencyLimit(connection: CapacityConnection): number | null {
  const direct = finitePositive(connection.maxConcurrent);
  if (direct !== null) return direct;
  const overrides =
    connection.rateLimitOverrides && typeof connection.rateLimitOverrides === "object"
      ? (connection.rateLimitOverrides as Record<string, unknown>)
      : null;
  return finitePositive(overrides?.maxConcurrent);
}

function rateLimitQueueDepthForAccount(
  provider: string,
  accountKey: string,
  rateLimitStatus: RateLimitStatus
): number {
  const prefix = `${provider}:${accountKey}`;
  return Object.entries(rateLimitStatus).reduce((total, [key, value]) => {
    // Codex scopes, and Gemini/GitHub model scopes, append a suffix after the
    // connection id. Do not parse that suffix: connection IDs themselves may
    // contain punctuation.
    if (key !== prefix && !key.startsWith(`${prefix}:`)) return total;
    return total + (value.queued ?? 0);
  }, 0);
}

function aggregateBuckets(entry: Entry | undefined, nowMs: number) {
  const windows = { "1m": 1, "5m": 5, "1h": 60, "24h": RETENTION_MINUTES } as const;
  const currentMinute = minute(nowMs);
  const result = Object.fromEntries(
    Object.keys(windows).map((window) => [
      window,
      {
        peakInflight: 0,
        peakQueueDepth: 0,
        waits: 0,
        waitMs: 0,
        rejected: 0,
        upstreamErrors: { "429": 0, "502": 0, "503": 0 },
      },
    ])
  ) as Record<
    string,
    {
      peakInflight: number;
      peakQueueDepth: number;
      waits: number;
      waitMs: number;
      rejected: number;
      upstreamErrors: { "429": number; "502": number; "503": number };
    }
  >;
  if (!entry) return result;
  evictOldBuckets(entry, currentMinute);
  for (const [bucketMinute, bucket] of entry.buckets) {
    for (const [window, minutes] of Object.entries(windows)) {
      if (bucketMinute <= currentMinute - minutes) continue;
      const target = result[window];
      target.peakInflight = Math.max(target.peakInflight, bucket.inflightPeak);
      target.peakQueueDepth = Math.max(target.peakQueueDepth, bucket.queuePeak);
      target.waits += bucket.waits;
      target.waitMs += bucket.waitMs;
      target.rejected += bucket.rejected;
      target.upstreamErrors["429"] += bucket.upstream429;
      target.upstreamErrors["502"] += bucket.upstream502;
      target.upstreamErrors["503"] += bucket.upstream503;
    }
  }
  return result;
}

function currentForProvider(
  provider: string,
  semaphoreStatus: SemaphoreStatus,
  rateLimitStatus: RateLimitStatus
) {
  let inflight = 0;
  let queueDepth = 0;
  let rateLimitQueueDepth = 0;
  const byAccount = new Map<
    string,
    { running: number; queued: number; maxConcurrency: number; blockedUntil: string | null }
  >();
  for (const [key, value] of Object.entries(semaphoreStatus)) {
    const parts = splitSemaphoreKey(key);
    if (!parts || parts.provider !== provider) continue;
    inflight += value.running;
    queueDepth += value.queued;
    byAccount.set(parts.accountKey, value);
  }
  for (const [key, value] of Object.entries(rateLimitStatus)) {
    const parts = splitSemaphoreKey(key);
    if (!parts || parts.provider !== provider) continue;
    rateLimitQueueDepth += value.queued ?? 0;
  }
  return { inflight, queueDepth, rateLimitQueueDepth, byAccount };
}

type ProviderCurrent = ReturnType<typeof currentForProvider>;

function sumLimits(limits: Array<number | null>): number | null {
  const configured = limits.filter((limit): limit is number => limit !== null);
  return configured.length > 0 ? configured.reduce((sum, limit) => sum + limit, 0) : null;
}

function effectiveLimit(connection: CapacityConnection, current: ProviderCurrent): number | null {
  const accountKey = typeof connection.id === "string" ? connection.id : null;
  const semaphore = accountKey ? current.byAccount.get(accountKey) : undefined;
  return typeof semaphore?.maxConcurrency === "number" && semaphore.maxConcurrency > 0
    ? semaphore.maxConcurrency
    : configuredConcurrencyLimit(connection);
}

function availabilityForConnection(
  connection: CapacityConnection,
  semaphore: SemaphoreStatus[string] | undefined,
  quota: CapacityQuotaSnapshot | undefined,
  nowMs: number
) {
  const cooldownUntilMs = parseDateMs(connection.rateLimitedUntil);
  const blockedUntilMs = parseDateMs(semaphore?.blockedUntil);
  const exhausted = quota?.status === "exhausted";
  const cooling = (cooldownUntilMs ?? 0) > nowMs || (blockedUntilMs ?? 0) > nowMs;
  const inactive = connection.isActive === false;
  const availability = inactive
    ? "inactive"
    : exhausted
      ? "quota_exhausted"
      : cooling
        ? "cooldown"
        : "available";
  const cooldownUntil = cooling
    ? new Date(Math.max(cooldownUntilMs ?? 0, blockedUntilMs ?? 0)).toISOString()
    : null;
  return { cooling, exhausted, inactive, availability, cooldownUntil };
}

function codexAccountSnapshot({
  connection,
  accountKey,
  semaphore,
  quota,
  current,
  rateLimitStatus,
  nowMs,
}: {
  connection: CapacityConnection;
  accountKey: string;
  semaphore: SemaphoreStatus[string] | undefined;
  quota: CapacityQuotaSnapshot | undefined;
  current: ProviderCurrent;
  rateLimitStatus: RateLimitStatus;
  nowMs: number;
}) {
  const rateLimitDepth = rateLimitQueueDepthForAccount("codex", accountKey, rateLimitStatus);
  const state = availabilityForConnection(connection, semaphore, quota, nowMs);
  return {
    account: maskAccount(accountKey),
    planType: planType(connection.providerSpecificData),
    configuredConcurrencyLimit: configuredConcurrencyLimit(connection),
    effectiveConcurrencyLimit: effectiveLimit(connection, current),
    currentInflight: semaphore?.running ?? 0,
    queue: {
      depth: (semaphore?.queued ?? 0) + rateLimitDepth,
      accountSemaphoreDepth: semaphore?.queued ?? 0,
      rateLimitDepth,
    },
    rolling: aggregateBuckets(codexAccountEntries.get(accountKey), nowMs),
    availability: state.availability,
    cooldownUntil: state.cooldownUntil,
    quota: quota
      ? {
          status: typeof quota.status === "string" ? quota.status : "unknown",
          usagePercent:
            typeof quota.lastQuotaPercent === "number" && Number.isFinite(quota.lastQuotaPercent)
              ? quota.lastQuotaPercent
              : null,
          resetAt: typeof quota.lastResetAt === "string" ? quota.lastResetAt : null,
        }
      : null,
  };
}

function quotaSnapshotsByAccount(quotaSnapshots: CapacityQuotaSnapshot[]) {
  const quotaByAccount = new Map<string, CapacityQuotaSnapshot>();
  for (const snapshot of quotaSnapshots) {
    if (snapshot.provider === "codex" && typeof snapshot.accountId === "string") {
      quotaByAccount.set(snapshot.accountId, snapshot);
    }
  }
  return quotaByAccount;
}

function providerNames({
  connections,
  semaphoreStatus,
  rateLimitStatus,
}: {
  connections: CapacityConnection[];
  semaphoreStatus: SemaphoreStatus;
  rateLimitStatus: RateLimitStatus;
}) {
  const providers = new Set<string>();
  for (const connection of connections) {
    if (typeof connection.provider === "string" && connection.provider)
      providers.add(connection.provider);
  }
  for (const status of [semaphoreStatus, rateLimitStatus]) {
    for (const key of Object.keys(status)) {
      const parts = splitSemaphoreKey(key);
      if (parts) providers.add(parts.provider);
    }
  }
  return [...providers].sort().slice(0, MAX_PROVIDERS);
}

function accountState(
  connection: CapacityConnection,
  current: ProviderCurrent,
  quotaByAccount: Map<string, CapacityQuotaSnapshot>,
  nowMs: number
) {
  const accountKey = typeof connection.id === "string" ? connection.id : null;
  const semaphore = accountKey ? current.byAccount.get(accountKey) : undefined;
  const quota = accountKey ? quotaByAccount.get(accountKey) : undefined;
  const state = availabilityForConnection(connection, semaphore, quota, nowMs);
  return { accountKey, semaphore, quota, state };
}

function providerAccountSummary({
  provider,
  providerConnections,
  current,
  quotaByAccount,
  rateLimitStatus,
  nowMs,
}: {
  provider: string;
  providerConnections: CapacityConnection[];
  current: ProviderCurrent;
  quotaByAccount: Map<string, CapacityQuotaSnapshot>;
  rateLimitStatus: RateLimitStatus;
  nowMs: number;
}) {
  const codexAccounts: unknown[] = [];
  let available = 0;
  let coolingDown = 0;
  let quotaExhausted = 0;
  for (const connection of providerConnections) {
    const account = accountState(connection, current, quotaByAccount, nowMs);
    const { accountKey, semaphore, quota, state } = account;
    if (state.cooling) coolingDown += 1;
    if (state.exhausted) quotaExhausted += 1;
    if (!state.inactive && !state.cooling && !state.exhausted) available += 1;
    if (provider === "codex" && accountKey) {
      codexAccounts.push(
        codexAccountSnapshot({
          connection,
          accountKey,
          semaphore,
          quota,
          current,
          rateLimitStatus,
          nowMs,
        })
      );
    }
  }
  return { available, coolingDown, quotaExhausted, codexAccounts };
}

function providerSnapshot({
  provider,
  connections,
  semaphoreStatus,
  rateLimitStatus,
  quotaByAccount,
  nowMs,
}: {
  provider: string;
  connections: CapacityConnection[];
  semaphoreStatus: SemaphoreStatus;
  rateLimitStatus: RateLimitStatus;
  quotaByAccount: Map<string, CapacityQuotaSnapshot>;
  nowMs: number;
}) {
  const providerConnections = connections.filter((connection) => connection.provider === provider);
  const current = currentForProvider(provider, semaphoreStatus, rateLimitStatus);
  const activeConnections = providerConnections.filter(
    (connection) => connection.isActive !== false
  );
  const accountSummary = providerAccountSummary({
    provider,
    providerConnections,
    current,
    quotaByAccount,
    rateLimitStatus,
    nowMs,
  });
  const snapshot: Record<string, unknown> = {
    configuredConcurrencyLimit: sumLimits(activeConnections.map(configuredConcurrencyLimit)),
    effectiveConcurrencyLimit: sumLimits(
      activeConnections.map((connection) => effectiveLimit(connection, current))
    ),
    currentInflight: current.inflight,
    rolling: aggregateBuckets(providerEntries.get(provider), nowMs),
    queue: {
      depth: current.queueDepth + current.rateLimitQueueDepth,
      accountSemaphoreDepth: current.queueDepth,
      rateLimitDepth: current.rateLimitQueueDepth,
    },
    accounts: {
      configured: providerConnections.length,
      available: accountSummary.available,
      coolingDown: accountSummary.coolingDown,
      rateLimited: accountSummary.coolingDown,
      quotaExhausted: accountSummary.quotaExhausted,
    },
  };
  if (provider === "codex") snapshot.codexAccounts = accountSummary.codexAccounts;
  return snapshot;
}

/** Build the safe, low-cardinality capacity portion of the health payload. */
export function getCapacityTelemetrySnapshot({
  connections,
  semaphoreStatus,
  rateLimitStatus,
  quotaSnapshots = [],
  nowMs = Date.now(),
}: {
  connections: CapacityConnection[];
  semaphoreStatus: SemaphoreStatus;
  rateLimitStatus: RateLimitStatus;
  quotaSnapshots?: CapacityQuotaSnapshot[];
  nowMs?: number;
}) {
  const quotaByAccount = quotaSnapshotsByAccount(quotaSnapshots);
  const output: Record<string, unknown> = {};
  for (const provider of providerNames({ connections, semaphoreStatus, rateLimitStatus })) {
    output[provider] = providerSnapshot({
      provider,
      connections,
      semaphoreStatus,
      rateLimitStatus,
      quotaByAccount,
      nowMs,
    });
  }

  return {
    sampling: {
      retention: "24h",
      bucketResolution: "1 minute",
      maxProviders: MAX_PROVIDERS,
      maxCodexAccounts: MAX_CODEX_ACCOUNTS,
      upstreamErrorCount: "upstream attempts with 429, 502, or 503 responses",
    },
    providers: output,
  };
}

/** Test hook; not used by application code. */
export function resetCapacityTelemetry(): void {
  providerEntries.clear();
  codexAccountEntries.clear();
  activeAttempts.clear();
}
