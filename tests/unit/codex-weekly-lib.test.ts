import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const lib = await import("../../scripts/codex-weekly-lib.mjs");

const {
  accountLabel,
  formatDuration,
  getCodexConnections,
  getPlanType,
  inferWindowStartMs,
  monthlyPoolCostUsd,
  queryRows,
  resolveWeeklySnapshot,
  usedPercentFromSnapshot,
} = lib as {
  accountLabel: (conn: Record<string, string | null>) => string;
  formatDuration: (ms: number | null) => string;
  getCodexConnections: (dbPath: string) => Array<Record<string, string>>;
  getPlanType: (conn: Record<string, string | null>) => string;
  inferWindowStartMs: (snapshot: Record<string, unknown> | null) => number | null;
  monthlyPoolCostUsd: (connections: Array<Record<string, string | null>>) => {
    total: number;
    flags: string[];
  };
  queryRows: (
    dbPath: string,
    sql: string,
    columns: string[],
    params?: unknown[]
  ) => Array<Record<string, string | null>>;
  resolveWeeklySnapshot: (
    dbPath: string,
    connectionId: string,
    nowMs?: number
  ) => {
    snapshot: Record<string, string> | null;
    source: string | null;
    stale: boolean;
    note?: string;
  };
  usedPercentFromSnapshot: (snapshot: Record<string, unknown> | null) => number | null;
};

function createFixtureDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weekly-lib-"));
  const dbPath = path.join(dir, "storage.sqlite");
  execFileSync("sqlite3", [
    dbPath,
    `
    CREATE TABLE provider_connections (
      id TEXT PRIMARY KEY,
      provider TEXT,
      display_name TEXT,
      name TEXT,
      email TEXT,
      provider_specific_data TEXT
    );
    CREATE TABLE quota_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      window_key TEXT NOT NULL,
      remaining_percentage REAL,
      is_exhausted INTEGER DEFAULT 0,
      next_reset_at TEXT,
      window_duration_ms INTEGER,
      raw_data TEXT,
      created_at TEXT NOT NULL
    );
  `,
  ]);
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function insertConnection(
  dbPath: string,
  row: {
    id: string;
    email: string;
    plan?: string;
  }
) {
  const psd = JSON.stringify({ workspacePlanType: row.plan ?? "plus" });
  execFileSync("sqlite3", [
    dbPath,
    `INSERT INTO provider_connections (id, provider, email, provider_specific_data)
       VALUES ('${row.id}', 'codex', '${row.email}', '${psd.replace(/'/g, "''")}');`,
  ]);
}

function insertSnapshot(
  dbPath: string,
  row: {
    connectionId: string;
    windowKey: string;
    remainingPct: number;
    createdAt: string;
    nextResetAt: string;
    windowDurationMs?: number;
  }
) {
  const duration = row.windowDurationMs ?? 7 * 24 * 60 * 60 * 1000;
  execFileSync("sqlite3", [
    dbPath,
    `INSERT INTO quota_snapshots
       (provider, connection_id, window_key, remaining_percentage, is_exhausted,
        next_reset_at, window_duration_ms, raw_data, created_at)
       VALUES (
         'codex',
         '${row.connectionId}',
         '${row.windowKey}',
         ${row.remainingPct},
         0,
         '${row.nextResetAt}',
         ${duration},
         '{}',
         '${row.createdAt}'
       );`,
  ]);
}

test("usedPercentFromSnapshot handles exhausted, remaining, and missing data", () => {
  assert.equal(usedPercentFromSnapshot({ is_exhausted: 1 }), 100);
  assert.equal(usedPercentFromSnapshot({ remaining_percentage: "25" }), 75);
  assert.equal(usedPercentFromSnapshot({ remaining_percentage: 150 }), 0);
  assert.equal(usedPercentFromSnapshot(null), null);
});

test("inferWindowStartMs uses window duration or 7d fallback", () => {
  const resetAt = "2026-07-24T12:00:00.000Z";
  const durationMs = 3_600_000;
  const withDuration = inferWindowStartMs({
    next_reset_at: resetAt,
    window_duration_ms: durationMs,
  });
  assert.equal(withDuration, Date.parse(resetAt) - durationMs);

  const fallback = inferWindowStartMs({ next_reset_at: resetAt });
  assert.equal(fallback, Date.parse(resetAt) - 7 * 24 * 60 * 60 * 1000);
});

