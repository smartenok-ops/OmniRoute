/** Lightweight, cached process metrics for the health endpoint. */

import fs from "node:fs";
import * as v8 from "node:v8";
import { SQLITE_FILE } from "@/lib/db/core";

const SAMPLE_TTL_MS = 5_000;

let cached: { sampledAt: string; expiresAt: number; value: RuntimeMetrics } | null = null;

export interface RuntimeMetrics {
  sampledAt: string;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    v8HeapLimit: number;
  };
  fileDescriptors: number | null;
  database: { bytes: number | null; walBytes: number | null };
  activity?: {
    activeAccountSlots: number;
    pendingAccountSlots: number;
    pendingRateLimitRequests: number;
    pendingDeduplicatedRequests: number;
    activeUpstreamAttempts: number;
    activeUpstreamStreams: number;
  };
}

function statBytes(path: string | null): number | null {
  if (!path) return null;
  try {
    return fs.statSync(path).size;
  } catch {
    return null;
  }
}

function fileDescriptorCount(): number | null {
  if (process.platform !== "linux") return null;
  try {
    return fs.readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

export function getRuntimeMetrics(
  activity?: RuntimeMetrics["activity"],
  nowMs = Date.now()
): RuntimeMetrics {
  if (cached && nowMs <= cached.expiresAt) return { ...cached.value, activity };
  const usage = process.memoryUsage();
  const sampledAt = new Date(nowMs).toISOString();
  const value: RuntimeMetrics = {
    sampledAt,
    memory: {
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
      v8HeapLimit: v8.getHeapStatistics().heap_size_limit,
    },
    fileDescriptors: fileDescriptorCount(),
    database: {
      bytes: statBytes(SQLITE_FILE),
      walBytes: statBytes(SQLITE_FILE ? `${SQLITE_FILE}-wal` : null),
    },
  };
  cached = { sampledAt, expiresAt: nowMs + SAMPLE_TTL_MS, value };
  return { ...value, activity };
}
