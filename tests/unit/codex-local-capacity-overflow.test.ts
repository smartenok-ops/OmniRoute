import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-overflow-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "codex-overflow-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { CodexLocalCapacityOverflow } =
  await import("../../src/sse/handlers/codexLocalCapacityOverflow.ts");

const SESSION = "sub6-cache-session";
const MODEL = "gpt-5.5";
const TTL = 60_000;

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settingsDb.updateSettings({
    fallbackStrategy: "fill-first",
    codexSessionAffinityTtlMs: TTL,
  });
}

async function seedCodexConnection(name: string, priority: number) {
  return providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name,
    accessToken: `at-${name}`,
    isActive: true,
    testStatus: "active",
    priority,
    providerSpecificData: {},
  });
}

test.beforeEach(resetStorage);

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("one local-capacity overflow selects an alternate without changing affinity", async () => {
  const primary = await seedCodexConnection("codex-primary", 1);
  const alternate = await seedCodexConnection("codex-alternate", 2);

  const initial = await auth.getProviderCredentials("codex", null, null, MODEL, {
    sessionKey: SESSION,
  });
  assert.equal(initial?.connectionId, primary.id);

  const affinityBefore = affinityDb.getSessionAccountAffinity(SESSION, "codex", TTL);
  assert.equal(affinityBefore?.connectionId, primary.id);

  const forcedOverflow = await auth.getProviderCredentials("codex", null, null, MODEL, {
    sessionKey: SESSION,
    forcedConnectionId: alternate.id,
    excludeConnectionIds: [primary.id],
    preserveSessionAffinity: true,
  });
  assert.equal(
    forcedOverflow?.connectionId,
    alternate.id,
    "preserve mode must bypass the normal affinity override even when a target was preselected"
  );
  assert.deepEqual(
    affinityDb.getSessionAccountAffinity(SESSION, "codex", TTL),
    affinityBefore,
    "preselected overflow must not touch the primary affinity row"
  );

  const overflow = await auth.getProviderCredentials("codex", null, null, MODEL, {
    sessionKey: SESSION,
    excludeConnectionIds: [primary.id],
    preserveSessionAffinity: true,
  });
  assert.equal(overflow?.connectionId, alternate.id, "overflow must exclude the saturated primary");

  const affinityAfter = affinityDb.getSessionAccountAffinity(SESSION, "codex", TTL);
  assert.deepEqual(
    affinityAfter,
    affinityBefore,
    "overflow selection must not touch, replace, or delete the primary affinity row"
  );

  const nextHealthy = await auth.getProviderCredentials("codex", null, null, MODEL, {
    sessionKey: SESSION,
  });
  assert.equal(
    nextHealthy?.connectionId,
    primary.id,
    "the next request must return to the primary"
  );
});

test("overflow decision is Codex-only, typed, unforced, and bounded to one attempt", () => {
  const overflow = new CodexLocalCapacityOverflow();
  const base = {
    provider: "codex",
    errorType: "account_semaphore_capacity",
    errorCode: "SEMAPHORE_QUEUE_FULL",
    hasForcedConnection: false,
  };

  assert.equal(overflow.shouldAttempt(base), true);
  assert.equal(overflow.shouldAttempt({ ...base, errorCode: "SEMAPHORE_TIMEOUT" }), true);
  assert.equal(overflow.shouldAttempt({ ...base, errorCode: "RATE_LIMIT_QUEUE_TIMEOUT" }), true);
  assert.equal(
    overflow.shouldAttempt({ ...base, hasForcedConnection: true }),
    false,
    "forced targets must not overflow"
  );
  overflow.begin("primary");
  assert.equal(
    overflow.shouldAttempt(base),
    false,
    "an alternate failure must not spill to a third account"
  );
  const fresh = new CodexLocalCapacityOverflow();
  assert.equal(
    fresh.shouldAttempt({ ...base, errorType: "rate_limit" }),
    false,
    "an upstream 429 must not overflow"
  );
  assert.equal(
    fresh.shouldAttempt({ ...base, errorCode: undefined }),
    false,
    "an untyped 429-like failure must not overflow"
  );
  assert.equal(
    fresh.shouldAttempt({ ...base, provider: "antigravity" }),
    false,
    "the new bounded overflow policy is Codex-only"
  );
});

