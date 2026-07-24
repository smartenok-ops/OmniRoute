#!/usr/bin/env node
/**
 * Codex pool weekly-limit consumption + effective cost report (READ-ONLY).
 *
 * Usage:
 *   node scripts/codex-weekly-usage.mjs
 *   OMNIROUTE_DB_PATH=/path/to/storage.sqlite node scripts/codex-weekly-usage.mjs
 *
 * Attribution note: usage_history.api_key_name is an OmniRoute API key, NOT a PlusVibe end-client.
 */

import {
  MONTHLY_SUB_USD,
  accountLabel,
  formatDuration,
  formatIsoLocal,
  formatNumber,
  getCodexConnections,
  getPlanType,
  inferWindowStartMs,
  monthlyPoolCostUsd,
  pad,
  queryOne,
  queryRows,
  resolveDbPath,
  resolveWeeklySnapshot,
  shortId,
  usedPercentFromSnapshot,
} from "./codex-weekly-lib.mjs";

const dbPath = resolveDbPath();
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();

const connections = getCodexConnections(dbPath);

console.log("═".repeat(100));
console.log("OmniRoute Codex Pool — Weekly Limit & Consumption Report");
console.log(`Generated: ${formatIsoLocal(nowIso)}`);
console.log(
  "Attribution: per-client breakdown uses OmniRoute api_key_name (NOT PlusVibe end-client IDs)."
);
console.log("═".repeat(100));

// --- Section 1: current weekly state per account ---
console.log("\n▶ CURRENT WEEKLY-LIMIT STATE (per Codex account)\n");

const header =
  pad("Account", 36) +
  pad("Plan", 8) +
  pad("Src", 10) +
  pad("Rem%", 8, "right") +
  pad("Used%", 8, "right") +
  pad("Exh", 6, "right") +
  pad("Next reset", 24) +
  pad("Until reset", 14) +
  "Snapshot at";
console.log(header);
console.log("-".repeat(header.length));

const accountWindows = [];

for (const conn of connections) {
  const resolved = resolveWeeklySnapshot(dbPath, conn.id, nowMs);
  const snap = resolved.snapshot;
  const usedPct = usedPercentFromSnapshot(snap);
  const remainingPct = snap ? Number(snap.remaining_percentage) : null;
  const resetMs = snap ? Date.parse(snap.next_reset_at) : null;
  const untilReset = resetMs != null ? formatDuration(resetMs - nowMs) : "n/a";
  const windowStartMs = inferWindowStartMs(snap);

  accountWindows.push({ conn, snap, resolved, usedPct, windowStartMs });

  const plan = getPlanType(conn);

  const row =
    pad(accountLabel(conn), 36) +
    pad(plan, 8) +
    pad(resolved.source || "—", 10) +
    pad(remainingPct != null ? remainingPct.toFixed(1) : "n/a", 8, "right") +
    pad(usedPct != null ? usedPct.toFixed(1) : "n/a", 8, "right") +
    pad(snap ? String(snap.is_exhausted) : "?", 6, "right") +
    pad(snap ? formatIsoLocal(snap.next_reset_at) : "n/a", 24) +
    pad(untilReset, 14) +
    " " +
    (snap ? formatIsoLocal(snap.created_at) : "n/a");

  console.log(row);
  if (resolved.note) {
    console.log(`  ↳ note: ${resolved.note}`);
  }
}

// --- Section 2: token consumption per account in current weekly window ---
console.log("\n▶ TOKEN CONSUMPTION PER ACCOUNT (current weekly window)\n");

const usageHeader =
  pad("Account", 36) +
  pad("Requests", 10, "right") +
  pad("Input", 14, "right") +
  pad("Output", 14, "right") +
  pad("Cache read", 14, "right") +
  pad("Reasoning", 14, "right") +
  pad("Total tokens", 16, "right") +
  "Window start";
console.log(usageHeader);
console.log("-".repeat(usageHeader.length));

let poolRequests = 0;
let poolInput = 0;
let poolOutput = 0;
let poolCacheRead = 0;
let poolReasoning = 0;

