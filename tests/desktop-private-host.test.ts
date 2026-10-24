import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// The desktop wrapper is CommonJS outside the TypeScript workspace, so load it as main.cjs does.
const { isPrivateHost } = createRequire(import.meta.url)("../apps/desktop/private-host.cjs") as {
  isPrivateHost: (hostname: string) => boolean;
};
/** The check as Connect applies it: on the hostname the URL parser produced. */
const plainHttpAllowed = (address: string) => isPrivateHost(new URL(address).hostname);

describe("desktop plain-http host check", () => {
  it("accepts this computer, private networks and local names", () => {
    for (const address of [
      "http://localhost:6848",
      "http://127.0.0.1",
      "http://127.8.9.10",
      "http://0x7f.1", // the URL parser normalizes this to 127.0.0.1
      "http://10.1.2.3",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.1.20:6848",
      "http://169.254.10.10",
      "http://[::1]:6848",
      "http://[fd12:3456:789a::1]",
      "http://[fc00::1]",
      "http://[fe80::1]",
      "http://[::ffff:192.168.1.20]", // IPv4-mapped, parsed to [::ffff:c0a8:114]
      "http://[::ffff:127.0.0.1]",
      "http://nas",
      "http://study-server.local",
      "http://my.nas.local:6848",
    ])
      expect(plainHttpAllowed(address), address).toBe(true);
  });

  it("rejects internet addresses and names, IPv6 included", () => {
    for (const address of [
      "http://8.8.8.8",
      "http://172.32.0.1",
      "http://11.0.0.1",
      "http://100.64.0.1",
      "http://[2606:4700:4700::1111]",
      "http://[2001:db8::1]",
      "http://[::ffff:8.8.8.8]",
      "http://[::ffff:808:808]",
      "http://[::]",
      "http://study.example.com",
      "http://local.example.com",
    ])
      expect(plainHttpAllowed(address), address).toBe(false);
  });

  it("rejects malformed hosts that the URL parser does not produce", () => {
    for (const hostname of ["[::1", "::1", "fd00::1", "[127.0.0.1]", "[nas]", "a:b", "[]", ""])
      expect(isPrivateHost(hostname), hostname).toBe(false);
  });
});
