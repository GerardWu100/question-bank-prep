import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { runRipgrep } from "../apps/server/src/reading-routes.js";
import { AISettingsFile } from "../apps/ai-runtime/api-key.js";
import { calculate } from "../apps/calculator/index.js";

const hasRipgrep = (() => {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("internet-facing boundaries", () => {
  it("checks sign-in on the matched route, so an encoded /api path cannot skip it", async () => {
    const { app } = await buildApp({ password: "test-password" });
    try {
      for (const url of ["/%61pi/libraries", "/api/%6cibraries", "/%2561pi/libraries"]) {
        const response = await app.inject(url);
        expect(response.statusCode, url).not.toBe(200);
      }
      const write = await app.inject({ method: "POST", url: "/%61pi/libraries", payload: { name: "x" } });
      expect(write.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("sends security headers and limits password attempts", async () => {
    const { app } = await buildApp({ password: "test-password" });
    try {
      const response = await app.inject("/api/health");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      // Plain HTTP: no HSTS, which would lock a LAN address out of the browser.
      expect(response.headers["strict-transport-security"]).toBeUndefined();
      const statuses = [];
      for (let attempt = 0; attempt < 11; attempt++)
        statuses.push((await app.inject({ method: "POST", url: "/api/session", payload: { password: "wrong" } })).statusCode);
      expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("takes the client address from the one trusted proxy, not from the client", async () => {
    const { app } = await buildApp({ password: "test-password", trustProxy: true });
    app.get("/api/whoami", { config: { public: true } }, async (request) => ({ ip: request.ip, protocol: request.protocol }));
    try {
      const response = await app.inject({
        url: "/api/whoami",
        remoteAddress: "10.0.0.2",
        headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9", "x-forwarded-proto": "https" },
      });
      expect(response.json()).toEqual({ ip: "203.0.113.9", protocol: "https" });
      expect(response.headers["strict-transport-security"]).toContain("max-age=");
      // A client on the internet reaching the app directly: its forwarding headers are ignored.
      const direct = await app.inject({
        url: "/api/whoami",
        remoteAddress: "198.51.100.7",
        headers: { "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https" },
      });
      expect(direct.json()).toEqual({ ip: "198.51.100.7", protocol: "http" });
    } finally {
      await app.close();
    }
  });

  it("sends a saved API key only to the address it was saved for", async () => {
    const directory = await mkdtemp(join(tmpdir(), "study-key-test-"));
    try {
      const settings = new AISettingsFile(join(directory, "ai-settings.json"));
      settings.update({ connections: [{ id: "router", kind: "api", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-test-1234", models: ["m"] }] });
      expect(() =>
        settings.update({ connections: [{ id: "router", kind: "api", baseUrl: "https://attacker.example/v1", models: ["m"] }] }),
      ).toThrow("Enter the API key again");
      expect(() =>
        settings.update({ connections: [{ id: "x", kind: "api", baseUrl: "http://169.254.169.254/latest", apiKey: "", models: ["m"] }] }),
      ).toThrow("link-local");
      // Same address, no key sent: the saved key stays.
      expect(settings.update({ connections: [{ id: "router", kind: "api", baseUrl: "https://openrouter.ai/api/v1", models: ["m2"] }] }).connections[0].apiKeySaved).toBe(true);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it.skipIf(!hasRipgrep)("refuses ripgrep options outside the allow-list", async () => {
    const root = await mkdtemp(join(tmpdir(), "study-rg-test-"));
    try {
      await writeFile(join(root, "notes.md"), "duration and -rate\n");
      for (const args of [
        ["--hostname-bin=/usr/bin/id", "--hyperlink-format=file://{host}{path}", "x"],
        ["--hostname-bin", "/usr/bin/id", "x"],
        ["--pre=cat", "x"],
        ["-f", "secrets.txt"],
        ["-nz", "x"],
        ["-L", "x"],
      ])
        await expect(runRipgrep(root, args), args.join(" ")).rejects.toThrow("Argument not allowed");
      expect((await runRipgrep(root, ["-n", "-i", "-C", "2", "DURATION"])).output).toContain("duration");
      expect((await runRipgrep(root, ["-e", "-rate", "--glob", "*.md"])).output).toContain("-rate");
      expect((await runRipgrep(root, ["--", "-rate"])).output).toContain("-rate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps calculator code away from host files even past the Python filter", async () => {
    const escape = "import statistics\nm = statistics.sys.modules['importlib'].import_module('js')\nresult = str(m.process.getBuiltinModule('fs').readFileSync('/etc/hostname'))";
    expect((await calculate({ code: escape })).status).toBe("failed");
    const frames = "def g():\n    yield h.gi_frame.f_back\nh = g()\nresult = str(next(h))";
    expect((await calculate({ code: frames })).status).toBe("failed");
    expect((await calculate({ code: "import statistics\nresult = statistics.mean([1, 2, 3])" })).values.result).toBe(2);
  }, 60_000);
});
