import test from "node:test";
import assert from "node:assert/strict";

import { fetchPublicStatusLiveness } from "../../src/app/status/statusLiveness.ts";

test("status page liveness loader reads only the public ping payload", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return Response.json({ status: "ok", timestamp: "2026-07-29T00:00:00.000Z", latencyMs: 4 });
  };

  try {
    const liveness = await fetchPublicStatusLiveness();
    assert.deepEqual(liveness, {
      status: "ok",
      timestamp: "2026-07-29T00:00:00.000Z",
      latencyMs: 4,
    });
    assert.deepEqual(requests, [{ input: "/api/health/ping", init: { cache: "no-store" } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
