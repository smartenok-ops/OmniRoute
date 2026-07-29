"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Spinner } from "@/shared/components/Loading";
import { fetchPublicStatusLiveness, type PublicStatusLiveness } from "./statusLiveness";

export default function StatusPage() {
  const [loading, setLoading] = useState(true);
  const [liveness, setLiveness] = useState<PublicStatusLiveness | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadLiveness() {
    setLoading(true);
    setError(null);
    try {
      setLiveness(await fetchPublicStatusLiveness());
    } catch {
      setError("Unable to reach health endpoint. Check connectivity and retry.");
      setLiveness(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadLiveness();
  }, []);

  return (
    <main className="min-h-screen text-text-main p-6 sm:p-10">
      <section className="max-w-4xl mx-auto space-y-6">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">System Status</h1>
            <p className="text-text-muted mt-1">
              Live public liveness signal for OmniRoute core services.
            </p>
          </div>
          <button
            onClick={() => void loadLiveness()}
            className="inline-flex items-center justify-center px-4 py-2 rounded-lg text-sm font-semibold bg-gradient-to-br from-primary to-primary-hover text-white transition-all duration-200 motion-reduce:transition-none"
          >
            Refresh
          </button>
        </header>

        {loading && (
          <div
            className="rounded-xl border border-border bg-surface p-6 flex items-center gap-3"
            role="status"
            aria-live="polite"
          >
            <Spinner size="md" />
            <span className="text-text-muted">Checking service liveness...</span>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6" role="alert">
            <h2 className="text-lg font-semibold text-red-600 dark:text-red-400">
              Health Check Failed
            </h2>
            <p className="mt-2 text-sm text-text-muted">{error}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href="/offline"
                className="px-3 py-2 rounded-lg border border-border text-sm font-medium hover:bg-bg-alt transition-colors"
              >
                Open Connectivity Help
              </Link>
              <Link
                href="/maintenance"
                className="px-3 py-2 rounded-lg border border-border text-sm font-medium hover:bg-bg-alt transition-colors"
              >
                Maintenance Info
              </Link>
            </div>
          </div>
        )}

        {!loading && liveness && (
          <div
            className="rounded-xl border border-border bg-surface p-6"
            role="status"
            aria-live="polite"
          >
            <h2 className="text-lg font-semibold">Public Service Liveness</h2>
            <p className="mt-2 text-xl font-semibold">Operational</p>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-text-muted">
              <p>
                Response latency:{" "}
                <span className="font-medium text-text-main">{liveness.latencyMs} ms</span>
              </p>
              <p>Last update: {new Date(liveness.timestamp).toLocaleString()}</p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
