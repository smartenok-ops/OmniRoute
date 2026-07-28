import test from "node:test";
import assert from "node:assert/strict";

import {
  createBodyTimeoutError,
  createUpstreamStartTimeoutError,
  createAbortError,
  computeBillableTokens,
  executeWithUpstreamStartTimeout,
  getExecutorTimeoutMs,
  normalizeExecutorResult,
} from "../../open-sse/handlers/chatCore/upstreamTimeouts.ts";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackAbortListeners(signal: AbortSignal) {
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  let added = 0;
  let removed = 0;

  signal.addEventListener = ((type, listener, options) => {
    if (type === "abort") added += 1;
    return add(type, listener, options);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((type, listener, options) => {
    if (type === "abort") removed += 1;
    return remove(type, listener, options);
  }) as AbortSignal["removeEventListener"];

  return { added: () => added, removed: () => removed };
}

test("error factories set name and message", () => {
  const body = createBodyTimeoutError(1234);
  assert.equal(body.name, "BodyTimeoutError");
  assert.match(body.message, /1234ms/);

  const start = createUpstreamStartTimeoutError(500, "openai", "gpt-4o");
  assert.equal(start.name, "TimeoutError");
  assert.match(start.message, /openai\/gpt-4o/);

  const ctrl = new AbortController();
  ctrl.abort("nope");
  const ab = createAbortError(ctrl.signal);
  assert.equal(ab.name, "AbortError");
});

test("computeBillableTokens sums input+output+reasoning (no cache double-count)", () => {
  const total = computeBillableTokens({
    prompt_tokens: 10,
    completion_tokens: 5,
    reasoning_tokens: 2,
  });
  assert.equal(total, 17);
});

test("getExecutorTimeoutMs floors valid values and falls back to default", () => {
  assert.equal(getExecutorTimeoutMs({ getTimeoutMs: () => 1234.9 }), 1234);
  assert.equal(getExecutorTimeoutMs({ getTimeoutMs: () => NaN }), getExecutorTimeoutMs(null));
  assert.ok(Number.isFinite(getExecutorTimeoutMs(null)));
});

test("normalizeExecutorResult wraps bare Response and passes through rich result", () => {
  const r = new Response("x");
  const wrapped = normalizeExecutorResult(r);
  assert.equal(wrapped.response, r);
  assert.equal(wrapped.url, "");
  const rich = normalizeExecutorResult({ response: r, url: "u", headers: { a: "b" } });
  assert.equal(rich.url, "u");
  assert.equal(rich.headers.a, "b");
});

test("upstream start timeout cleans timers and abort listeners after a successful stream start", async () => {
  const controller = new AbortController();
  const listeners = trackAbortListeners(controller.signal);
  const warnings: string[] = [];

  const result = await executeWithUpstreamStartTimeout({
    executor: { getTimeoutMs: () => 10 },
    provider: "test",
    model: "success",
    signal: controller.signal,
    log: { warn: (_tag, message) => warnings.push(message) },
    execute: async () => "headers-arrived",
  });

  await wait(25);
  assert.equal(result, "headers-arrived");
  assert.deepEqual(warnings, []);
  assert.equal(listeners.added(), 2);
  assert.equal(listeners.removed(), 2);
});

test("upstream start timeout propagates client abort and cleans up exactly once", async () => {
  const controller = new AbortController();
  const listeners = trackAbortListeners(controller.signal);
  const warnings: string[] = [];
  let upstreamAborts = 0;

  const pending = executeWithUpstreamStartTimeout({
    executor: { getTimeoutMs: () => 50 },
    provider: "test",
    model: "abort",
    signal: controller.signal,
    log: { warn: (_tag, message) => warnings.push(message) },
    execute: (signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            upstreamAborts += 1;
            reject(signal.reason);
          },
          { once: true }
        );
      }),
  });

  controller.abort(new DOMException("client disconnected", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  await wait(60);
  assert.equal(upstreamAborts, 1);
  assert.deepEqual(warnings, []);
  assert.equal(listeners.added(), 2);
  assert.equal(listeners.removed(), 2);
});

test("upstream start timeout still aborts a stalled request and cleans up exactly once", async () => {
  const controller = new AbortController();
  const listeners = trackAbortListeners(controller.signal);
  const warnings: string[] = [];
  let upstreamAborts = 0;

  const pending = executeWithUpstreamStartTimeout({
    executor: { getTimeoutMs: () => 10 },
    provider: "test",
    model: "timeout",
    signal: controller.signal,
    log: { warn: (_tag, message) => warnings.push(message) },
    execute: (signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            upstreamAborts += 1;
            reject(signal.reason);
          },
          { once: true }
        );
      }),
  });

  await assert.rejects(pending, { name: "TimeoutError" });
  assert.equal(upstreamAborts, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /10ms \(test\/timeout\)/);
  assert.equal(listeners.added(), 2);
  assert.equal(listeners.removed(), 2);
});