test("only the overflow alternate forces chatCore upstream retry off", () => {
  const overflow = new CodexLocalCapacityOverflow();
  assert.equal(overflow.shouldSkipUpstreamRetry(false), false);
  assert.equal(overflow.shouldSkipUpstreamRetry(true), true);
  overflow.begin("primary");
  assert.equal(overflow.shouldSkipUpstreamRetry(false), true);
});

test("no alternate leaves the primary affinity untouched", async () => {
  const primary = await seedCodexConnection("codex-only-primary", 1);
  affinityDb.upsertSessionAccountAffinity(SESSION, "codex", primary.id, Date.now(), TTL);
  const affinityBefore = affinityDb.getSessionAccountAffinity(SESSION, "codex", TTL);

  const overflow = await auth.getProviderCredentials("codex", null, null, MODEL, {
    sessionKey: SESSION,
    excludeConnectionIds: [primary.id],
    preserveSessionAffinity: true,
  });

  assert.equal(overflow, null);
  assert.deepEqual(
    affinityDb.getSessionAccountAffinity(SESSION, "codex", TTL),
    affinityBefore,
    "a failed alternate lookup must not delete or replace the primary pin"
  );
});

test("overflow alternate upstream 429 is returned without a third-account cascade", async () => {
  const primary = await seedCodexConnection("codex-primary-429", 1);
  const alternate = await seedCodexConnection("codex-alternate-429", 2);
  await seedCodexConnection("codex-third-429", 3);
  affinityDb.upsertSessionAccountAffinity(SESSION, "codex", primary.id, Date.now(), TTL);

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ error: { message: "upstream busy" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await handleChatCore({
      body: {
        model: MODEL,
        stream: false,
        input: "hello",
        prompt_cache_key: SESSION,
      },
      modelInfo: { provider: "codex", model: MODEL, extendedContext: false },
      credentials: {
        connectionId: alternate.id,
        accessToken: "codex-test-token",
        providerSpecificData: {},
      },
      connectionId: alternate.id,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: { model: MODEL, stream: false, input: "hello" },
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
      skipUpstreamRetry: true,
    } as Parameters<typeof handleChatCore>[0]);

    assert.equal(result.success, false);
    assert.equal(result.status, 429);
    assert.equal(fetchCalls, 1, "the alternate 429 must not trigger a third upstream request");
    assert.equal(
      affinityDb.getSessionAccountAffinity(SESSION, "codex", TTL)?.connectionId,
      primary.id,
      "the alternate 429 must not clear the primary affinity pin"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat handler wires the one-shot overflow without affinity mutation", () => {
  const src = fs.readFileSync(new URL("../../src/sse/handlers/chat.ts", import.meta.url), "utf8");
  assert.match(src, /const codexOverflow = new CodexLocalCapacityOverflow\(\);/);
  assert.match(
    src,
    /skipUpstreamRetry: codexOverflow\.shouldSkipUpstreamRetry\(/,
    "the alternate attempt must disable chatCore's legacy 429 cascade to prevent a third account"
  );
  assert.match(src, /codexOverflow\.beginResultRetry\(/);
  assert.match(
    src,
    /\.\.\.codexOverflow\.credentialSelectionOptions\(excludedConnectionIds\)/,
    "the primary must remain excluded if an outer cooldown loop recreates the exclusion set"
  );
  assert.match(
    src,
    /if \(codexOverflow\.isAlternateAttempt\) \{\s*return withSelectedConnectionHeader/,
    "the overflow alternate must return directly on failure instead of rotating again"
  );
});
