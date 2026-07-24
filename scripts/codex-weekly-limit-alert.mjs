#!/usr/bin/env node
/**
 * Codex weekly-limit 98% alert — DETECTION ONLY (no auto-reset).
 *
 * Usage:
 *   node scripts/codex-weekly-limit-alert.mjs
 *
 * State file (alert dedup): ~/.codex-weekly-limit-alert.state
 * Telegram: CODEX_ALERT_TELEGRAM_* or PLUSVIBE_ADMIN_* (see codex-weekly-lib.mjs)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  accountLabel,
  formatDuration,
  formatIsoLocal,
  getCodexConnections,
  resolveDbPath,
  resolveTelegramConfig,
  resolveWeeklySnapshot,
  sendTelegramAlert,
  usedPercentFromSnapshot,
} from "./codex-weekly-lib.mjs";

const THRESHOLD_USED_PCT = Number(process.env.CODEX_WEEKLY_ALERT_THRESHOLD || 98);
const STATE_FILE =
  process.env.CODEX_WEEKLY_ALERT_STATE || join(homedir(), ".codex-weekly-limit-alert.state");

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  const out = {};
  for (const line of readFileSync(STATE_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp.${process.pid}`;
  const lines = [
    "# Codex weekly-limit alert dedup state",
    "# key=connectionId  value=next_reset_at|usedPct",
    ...Object.entries(state).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}

const dbPath = resolveDbPath();
const nowMs = Date.now();
const state = loadState();
const nextState = { ...state };
const newAlerts = [];

const connections = getCodexConnections(dbPath);

let maxUsedPct = 0;
let maxUsedAccount = null;

for (const conn of connections) {
  const resolved = resolveWeeklySnapshot(dbPath, conn.id, nowMs);
  const snap = resolved.snapshot;
  const usedPct = usedPercentFromSnapshot(snap);

  if (usedPct != null && usedPct > maxUsedPct) {
    maxUsedPct = usedPct;
    maxUsedAccount = conn;
  }

  const stateKey = conn.id;
  const resetAt = snap?.next_reset_at || "unknown";
  const stateVal = `${resetAt}|${usedPct != null ? usedPct.toFixed(1) : "?"}`;

  if (usedPct == null || usedPct < THRESHOLD_USED_PCT) {
    delete nextState[stateKey];
    continue;
  }

  const prior = state[stateKey];
  if (prior && prior.startsWith(`${resetAt}|`)) continue;

  const resetMs = snap ? Date.parse(snap.next_reset_at) : null;
  const untilReset = resetMs != null ? formatDuration(resetMs - nowMs) : "n/a";

  const alertLine = [
    "CODEX WEEKLY LIMIT ALERT",
    `account: ${accountLabel(conn)}`,
    `connection_id: ${conn.id}`,
    `used%: ${usedPct.toFixed(1)} (threshold ${THRESHOLD_USED_PCT})`,
    `remaining%: ${snap ? Number(snap.remaining_percentage).toFixed(1) : "n/a"}`,
    `exhausted: ${snap ? snap.is_exhausted : "?"}`,
    `next_reset_at: ${formatIsoLocal(snap?.next_reset_at)}`,
    `time_until_reset: ${untilReset}`,
    `snapshot_source: ${resolved.source}${resolved.note ? ` (${resolved.note})` : ""}`,
    `detected_at: ${formatIsoLocal(new Date(nowMs).toISOString())}`,
    "action: ALERT ONLY — manual reset NOT triggered",
  ].join("\n");

  newAlerts.push(alertLine);
  nextState[stateKey] = stateVal;
}

saveState(nextState);

if (newAlerts.length === 0) {
  const maxLabel = maxUsedAccount ? accountLabel(maxUsedAccount) : "n/a";
  console.log(
    `OK: all Codex accounts below ${THRESHOLD_USED_PCT}% weekly used (max: ${maxUsedPct.toFixed(1)}% — ${maxLabel})`
  );
  process.exit(0);
}

for (const alert of newAlerts) {
  console.log(alert);
  console.log("---");

  const tg = await sendTelegramAlert(alert);
  if (tg.sent) {
    console.log(`telegram: delivered (config source: ${tg.source})`);
  } else {
    const cfg = resolveTelegramConfig();
    if (cfg) {
      console.log(`telegram: FAILED — ${tg.reason}`);
    } else {
      console.log(
        "telegram: skipped — no config. TODO: set CODEX_ALERT_TELEGRAM_BOT_TOKEN + CODEX_ALERT_TELEGRAM_CHAT_ID"
      );
      console.log(
        "  or PLUSVIBE_ADMIN_BOT_TOKEN + PLUSVIBE_ADMIN_CHAT_ID (read from plusvibe-api-bot .env)"
      );
    }
  }
}

process.exit(2);
