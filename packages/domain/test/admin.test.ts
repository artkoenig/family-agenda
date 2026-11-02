import { describe, it, expect } from "vitest";
import { parseEmail, isAcceptablePassword, minimumPasswordLength } from "../src/admin";

describe("parseEmail", () => {
  it("accepts a valid email", () => {
    expect(parseEmail("alice@example.com")).toBe("alice@example.com");
  });

  it("lowercases the email", () => {
    expect(parseEmail("Alice@Example.COM")).toBe("alice@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(parseEmail("  alice@example.com  ")).toBe("alice@example.com");
  });

  it("returns null for no @ sign", () => {
    expect(parseEmail("alice.example.com")).toBe(null);
  });

  it("returns null for multiple @ signs", () => {
    expect(parseEmail("alice@@example.com")).toBe(null);
  });

  it("returns null for spaces inside", () => {
    expect(parseEmail("alice @example.com")).toBe(null);
  });

  it("returns null for empty string", () => {
    expect(parseEmail("")).toBe(null);
  });

  it("returns null for whitespace-only", () => {
    expect(parseEmail("   ")).toBe(null);
  });

  it("returns null for @ at start", () => {
    expect(parseEmail("@example.com")).toBe(null);
  });

  it("returns null for @ at end", () => {
    expect(parseEmail("alice@")).toBe(null);
  });

  it("returns null when there is text before the @", () => {
    expect(parseEmail("foo bar@baz.com")).toBe(null);
  });

  it("returns null when there is trailing text after the domain", () => {
    expect(parseEmail("user@example.com extra")).toBe(null);
  });
});

describe("isAcceptablePassword", () => {
  it("accepts a password at the minimum length", () => {
    expect(isAcceptablePassword("a".repeat(minimumPasswordLength))).toBe(true);
  });

  it("accepts a password longer than the minimum", () => {
    expect(isAcceptablePassword("a".repeat(minimumPasswordLength + 1))).toBe(true);
  });

  it("rejects a password one character short", () => {
    expect(isAcceptablePassword("a".repeat(minimumPasswordLength - 1))).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(isAcceptablePassword("")).toBe(false);
  });
});
