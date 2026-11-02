import { describe, it, expect } from "vitest";
import { parseName, initialOf, maximumNameLength } from "../src/family-member";

describe("parseName", () => {
  it("returns the trimmed name", () => {
    expect(parseName("  Alice  ")).toBe("Alice");
  });

  it("returns the name as-is when no surrounding whitespace", () => {
    expect(parseName("Bob")).toBe("Bob");
  });

  it("returns null for empty string", () => {
    expect(parseName("")).toBe(null);
  });

  it("returns null for whitespace-only string", () => {
    expect(parseName("   ")).toBe(null);
  });

  it("returns null when too long", () => {
    expect(parseName("a".repeat(maximumNameLength + 1))).toBe(null);
  });

  it("returns the name at exactly the maximum length", () => {
    const name = "a".repeat(maximumNameLength);
    expect(parseName(name)).toBe(name);
  });

  it("trims before checking length", () => {
    // 40 chars + surrounding spaces = 42 raw, but 40 after trim
    const name = "a".repeat(maximumNameLength);
    expect(parseName(`  ${name}  `)).toBe(name);
  });
});

describe("initialOf", () => {
  it("returns the uppercased first letter", () => {
    expect(initialOf("Alice")).toBe("A");
  });

  it("returns uppercase for lowercase input", () => {
    expect(initialOf("bob")).toBe("B");
  });

  it("returns empty string for empty name", () => {
    expect(initialOf("")).toBe("");
  });

  it("returns the first character of a multi-word name", () => {
    expect(initialOf("Mary Jane")).toBe("M");
  });
});
