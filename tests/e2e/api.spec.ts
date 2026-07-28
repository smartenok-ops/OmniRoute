import { test, expect } from "@playwright/test";
import { gotoDashboardRoute } from "./helpers/dashboardAuth";

test.describe("API Health Checks", () => {
  test("GET /api/monitoring/health returns OK for an authenticated management session", async ({
    page,
  }) => {
    await gotoDashboardRoute(page, "/dashboard");
    const res = await page.request.get("/api/monitoring/health");
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("status");
  });

  test("GET /api/v1/models returns model list", async ({ request }) => {
    const res = await request.get("/api/v1/models");
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("data");
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("GET /api/providers returns provider list or requires auth", async ({ request }) => {
    const res = await request.get("/api/providers");
    // In CI with auth enabled, 401 is acceptable — endpoint is reachable
    if (res.ok()) {
      const body = (await res.json()) as any;
      expect(body).toHaveProperty("connections");
      expect(Array.isArray(body.connections)).toBe(true);
    } else {
      expect([401, 403, 307]).toContain(res.status());
    }
  });
});
