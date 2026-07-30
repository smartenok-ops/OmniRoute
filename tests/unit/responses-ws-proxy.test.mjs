import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { createResponsesWsProxy } = await import("../../scripts/dev/responses-ws-proxy.mjs");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const value = predicate();
        if (value) {
          clearInterval(timer);
          resolve(value);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for condition"));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, intervalMs);
  });
}

test("responses ws proxy prepares and forwards OpenAI Responses websocket events", async () => {
  const internalRequests = [];
  const upstreamSends = [];
  const downstreamMessages = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/internal/codex-responses-ws") {
      const body = JSON.parse((await readRequestBody(req)) || "{}");
      internalRequests.push(body);

      if (body.action === "authenticate") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, authenticated: true, authType: "api_key" }));
        return;
      }

      if (body.action === "prepare") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            upstreamUrl: "wss://chatgpt.com/backend-api/codex/responses",
            headers: { Authorization: "Bearer upstream-token" },
            connectionId: "conn_1",
            provider: "codex",
            account: "codex@example.com",
            // #5611: prepare resolves the configured proxy and threads it through.
            proxy: "http://test-proxy:8888",
            model: "gpt-5.5",
            response: {
              ...body.response,
              model: "gpt-5.5",
              stream: undefined,
            },
          })
        );
        return;
      }

      if (body.action === "log") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, logged: true }));
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const fakeUpstream = {
    send(data) {
      upstreamSends.push(JSON.parse(data));
      setTimeout(() => {
        fakeUpstream.onmessage?.({
          data: JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_1",
              model: "gpt-5.5",
              status: "completed",
              usage: { input_tokens: 29, output_tokens: 42, total_tokens: 71 },
            },
          }),
        });
      }, 10);
    },
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  };

  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const proxy = createResponsesWsProxy({
    baseUrl,
    bridgeSecret: "bridge-secret",
    pingIntervalMs: 1000,
    idleTimeoutMs: 10000,
    wsFactory: async (url, options) => {
      assert.equal(url, "wss://chatgpt.com/backend-api/codex/responses");
      assert.equal(options.headers.Authorization, "Bearer upstream-token");
      // #5591: prepare omits `browser`, so the fallback must be the supported
      // chrome_142 (not the non-existent chrome_149).
      assert.equal(options.browser, "chrome_142");
      // #5611: the configured proxy from prepare must reach the upstream connect.
      assert.equal(options.proxy, "http://test-proxy:8888");
      return fakeUpstream;
    },
  });

  server.on("upgrade", async (req, socket, head) => {
    const handled = await proxy.handleUpgrade(req, socket, head);
    if (!handled && !socket.destroyed) {
      socket.destroy();
    }
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/responses?api_key=local-token`);
  ws.addEventListener("message", (event) => {
    downstreamMessages.push(JSON.parse(String(event.data)));
  });

  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.send(
    JSON.stringify({
      type: "response.create",
      model: "gpt-5.5",
      input: [{ role: "user", content: "hello" }],
      reasoning: { effort: "xhigh" },
    })
  );

  await waitFor(() => downstreamMessages.find((entry) => entry.type === "response.completed"));
  const logRequest = await waitFor(() => internalRequests.find((entry) => entry.action === "log"));

  assert.equal(internalRequests[0].action, "authenticate");
  assert.equal(internalRequests[1].action, "prepare");
  assert.equal(upstreamSends.length, 1);
  assert.equal(upstreamSends[0].type, "response.create");
  assert.equal(upstreamSends[0].model, "gpt-5.5");
  assert.equal(upstreamSends[0].reasoning.effort, "xhigh");
  assert.equal("stream" in upstreamSends[0], false);
  assert.equal(logRequest.transport, "responses_websocket");
  assert.equal(logRequest.status, 200);
  assert.equal(logRequest.success, true);
  assert.equal(logRequest.connectionId, "conn_1");
  assert.equal(logRequest.provider, "codex");
  assert.equal(logRequest.model, "gpt-5.5");
  assert.equal(logRequest.requestedModel, "gpt-5.5");
  assert.equal(logRequest.clientRequest.model, "gpt-5.5");
  assert.equal(logRequest.responseBody.usage.input_tokens, 29);
  assert.equal(logRequest.responseBody.usage.output_tokens, 42);
  assert.equal(logRequest.terminalMessage.type, "response.completed");

  ws.close();
  await close(server);
});

test("responses ws proxy logs prepare failures to request history", async () => {
  const internalRequests = [];
  const downstreamMessages = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/internal/codex-responses-ws") {
      const body = JSON.parse((await readRequestBody(req)) || "{}");
      internalRequests.push(body);

      if (body.action === "authenticate") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, authenticated: true, authType: "api_key" }));
        return;
      }

      if (body.action === "prepare") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "codex_credentials_unavailable",
              message: "No available Codex OAuth connection for Responses WebSocket",
            },
          })
        );
        return;
      }

      if (body.action === "log") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, logged: true }));
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const port = await listen(server);
  const proxy = createResponsesWsProxy({
    baseUrl: `http://127.0.0.1:${port}`,
    bridgeSecret: "bridge-secret",
    pingIntervalMs: 1000,
    idleTimeoutMs: 10000,
    wsFactory: async () => {
      throw new Error("prepare failure should not connect upstream");
    },
  });

  server.on("upgrade", async (req, socket, head) => {
    const handled = await proxy.handleUpgrade(req, socket, head);
    if (!handled && !socket.destroyed) {
      socket.destroy();
    }
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/responses?api_key=local-token`);
  ws.addEventListener("message", (event) => {
    downstreamMessages.push(JSON.parse(String(event.data)));
  });

  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.send(
    JSON.stringify({
      type: "response.create",
      model: "gpt-5.5",
      input: [{ role: "user", content: "hello" }],
    })
  );

  await waitFor(() => downstreamMessages.find((entry) => entry.type === "response.failed"));
  const logRequest = await waitFor(() => internalRequests.find((entry) => entry.action === "log"));

  assert.equal(logRequest.transport, "responses_websocket");
  assert.equal(logRequest.status, 503);
  assert.equal(logRequest.success, false);
  assert.equal(logRequest.errorCode, "codex_credentials_unavailable");
  assert.match(logRequest.errorMessage, /No available Codex OAuth connection/);
  assert.equal(logRequest.clientRequest.model, "gpt-5.5");
  assert.equal(logRequest.terminalMessage.type, "response.failed");

  ws.close();
  await close(server);
});

test("responses ws proxy retries a pre-output insufficient_quota on the next allowed connection", async () => {
  const internalRequests = [];
  const downstreamMessages = [];
  const upstreamSends = [];
  let prepareCount = 0;

  const server = http.createServer(async (req, res) => {
    if (
      new URL(req.url || "/", `http://${req.headers.host}`).pathname !==
      "/api/internal/codex-responses-ws"
    ) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse((await readRequestBody(req)) || "{}");
    internalRequests.push(body);
    if (
      body.action === "authenticate" ||
      body.action === "report_quota_failure" ||
      body.action === "log"
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (body.action === "prepare") {
      prepareCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          upstreamUrl: "wss://chatgpt.com/backend-api/codex/responses",
          headers: {},
          connectionId: `conn_${prepareCount}`,
          provider: "codex",
          model: "gpt-5.5",
          response: { ...body.response, model: "gpt-5.5" },
        })
      );
    }
  });

  const firstUpstream = {
    send(data) {
      upstreamSends.push(["first", JSON.parse(data)]);
      queueMicrotask(() =>
        firstUpstream.onmessage?.({
          data: JSON.stringify({
            type: "response.failed",
            response: { status: "failed", error: { code: "insufficient_quota", message: "limit" } },
          }),
        })
      );
    },
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const secondUpstream = {
    send(data) {
      upstreamSends.push(["second", JSON.parse(data)]);
      queueMicrotask(() =>
        secondUpstream.onmessage?.({
          data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
        })
      );
    },
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  };

  const port = await listen(server);
  const proxy = createResponsesWsProxy({
    baseUrl: `http://127.0.0.1:${port}`,
    bridgeSecret: "bridge-secret",
    pingIntervalMs: 1000,
    idleTimeoutMs: 10000,
    wsFactory: async () => (prepareCount === 1 ? firstUpstream : secondUpstream),
  });
  server.on("upgrade", async (req, socket, head) => {
    if (!(await proxy.handleUpgrade(req, socket, head)) && !socket.destroyed) socket.destroy();
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses?api_key=local-token`);
  ws.addEventListener("message", (event) =>
    downstreamMessages.push(JSON.parse(String(event.data)))
  );
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.5", input: "hello" }));

  await waitFor(() => downstreamMessages.find((entry) => entry.type === "response.completed"));
  assert.equal(downstreamMessages.filter((entry) => entry.type === "response.failed").length, 0);
  assert.equal(prepareCount, 2);
  assert.deepEqual(
    internalRequests.find((entry) => entry.action === "prepare").excludeConnectionIds,
    []
  );
  assert.deepEqual(
    internalRequests.filter((entry) => entry.action === "prepare")[1].excludeConnectionIds,
    ["conn_1"]
  );
  assert.equal(
    internalRequests.filter((entry) => entry.action === "report_quota_failure")[0].connectionId,
    "conn_1"
  );
  assert.equal(upstreamSends.length, 2);

  ws.close();
  await close(server);
});

test("responses ws proxy forwards one terminal quota failure after bounded attempts are exhausted", async () => {
  const downstreamMessages = [];
  let prepareCount = 0;
  const server = http.createServer(async (req, res) => {
    if (
      new URL(req.url || "/", `http://${req.headers.host}`).pathname !==
      "/api/internal/codex-responses-ws"
    ) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse((await readRequestBody(req)) || "{}");
    if (
      body.action === "authenticate" ||
      body.action === "report_quota_failure" ||
      body.action === "log"
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (body.action === "prepare") {
      prepareCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          upstreamUrl: "wss://test",
          headers: {},
          connectionId: `conn_${prepareCount}`,
          provider: "codex",
          model: "gpt-5.5",
          response: { ...body.response, model: "gpt-5.5" },
        })
      );
    }
  });
  const makeQuotaUpstream = () => ({
    send() {
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            type: "response.failed",
            response: { status: "failed", error: { code: "insufficient_quota", message: "limit" } },
          }),
        })
      );
    },
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  });
  const port = await listen(server);
  const proxy = createResponsesWsProxy({
    baseUrl: `http://127.0.0.1:${port}`,
    bridgeSecret: "bridge-secret",
    pingIntervalMs: 1000,
    idleTimeoutMs: 10000,
    maxQuotaFailoverAttempts: 2,
    wsFactory: async () => makeQuotaUpstream(),
  });
  server.on("upgrade", async (req, socket, head) => {
    if (!(await proxy.handleUpgrade(req, socket, head)) && !socket.destroyed) socket.destroy();
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses?api_key=local-token`);
  ws.addEventListener("message", (event) =>
    downstreamMessages.push(JSON.parse(String(event.data)))
  );
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.5", input: "hello" }));

  await waitFor(() => downstreamMessages.length === 1);
  assert.equal(prepareCount, 2);
  assert.equal(downstreamMessages[0].type, "response.failed");
  assert.equal(downstreamMessages[0].response.error.code, "insufficient_quota");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(downstreamMessages.length, 1, "must not duplicate terminal frames");

  ws.close();
  await close(server);
});

test("responses ws proxy retains the client affinity signal and moves its pin after quota failover", async () => {
  const internalRequests = [];
  let prepareCount = 0;
  const server = http.createServer(async (req, res) => {
    if (
      new URL(req.url || "/", `http://${req.headers.host}`).pathname !==
      "/api/internal/codex-responses-ws"
    ) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse((await readRequestBody(req)) || "{}");
    internalRequests.push(body);
    if (
      body.action === "authenticate" ||
      body.action === "report_quota_failure" ||
      body.action === "log"
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (body.action === "prepare") {
      prepareCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          upstreamUrl: "wss://test",
          headers: {},
          connectionId: `conn_${prepareCount}`,
          provider: "codex",
          model: "gpt-5.5",
          response: { ...body.response, model: "gpt-5.5" },
        })
      );
    }
  });
  const first = {
    send() {
      queueMicrotask(() =>
        first.onmessage?.({
          data: JSON.stringify({
            type: "response.failed",
            response: { status: "failed", error: { code: "insufficient_quota" } },
          }),
        })
      );
    },
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const second = {
    send() {
      queueMicrotask(() =>
        second.onmessage?.({
          data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
        })
      );
    },
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const port = await listen(server);
  const proxy = createResponsesWsProxy({
    baseUrl: `http://127.0.0.1:${port}`,
    bridgeSecret: "bridge-secret",
    pingIntervalMs: 1000,
    idleTimeoutMs: 10000,
    wsFactory: async () => (prepareCount === 1 ? first : second),
  });
  server.on("upgrade", async (req, socket, head) => {
    if (!(await proxy.handleUpgrade(req, socket, head)) && !socket.destroyed) socket.destroy();
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses?api_key=local-token`);
  const messages = [];
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.send(
    JSON.stringify({
      type: "response.create",
      model: "gpt-5.5",
      input: "hello",
      metadata: { session_id: "cockpit-turn-7" },
    })
  );
  await waitFor(() => messages.some((message) => message.type === "response.completed"));

  const prepares = internalRequests.filter((entry) => entry.action === "prepare");
  assert.equal(prepares.length, 2);
  assert.equal(prepares[0].response.metadata.session_id, "cockpit-turn-7");
  assert.equal(prepares[1].response.metadata.session_id, "cockpit-turn-7");
  assert.deepEqual(prepares[0].excludeConnectionIds, []);
  assert.deepEqual(prepares[1].excludeConnectionIds, ["conn_1"]);

  ws.close();
  await close(server);
});

test("responses ws proxy serializes client frames while upstream prepare is pending", async () => {
  const internalRequests = [];
  const upstreamSends = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/internal/codex-responses-ws") {
      const body = JSON.parse((await readRequestBody(req)) || "{}");
      internalRequests.push(body);

      if (body.action === "authenticate") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, authenticated: true, authType: "api_key" }));
        return;
      }

      if (body.action === "prepare") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            upstreamUrl: "wss://chatgpt.com/backend-api/codex/responses",
            headers: { Authorization: "Bearer upstream-token" },
            response: { ...body.response, model: "gpt-5.5", stream: undefined },
          })
        );
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const fakeUpstream = {
    send(data) {
      upstreamSends.push(JSON.parse(data));
    },
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  };

  const port = await listen(server);
  const proxy = createResponsesWsProxy({
    baseUrl: `http://127.0.0.1:${port}`,
    bridgeSecret: "bridge-secret",
    pingIntervalMs: 1000,
    idleTimeoutMs: 10000,
    wsFactory: async () => fakeUpstream,
  });

  server.on("upgrade", async (req, socket, head) => {
    const handled = await proxy.handleUpgrade(req, socket, head);
    if (!handled && !socket.destroyed) {
      socket.destroy();
    }
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/responses?api_key=local-token`);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));

  ws.send(
    JSON.stringify({
      type: "response.create",
      model: "gpt-5.5",
      input: [{ role: "user", content: "first" }],
    })
  );
  ws.send(JSON.stringify({ type: "response.cancel", response_id: "resp_1" }));

  await waitFor(() => upstreamSends.length === 2);

  assert.equal(internalRequests.filter((entry) => entry.action === "prepare").length, 1);
  assert.equal(upstreamSends[0].type, "response.create");
  assert.equal(upstreamSends[0].input[0].content, "first");
  assert.equal(upstreamSends[1].type, "response.cancel");
  assert.equal(upstreamSends[1].response_id, "resp_1");

  ws.close();
  await close(server);
});

test("responses ws proxy closes oversized client messages with 1009", async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/internal/codex-responses-ws") {
      const body = JSON.parse((await readRequestBody(req)) || "{}");
      if (body.action === "authenticate") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, authenticated: true, authType: "api_key" }));
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const port = await listen(server);
  const proxy = createResponsesWsProxy({
    baseUrl: `http://127.0.0.1:${port}`,
    bridgeSecret: "bridge-secret",
    pingIntervalMs: 1000,
    idleTimeoutMs: 10000,
    maxMessageBytes: 64,
    wsFactory: async () => {
      throw new Error("oversized input should close before upstream connect");
    },
  });

  server.on("upgrade", async (req, socket, head) => {
    const handled = await proxy.handleUpgrade(req, socket, head);
    if (!handled && !socket.destroyed) {
      socket.destroy();
    }
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/responses?api_key=local-token`);
  const closed = new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));

  ws.send(
    JSON.stringify({
      type: "response.create",
      model: "gpt-5.5",
      input: [{ role: "user", content: "x".repeat(128) }],
    })
  );

  const event = await closed;
  assert.equal(event.code, 1009);

  await close(server);
});
