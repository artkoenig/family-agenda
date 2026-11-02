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

  it.each(["172.15.0.1", "8.168.0.1", "192.169.0.1", "8.254.0.1"])("%s is not (IPv4 boundary)", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });

  it.each(["172.16.0.1", "172.31.0.1", "169.254.0.1"])("%s is (IPv4 boundary)", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each(["x10.0.0.1", "10.0.0.1x"])("%s is not (IPv4 regex anchor)", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });

  it("10.0.10.1 is on the home network (IPv4 with 2-digit octet)", () => {
    expect(isLocalHost("10.0.10.1")).toBe(true);
  });

  it.each(["10.0.0.1.", "localhost."])("%s is on the home network (trailing dot)", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each(["[::1]x", "[127.0.0.1]x"])("%s is not (bracket regex anchor)", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });

  it.each(["2001:fd12::1", "2001:fe80::1"])("%s is not (IPv6 regex anchor)", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });

  it.each(["fe80::1", "fe8::1"])("%s is on the home network (link-local)", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it("an empty string is not a local host", () => {
    expect(isLocalHost("")).toBe(false);
  });

  it.each(["lan", "internal", "local"])("%s is a local host (exact suffix match)", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it("a random word without a dot is a local host", () => {
    expect(isLocalHost("Stryker was here!")).toBe(true);
  });
});