test("getPlanType and accountLabel normalize plan metadata", () => {
  const conn = {
    id: "conn-1",
    email: "ops@example.com",
    display_name: null,
    name: null,
    provider_specific_data: JSON.stringify({ workspacePlanType: "Plus" }),
  };
  assert.equal(getPlanType(conn), "plus");
  assert.match(accountLabel(conn), /ops@example.com \[plus\]/);
});

test("monthlyPoolCostUsd sums plus accounts and flags team pricing gaps", () => {
  const priced = monthlyPoolCostUsd([
    { provider_specific_data: JSON.stringify({ workspacePlanType: "plus" }) },
    { provider_specific_data: JSON.stringify({ workspacePlanType: "plus" }) },
  ]);
  assert.equal(priced.total, 40);
  assert.equal(priced.flags.length, 0);

  const team = monthlyPoolCostUsd([
    {
      id: "team-1",
      email: "team@example.com",
      provider_specific_data: JSON.stringify({ workspacePlanType: "team" }),
    },
  ]);
  assert.equal(team.total, 0);
  assert.equal(team.flags.length, 1);
});

test("formatDuration renders human-readable intervals", () => {
  assert.equal(formatDuration(90 * 60_000), "1h 30m");
  assert.equal(formatDuration(26 * 60 * 60_000), "1d 2h");
  assert.equal(formatDuration(null), "n/a");
});

test("queryRows escapes malicious SQL literals in bound params", () => {
  const { dbPath, cleanup } = createFixtureDb();
  try {
    insertConnection(dbPath, { id: "safe-id", email: "safe@example.com" });
    const malicious = "x' OR 1=1 --";
    const rows = queryRows(
      dbPath,
      "SELECT email FROM provider_connections WHERE id = ?",
      ["email"],
      [malicious]
    );
    assert.equal(rows.length, 0);
  } finally {
    cleanup();
  }
});

test("resolveWeeklySnapshot prefers fresh weekly rows", () => {
  const { dbPath, cleanup } = createFixtureDb();
  const nowMs = Date.parse("2026-07-24T12:00:00.000Z");
  try {
    insertConnection(dbPath, { id: "conn-a", email: "a@example.com" });
    insertSnapshot(dbPath, {
      connectionId: "conn-a",
      windowKey: "weekly",
      remainingPct: 10,
      createdAt: "2026-07-24T10:00:00.000Z",
      nextResetAt: "2026-07-31T12:00:00.000Z",
    });

    const fresh = resolveWeeklySnapshot(dbPath, "conn-a", nowMs);
    assert.equal(fresh.source, "weekly");
    assert.equal(fresh.stale, false);
    assert.equal(Number(fresh.snapshot?.remaining_percentage), 10);
  } finally {
    cleanup();
  }
});

test("resolveWeeklySnapshot falls back to session when weekly row is stale", () => {
  const { dbPath, cleanup } = createFixtureDb();
  const nowMs = Date.parse("2026-07-24T12:00:00.000Z");
  try {
    insertConnection(dbPath, { id: "conn-b", email: "b@example.com" });
    insertSnapshot(dbPath, {
      connectionId: "conn-b",
      windowKey: "weekly",
      remainingPct: 8,
      createdAt: "2026-07-20T10:00:00.000Z",
      nextResetAt: "2026-07-27T12:00:00.000Z",
    });
    insertSnapshot(dbPath, {
      connectionId: "conn-b",
      windowKey: "session",
      remainingPct: 5,
      createdAt: "2026-07-24T11:30:00.000Z",
      nextResetAt: "2026-07-31T12:00:00.000Z",
    });

    const stale = resolveWeeklySnapshot(dbPath, "conn-b", nowMs);
    assert.equal(stale.source, "session");
    assert.equal(stale.stale, true);
    assert.match(stale.note ?? "", /stale/i);
  } finally {
    cleanup();
  }
});

test("getCodexConnections returns only codex provider rows", () => {
  const { dbPath, cleanup } = createFixtureDb();
  try {
    execFileSync("sqlite3", [
      dbPath,
      `INSERT INTO provider_connections (id, provider, email, provider_specific_data)
         VALUES ('other', 'openai', 'o@example.com', '{}');`,
    ]);
    insertConnection(dbPath, { id: "codex-1", email: "c@example.com" });

    const rows = getCodexConnections(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "c@example.com");
  } finally {
    cleanup();
  }
});
