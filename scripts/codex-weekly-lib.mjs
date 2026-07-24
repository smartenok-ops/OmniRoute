#!/usr/bin/env node
/**
 * Shared read-only helpers for Codex weekly-limit monitoring scripts.
 * Uses sqlite3 CLI in mode=ro (no better-sqlite3 native binding required).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DB_PATH = join(__dirname, "..", "data", "storage.sqlite");

/** USD/month per plan tier — adjust here when pricing changes. */
export const MONTHLY_SUB_USD = {
  plus: 20,
  team: null, // TODO: set real Team price when known (e.g. 25–30/seat)
  unknown: 20,
};

export const WEEKLY_WINDOW_KEYS = ["weekly (7d)", "weekly"];
export const SESSION_FALLBACK_WINDOW_KEY = "session";

export function resolveDbPath() {
  if (process.env.OMNIROUTE_DB_PATH) return process.env.OMNIROUTE_DB_PATH;
  if (process.env.DATA_DIR) return join(process.env.DATA_DIR, "storage.sqlite");
  return DEFAULT_DB_PATH;
}

function sqliteUri(dbPath) {
  return `file:${dbPath}?mode=ro`;
}

function sqlLiteral(value) {
  if (value == null) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function bindSql(sql, params = []) {
  let i = 0;
  return sql.replace(/\?/g, () => sqlLiteral(params[i++]));
}

export function queryAll(dbPath, sql, params = []) {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  const bound = bindSql(sql, params);
  const out = execFileSync("sqlite3", ["-separator", "\t", "-noheader", sqliteUri(dbPath), bound], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!out.trim()) return [];
  return out
    .trimEnd()
    .split("\n")
    .map((line) => {
      const cols = line.split("\t");
      return cols;
    });
}

export function queryRows(dbPath, sql, columns, params = []) {
  const raw = queryAll(dbPath, sql, params);
  return raw.map((cols) => {
    const row = {};
    columns.forEach((name, i) => {
      row[name] = cols[i] ?? null;
    });
    return row;
  });
}

export function queryOne(dbPath, sql, columns, params = []) {
  const rows = queryRows(dbPath, sql, columns, params);
  return rows[0] ?? null;
}

export function parseJson(value) {
  if (!value || typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function getPlanType(connection) {
  const psd = parseJson(connection.provider_specific_data);
  const plan =
    typeof psd.workspacePlanType === "string" ? psd.workspacePlanType.toLowerCase() : "unknown";
  return plan;
}

export function accountLabel(connection) {
  const email = connection.email || connection.display_name || connection.name || connection.id;
  const plan = getPlanType(connection);
  return `${email} [${plan}]`;
}

export function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : String(id);
}

export function toMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const totalMinutes = Math.floor(abs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${sign}${days}d ${hours}h`;
  if (hours > 0) return `${sign}${hours}h ${minutes}m`;
  return `${sign}${minutes}m`;
}

export function formatIsoLocal(iso) {
  if (!iso) return "n/a";
  const ms = toMs(iso);
  if (ms == null) return iso;
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

export function usedPercentFromSnapshot(snapshot) {
  if (!snapshot) return null;
  if (Number(snapshot.is_exhausted) === 1) return 100;
  const remaining = Number(snapshot.remaining_percentage);
  if (!Number.isFinite(remaining)) return null;
  return Math.max(0, Math.min(100, 100 - remaining));
}

export function inferWindowStartMs(snapshot) {
  if (!snapshot) return null;
  const resetMs = toMs(snapshot.next_reset_at);
  if (resetMs == null) return null;
  const duration = Number(snapshot.window_duration_ms);
  if (Number.isFinite(duration) && duration > 0) return resetMs - duration;
  return resetMs - 7 * 24 * 60 * 60 * 1000;
}

const SNAP_COLS = [
  "connection_id",
  "window_key",
  "remaining_percentage",
  "is_exhausted",
  "next_reset_at",
  "window_duration_ms",
  "raw_data",
  "created_at",
];

export function getCodexConnections(dbPath) {
  return queryRows(
    dbPath,
    `SELECT id, provider, display_name, name, email, provider_specific_data
     FROM provider_connections
     WHERE provider = 'codex'
     ORDER BY email, id`,
    ["id", "provider", "display_name", "name", "email", "provider_specific_data"]
  );
}

export function getLatestSnapshot(dbPath, connectionId, windowKeys) {
  const placeholders = windowKeys.map(() => "?").join(", ");
  return queryOne(
    dbPath,
    `SELECT connection_id, window_key, remaining_percentage, is_exhausted,
            next_reset_at, window_duration_ms, raw_data, created_at
     FROM quota_snapshots
     WHERE provider = 'codex' AND connection_id = ? AND window_key IN (${placeholders})
     ORDER BY created_at DESC
     LIMIT 1`,
    SNAP_COLS,
    [connectionId, ...windowKeys]
  );
}

export function resolveWeeklySnapshot(dbPath, connectionId, nowMs = Date.now()) {
  const weekly = getLatestSnapshot(dbPath, connectionId, WEEKLY_WINDOW_KEYS);
  const weeklyAgeMs = weekly ? nowMs - toMs(weekly.created_at) : null;
  const weeklyFresh = weekly && weeklyAgeMs != null && weeklyAgeMs <= 36 * 60 * 60 * 1000;

  if (weeklyFresh) {
    return { snapshot: weekly, source: weekly.window_key, stale: false };
  }

  const session = getLatestSnapshot(dbPath, connectionId, [SESSION_FALLBACK_WINDOW_KEY]);
  if (session) {
    const note =
      weekly == null
        ? "no weekly row; using session window_key (operator: 5h limits retired — session may be weekly)"
        : `weekly row stale (${formatDuration(weeklyAgeMs)} old); using session window_key`;
    return { snapshot: session, source: session.window_key, stale: weekly != null, note };
  }

  if (weekly) {
    return {
      snapshot: weekly,
      source: weekly.window_key,
      stale: true,
      note: "weekly row stale and no session fallback",
    };
  }

  return { snapshot: null, source: null, stale: false, note: "no quota snapshot" };
}

export function pad(str, width, align = "left") {
  const s = String(str ?? "");
  if (s.length >= width) return s.slice(0, width);
  const padLen = width - s.length;
  return align === "right" ? " ".repeat(padLen) + s : s + " ".repeat(padLen);
}

export function formatNumber(n) {
  if (n == null || !Number.isFinite(Number(n))) return "n/a";
  return Math.round(Number(n)).toLocaleString("en-US");
}

export function monthlyPoolCostUsd(connections) {
  let total = 0;
  const flags = [];
  for (const conn of connections) {
    const plan = getPlanType(conn);
    if (
      Object.prototype.hasOwnProperty.call(MONTHLY_SUB_USD, plan) &&
      MONTHLY_SUB_USD[plan] == null
    ) {
      flags.push(`${accountLabel(conn)}: Team price TODO — excluded from cost sum`);
      continue;
    }
    const price = MONTHLY_SUB_USD[plan] ?? MONTHLY_SUB_USD.unknown;
    total += price;
  }
  return { total, flags };
}

function grepEnv(varName, files) {
  for (const file of files) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(new RegExp(`^${varName}=(.+)$`));
      if (!m) continue;
      const value = m[1].trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  return "";
}

export function resolveTelegramConfig() {
  const envToken =
    process.env.CODEX_ALERT_TELEGRAM_BOT_TOKEN || process.env.PLUSVIBE_ADMIN_BOT_TOKEN || "";
  const envChat =
    process.env.CODEX_ALERT_TELEGRAM_CHAT_ID || process.env.PLUSVIBE_ADMIN_CHAT_ID || "";
  if (envToken && envChat) return { token: envToken, chatId: envChat, source: "env" };

  const home = homedir();
  const envFiles = [
    join(home, "projects", "plusvibe-api-bot", ".env"),
    "/opt/plusvibe-api-bot/.env",
    "/etc/plusvibe-api-bot/env",
    join(home, "projects", "plusvibe", ".docker.env"),
    "/opt/plusvibe/env/.docker.env",
  ];

  const resolvedToken =
    process.env.CODEX_ALERT_TELEGRAM_BOT_TOKEN ||
    process.env.PLUSVIBE_ADMIN_BOT_TOKEN ||
    grepEnv("PLUSVIBE_ADMIN_BOT_TOKEN", envFiles);
  const resolvedChat =
    process.env.CODEX_ALERT_TELEGRAM_CHAT_ID ||
    process.env.PLUSVIBE_ADMIN_CHAT_ID ||
    grepEnv("PLUSVIBE_ADMIN_CHAT_ID", envFiles);

  if (resolvedToken && resolvedChat) {
    return { token: resolvedToken, chatId: resolvedChat, source: "env-file" };
  }

  return null;
}

export async function sendTelegramAlert(text) {
  const cfg = resolveTelegramConfig();
  if (!cfg) {
    return {
      sent: false,
      reason: "no telegram config (set CODEX_ALERT_TELEGRAM_* or PLUSVIBE_ADMIN_*)",
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chatId, text }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    return { sent: false, reason: `telegram HTTP ${response.status}` };
  }

  const payload = await response.json();
  if (!payload.ok) {
    return { sent: false, reason: payload.description || "telegram send failed" };
  }

  return { sent: true, source: cfg.source };
}
