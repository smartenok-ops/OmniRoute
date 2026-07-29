import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const WORKFLOWS_DIR = path.resolve(import.meta.dirname, "../../.github/workflows");
const LIVENESS_PROBE_SOURCES = [
  ".github/workflows/dast-smoke.yml",
  ".github/workflows/deploy-vps.yml",
  ".github/workflows/nightly-llm-security.yml",
  ".github/workflows/nightly-resilience.yml",
  ".github/workflows/nightly-schemathesis.yml",
  "tests/load/k6-soak.js",
];

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(WORKFLOWS_DIR, "../..", relativePath), "utf8");
}

test("workflow liveness probes use the public ping endpoint", () => {
  for (const source of LIVENESS_PROBE_SOURCES) {
    assert.match(
      readSource(source),
      /\/api\/health\/ping\b/,
      `${source} must wait for the public liveness endpoint`
    );
  }
});

test("committed workflows do not curl protected rich health unauthenticated", () => {
  for (const workflow of readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith(".yml"))) {
    assert.doesNotMatch(
      readFileSync(path.join(WORKFLOWS_DIR, workflow), "utf8"),
      /curl\b[^\n]*\/api\/monitoring\/health\b/,
      `${workflow} must not use protected rich health as an unauthenticated readiness probe`
    );
  }
});