for (const { conn, snap, windowStartMs } of accountWindows) {
  const startIso =
    windowStartMs != null
      ? new Date(windowStartMs).toISOString()
      : new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();

  const usage = queryOne(
    dbPath,
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(tokens_input), 0) AS input_tokens,
            COALESCE(SUM(tokens_output), 0) AS output_tokens,
            COALESCE(SUM(tokens_cache_read), 0) AS cache_read,
            COALESCE(SUM(tokens_reasoning), 0) AS reasoning
     FROM usage_history
     WHERE provider = 'codex' AND connection_id = ? AND timestamp >= ?`,
    ["requests", "input_tokens", "output_tokens", "cache_read", "reasoning"],
    [conn.id, startIso]
  ) || { requests: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, reasoning: 0 };

  const totalTokens =
    Number(usage.input_tokens) +
    Number(usage.output_tokens) +
    Number(usage.cache_read) +
    Number(usage.reasoning);

  poolRequests += Number(usage.requests);
  poolInput += Number(usage.input_tokens);
  poolOutput += Number(usage.output_tokens);
  poolCacheRead += Number(usage.cache_read);
  poolReasoning += Number(usage.reasoning);

  console.log(
    pad(accountLabel(conn), 36) +
      pad(formatNumber(usage.requests), 10, "right") +
      pad(formatNumber(usage.input_tokens), 14, "right") +
      pad(formatNumber(usage.output_tokens), 14, "right") +
      pad(formatNumber(usage.cache_read), 14, "right") +
      pad(formatNumber(usage.reasoning), 14, "right") +
      pad(formatNumber(totalTokens), 16, "right") +
      " " +
      formatIsoLocal(startIso)
  );
  if (!snap) {
    console.log(`  ↳ window start: fallback last 7 days (no snapshot for reset inference)`);
  }
}

const poolTotalTokens = poolInput + poolOutput + poolCacheRead + poolReasoning;
console.log("-".repeat(usageHeader.length));
console.log(
  pad("POOL TOTAL", 36) +
    pad(formatNumber(poolRequests), 10, "right") +
    pad(formatNumber(poolInput), 14, "right") +
    pad(formatNumber(poolOutput), 14, "right") +
    pad(formatNumber(poolCacheRead), 14, "right") +
    pad(formatNumber(poolReasoning), 14, "right") +
    pad(formatNumber(poolTotalTokens), 16, "right")
);

// --- Section 3: per api_key breakdown (last 7 days) ---
console.log("\n▶ PER OMNIROUTE API KEY (last 7 days) — ranked by total tokens\n");
console.log("(api_key_name is the OmniRoute client proxy; NOT PlusVibe clientId)\n");

const sevenDaysAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();

const apiKeys = queryRows(
  dbPath,
  `SELECT api_key_id, api_key_name,
          COUNT(*) AS requests,
          COALESCE(SUM(tokens_input), 0) AS input_tokens,
          COALESCE(SUM(tokens_output), 0) AS output_tokens,
          COALESCE(SUM(tokens_cache_read), 0) AS cache_read,
          COALESCE(SUM(tokens_reasoning), 0) AS reasoning
   FROM usage_history
   WHERE provider = 'codex' AND timestamp >= ?
   GROUP BY api_key_id, api_key_name
   ORDER BY (input_tokens + output_tokens + cache_read + reasoning) DESC`,
  [
    "api_key_id",
    "api_key_name",
    "requests",
    "input_tokens",
    "output_tokens",
    "cache_read",
    "reasoning",
  ],
  [sevenDaysAgo]
);

const akHeader =
  pad("Rank", 5, "right") +
  pad("api_key_name", 24) +
  pad("api_key_id", 38) +
  pad("Reqs", 8, "right") +
  pad("Total tokens", 16, "right") +
  "Accounts used";
console.log(akHeader);
console.log("-".repeat(akHeader.length));

const accountEmails = Object.fromEntries(connections.map((c) => [c.id, c.email || shortId(c.id)]));

apiKeys.forEach((row, idx) => {
  const total =
    Number(row.input_tokens) +
    Number(row.output_tokens) +
    Number(row.cache_read) +
    Number(row.reasoning);

  const accountRows = queryRows(
    dbPath,
    `SELECT DISTINCT connection_id FROM usage_history
     WHERE provider='codex' AND api_key_id=? AND timestamp >= ?`,
    ["connection_id"],
    [row.api_key_id, sevenDaysAgo]
  );
  const accounts = accountRows
    .map((r) => accountEmails[r.connection_id] || shortId(r.connection_id))
    .join(", ");

  console.log(
    pad(String(idx + 1), 5, "right") +
      pad(row.api_key_name || "(unnamed)", 24) +
      pad(row.api_key_id || "?", 38) +
      pad(formatNumber(row.requests), 8, "right") +
      pad(formatNumber(total), 16, "right") +
      accounts
  );
});

// --- Section 4: effective cost ---
console.log("\n▶ EFFECTIVE SUBSCRIPTION COST (flat monthly fee, not per-token)\n");

const { total: monthlyCost, flags } = monthlyPoolCostUsd(connections);
const accountsPriced = connections.length - flags.length;
const periodDays = 7;
const periodCostUsd = (monthlyCost / 30) * periodDays;

console.log(`Pricing constants (edit scripts/codex-weekly-lib.mjs):`);
console.log(`  Plus:  $${MONTHLY_SUB_USD.plus}/mo × ${accountsPriced} priced account(s)`);
console.log(`  Team:  $${MONTHLY_SUB_USD.team ?? "TODO"}/mo — flagged accounts excluded from sum`);
for (const flag of flags) console.log(`  ⚠ ${flag}`);

console.log(`\nPool monthly sub total (priced accounts): $${monthlyCost.toFixed(2)}/mo`);
console.log(`Prorated ${periodDays}-day period cost:            $${periodCostUsd.toFixed(4)}`);
console.log(`Pool tokens (${periodDays}d, all accounts):         ${formatNumber(poolTotalTokens)}`);
console.log(`Pool requests (${periodDays}d):                       ${formatNumber(poolRequests)}`);

const perMillion = poolTotalTokens > 0 ? (periodCostUsd / poolTotalTokens) * 1_000_000 : null;
const perRequest = poolRequests > 0 ? periodCostUsd / poolRequests : null;

console.log(`\nEffective cost (subscription economics vs per-token APIs):`);
console.log(
  `  $/1M tokens (7d window):  ${perMillion != null ? `$${perMillion.toFixed(4)}` : "n/a (no tokens)"}`
);
console.log(
  `  $/request (7d window):    ${perRequest != null ? `$${perRequest.toFixed(6)}` : "n/a (no requests)"}`
);

console.log("\n" + "═".repeat(100));
