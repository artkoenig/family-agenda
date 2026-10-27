import { describe, expect, it } from "vitest";
import { isLocalHost } from "../src";

describe("a host", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]", "192.168.1.20", "10.0.0.5", "172.20.1.1", "ollama", "gpu.local", "llm.home.arpa", "host.docker.internal", "fd12::1"])(
    "%s is on the home network",
    (host) => {
      expect(isLocalHost(host)).toBe(true);
    },
  );

  it.each(["api.openai.com", "8.8.8.8", "172.32.0.1", "2001:db8::1", "local.example.com"])("%s is not", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });
});
