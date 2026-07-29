import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-affinity-priority-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "codex-affinity-priority-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");
const auth = await import("../../src/sse/services/auth.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

async function seedCodexConnection(name: string, priority: number, lastUsedAt: string) {
  return providersDb.createProviderConnection({
    provider: "codex",
    authType: "apikey",
    name,
    apiKey: `${name}`,
    isActive: true,
    testStatus: "active",
    priority,
    lastUsedAt,
    providerSpecificData: {},
  });
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("codex fill-first creates affinity by priority and keeps fallback pins", async () => {
  await settingsDb.updateSettings({
    providerStrategies: { codex: { fallbackStrategy: "fill-first" } },
    codexSessionAffinityTtlMs: 60_000,
  });
  const primary = await seedCodexConnection("codex-affinity-primary", 1, new Date().toISOString());
  const reserve = await seedCodexConnection(
    "codex-affinity-reserve",
    2,
    new Date(Date.now() - 60_000).toISOString()
  );

  const fresh = await auth.getProviderCredentials("codex", null, null, null, {
    sessionKey: "fresh-priority-session",
  });
  assert.equal(fresh.connectionId, primary.id, "new affinity must prefer priority 1 over LRU");

  quotaCache.setQuotaCache(primary.id, "codex", {
    session: {
      used: 100,
      total: 100,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const fallbackSelection = await auth.getProviderCredentials("codex", null, null, null, {
    sessionKey: "fallback-session",
  });
  assert.equal(fallbackSelection.connectionId, reserve.id, "exhausted primary must use reserve");
  assert.equal(
    affinityDb.getSessionAccountAffinity("fallback-session", "codex", 60_000)?.connectionId,
    reserve.id,
    "fallback selection must persist its new affinity"
  );

  affinityDb.upsertSessionAccountAffinity(
    "existing-reserve-session",
    "codex",
    reserve.id,
    Date.now(),
    60_000
  );
  quotaCache.setQuotaCache(primary.id, "codex", {
    session: {
      used: 0,
      total: 100,
      remaining: 100,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const existing = await auth.getProviderCredentials("codex", null, null, null, {
    sessionKey: "existing-reserve-session",
  });
  assert.equal(existing.connectionId, reserve.id, "existing affinity must not move to primary");
});
