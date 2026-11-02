import { describe, it, expect } from "vitest";
import { sourceStatus, failingAfterMs, silentAfterMs, type SourceFailure } from "../src/source";

const now = new Date("2026-06-15T12:00:00Z");

describe("sourceStatus", () => {
  it("returns 'ok' when no failure and no silent", () => {
    const result = sourceStatus({
      failure: null,
      silentApplies: false,
      lastNewOriginAt: now,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      now,
    });
    expect(result).toBe("ok");
  });

  it("returns 'failing' for a definite failure", () => {
    const failure: SourceFailure = { kind: "definite", message: "auth error", since: now };
    const result = sourceStatus({
      failure,
      silentApplies: false,
      lastNewOriginAt: now,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      now,
    });
    expect(result).toBe("failing");
  });

  it("returns 'ok' for a temporary failure within the threshold", () => {
    const since = new Date(now.getTime() - 1000);
    const failure: SourceFailure = { kind: "temporary", message: "timeout", since };
    const result = sourceStatus({
      failure,
      silentApplies: false,
      lastNewOriginAt: now,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      now,
    });
    expect(result).toBe("ok");
  });

  it("returns 'failing' for a temporary failure past the threshold", () => {
    const since = new Date(now.getTime() - failingAfterMs - 1000);
    const failure: SourceFailure = { kind: "temporary", message: "timeout", since };
    const result = sourceStatus({
      failure,
      silentApplies: false,
      lastNewOriginAt: now,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      now,
    });
    expect(result).toBe("failing");
  });

  it("returns 'failing' for a temporary failure exactly at the threshold", () => {
    const since = new Date(now.getTime() - failingAfterMs);
    const failure: SourceFailure = { kind: "temporary", message: "timeout", since };
    const result = sourceStatus({
      failure,
      silentApplies: false,
      lastNewOriginAt: now,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      now,
    });
    expect(result).toBe("failing");
  });

  it("returns 'silent' when silentApplies and no new origin past threshold", () => {
    const createdAt = new Date(now.getTime() - silentAfterMs - 1000);
    const result = sourceStatus({
      failure: null,
      silentApplies: true,
      lastNewOriginAt: null,
      createdAt,
      now,
    });
    expect(result).toBe("silent");
  });

  it("returns 'ok' when silentApplies but last origin is recent", () => {
    const lastNewOriginAt = new Date(now.getTime() - 1000);
    const result = sourceStatus({
      failure: null,
      silentApplies: true,
      lastNewOriginAt,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      now,
    });
    expect(result).toBe("ok");
  });

  it("falls back to createdAt when lastNewOriginAt is null", () => {
    const createdAt = new Date(now.getTime() - 1000);
    const result = sourceStatus({
      failure: null,
      silentApplies: true,
      lastNewOriginAt: null,
      createdAt,
      now,
    });
    expect(result).toBe("ok");
  });

  it("returns 'ok' when silentApplies is false even if no new origin", () => {
    const createdAt = new Date(now.getTime() - silentAfterMs - 100000);
    const result = sourceStatus({
      failure: null,
      silentApplies: false,
      lastNewOriginAt: null,
      createdAt,
      now,
    });
    expect(result).toBe("ok");
  });
});

describe("source thresholds", () => {
  it("failingAfterMs is 6 hours in milliseconds", () => {
    expect(failingAfterMs).toBe(6 * 60 * 60 * 1000);
  });

  it("silentAfterMs is 14 days in milliseconds", () => {
    expect(silentAfterMs).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("returns 'silent' when exactly silentAfterMs has elapsed since last origin", () => {
    const lastNewOriginAt = new Date(now.getTime() - silentAfterMs);
    const result = sourceStatus({
      failure: null,
      silentApplies: true,
      lastNewOriginAt,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      now,
    });
    expect(result).toBe("silent");
  });
});
