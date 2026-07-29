export interface PublicStatusLiveness {
  status: "ok";
  timestamp: string;
  latencyMs: number;
}

interface PublicStatusLivenessError {
  status?: string;
  error?: string;
}

export async function fetchPublicStatusLiveness(): Promise<PublicStatusLiveness> {
  const response = await fetch("/api/health/ping", { cache: "no-store" });
  const payload = (await response.json()) as PublicStatusLiveness | PublicStatusLivenessError;

  if (!response.ok || payload.status !== "ok") {
    const message = "error" in payload ? payload.error : undefined;
    throw new Error(message || "Failed to load service liveness.");
  }

  return payload;
}
