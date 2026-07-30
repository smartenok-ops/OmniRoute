import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-affinity-rebind-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "codex-affinity-rebind-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const auth = await import("../../src/sse/services/auth.ts");
const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedCodexConnection(name: string, priority: number) {
  return providersDb.createProviderConnection({
    provider: "codex",
    authType: "apikey",
    name,
    apiKey: `${Math.random().toString(16).slice(2, 10)}`,
    isActive: true,
    testStatus: "active",
    priority,
    providerSpecificData: {},
  });
}

test.beforeEach(resetStorage);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("codex affinity rebinds to an eligible account when a quota retry excludes its pin", async () => {
  await settingsDb.updateSettings({
    fallbackStrategy: "least-used",
    codexSessionAffinityTtlMs: 60_000,
  });
  const first = await seedCodexConnection("codex-ws-affinity-first", 1);
  const second = await seedCodexConnection("codex-ws-affinity-second", 2);
  const sessionKey = "metadata:cockpit-turn-7";

  const initial = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    [first.id, second.id],
    "gpt-5.5",
    { sessionKey }
  );
  assert.equal(initial.connectionId, first.id);
  const sticky = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    [first.id, second.id],
    "gpt-5.5",
    { sessionKey }
  );
  assert.equal(sticky.connectionId, first.id, "ordinary multi-turn selection remains sticky");

  const retry = await auth.getProviderCredentialsWithQuotaPreflight(
    "codex",
    null,
    [first.id, second.id],
    "gpt-5.5",
    { sessionKey, excludeConnectionIds: [first.id] }
  );
  assert.equal(retry.connectionId, second.id, "retry exclusion must override the old affinity pin");
  assert.equal(
    affinityDb.getSessionAccountAffinity(sessionKey, "codex", 60_000)?.connectionId,
    second.id,
    "the replacement account becomes the session affinity target"
  );
});
