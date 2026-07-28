import assert from "node:assert/strict";
import test from "node:test";

import {
  getCapacityTelemetrySnapshot,
  recordSemaphoreQueueEvent,
  recordSemaphoreState,
  recordUpstreamCapacityStatus,
  resetCapacityTelemetry,
} from "../../open-sse/services/capacityTelemetry.ts";

test.afterEach(() => {
  resetCapacityTelemetry();
});

test("capacity telemetry aggregates bounded provider and masked Codex-account capacity signals", () => {
  const semaphoreKey = "codex:raw-connection-id";
  recordSemaphoreState(semaphoreKey, { running: 2, queued: 3 });
  recordSemaphoreQueueEvent(semaphoreKey, "wait", 125);
  recordSemaphoreQueueEvent(semaphoreKey, "rejected");
  recordUpstreamCapacityStatus("codex", "raw-connection-id", 429);
  recordUpstreamCapacityStatus("codex", "raw-connection-id", 502);
  recordUpstreamCapacityStatus("codex", "raw-connection-id", 503);

  const snapshot = getCapacityTelemetrySnapshot({
    connections: [
      {
        id: "raw-connection-id",
        provider: "codex",
        isActive: true,
        maxConcurrent: 4,
        providerSpecificData: { chatgptPlanType: "pro" },
      },
    ],
    semaphoreStatus: {
      [semaphoreKey]: { running: 2, queued: 3, maxConcurrency: 4, blockedUntil: null },
    },
    rateLimitStatus: {
      [semaphoreKey]: { queued: 1, running: 0, executing: 0 },
    },
  });

  const codex = snapshot.providers.codex as {
    configuredConcurrencyLimit: number;
    effectiveConcurrencyLimit: number;
    currentInflight: number;
    queue: { depth: number };
    rolling: Record<
      string,
      {
        peakInflight: number;
        waits: number;
        rejected: number;
        upstreamErrors: Record<string, number>;
      }
    >;
    codexAccounts: Array<{
      account: string;
      planType: string;
      rolling: Record<string, { upstreamErrors: Record<string, number> }>;
    }>;
  };
  assert.equal(codex.configuredConcurrencyLimit, 4);
  assert.equal(codex.effectiveConcurrencyLimit, 4);
  assert.equal(codex.currentInflight, 2);
  assert.equal(codex.queue.depth, 4);
  assert.equal(codex.rolling["1m"].peakInflight, 2);
  assert.equal(codex.rolling["1m"].waits, 1);
  assert.equal(codex.rolling["1m"].rejected, 1);
  assert.deepEqual(codex.rolling["1m"].upstreamErrors, { "429": 1, "502": 1, "503": 1 });
  assert.equal(codex.codexAccounts[0].planType, "pro");
  assert.deepEqual(codex.codexAccounts[0].queue, {
    depth: 4,
    accountSemaphoreDepth: 3,
    rateLimitDepth: 1,
  });
  assert.match(codex.codexAccounts[0].account, /^codex-[a-f0-9]{10}$/);
  assert.doesNotMatch(JSON.stringify(snapshot), /raw-connection-id/);
});

test("capacity telemetry accepts workspace plan metadata and per-connection rate-limit caps", () => {
  const snapshot = getCapacityTelemetrySnapshot({
    connections: [
      {
        id: "workspace-account",
        provider: "codex",
        isActive: true,
        rateLimitOverrides: { maxConcurrent: 7 },
        providerSpecificData: { workspacePlanType: "enterprise" },
      },
    ],
    semaphoreStatus: {},
    rateLimitStatus: {},
  });
  const codex = snapshot.providers.codex as {
    configuredConcurrencyLimit: number | null;
    effectiveConcurrencyLimit: number | null;
    codexAccounts: Array<{
      planType: string;
      configuredConcurrencyLimit: number | null;
      effectiveConcurrencyLimit: number | null;
    }>;
  };
  assert.equal(codex.configuredConcurrencyLimit, 7);
  assert.equal(codex.effectiveConcurrencyLimit, 7);
  assert.deepEqual(codex.codexAccounts[0], {
    ...codex.codexAccounts[0],
    planType: "enterprise",
    configuredConcurrencyLimit: 7,
    effectiveConcurrencyLimit: 7,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /workspace-account/);
});

test("capacity telemetry classifies cooled-down and exhausted accounts without exposing their ids", () => {
  const nowMs = Date.parse("2026-07-28T10:00:00.000Z");
  const snapshot = getCapacityTelemetrySnapshot({
    nowMs,
    connections: [
      {
        id: "cooling-id",
        provider: "codex",
        isActive: true,
        maxConcurrent: 2,
        rateLimitedUntil: "2026-07-28T10:05:00.000Z",
      },
      { id: "exhausted-id", provider: "codex", isActive: true, maxConcurrent: 2 },
    ],
    semaphoreStatus: {},
    rateLimitStatus: {},
    quotaSnapshots: [
      {
        provider: "codex",
        accountId: "exhausted-id",
        status: "exhausted",
        lastResetAt: "tomorrow",
      },
    ],
  });
  const codex = snapshot.providers.codex as {
    accounts: { available: number; coolingDown: number; quotaExhausted: number };
    codexAccounts: Array<{ availability: string }>;
  };
  assert.deepEqual(codex.accounts, {
    configured: 2,
    available: 0,
    coolingDown: 1,
    rateLimited: 1,
    quotaExhausted: 1,
  });
  assert.deepEqual(codex.codexAccounts.map((account) => account.availability).sort(), [
    "cooldown",
    "quota_exhausted",
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /cooling-id|exhausted-id/);
});
