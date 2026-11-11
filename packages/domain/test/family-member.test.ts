import { describe, it, expect } from "vitest";
import { parseName, initialOf, maximumNameLength, parseColour, nextColour, parseAvatar, memberAvatars } from "../src/family-member";

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

describe("parseColour", () => {
  it("accepts the numbers 1 to 8", () => {
    expect(parseColour("1")).toBe(1);
    expect(parseColour(" 8 ")).toBe(8);
  });

  it("refuses anything else", () => {
    expect(parseColour("0")).toBe(null);
    expect(parseColour("9")).toBe(null);
    expect(parseColour("")).toBe(null);
    expect(parseColour("red")).toBe(null);
    expect(parseColour("1.0")).toBe(null);
  });
});

describe("nextColour", () => {
  it("starts with the first colour", () => {
    expect(nextColour([])).toBe(1);
  });

  it("takes the lowest colour no one has", () => {
    expect(nextColour([1, 2, 4])).toBe(3);
  });

  it("takes the least used colour once all are taken", () => {
    expect(nextColour([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 4])).toBe(3);
  });

  it("takes the lowest colour when all are used as often", () => {
    expect(nextColour([8, 7, 6, 5, 4, 3, 2, 1])).toBe(1);
  });
});

describe("parseAvatar", () => {
  it("accepts every known animal", () => {
    for (const avatar of memberAvatars) expect(parseAvatar(` ${avatar} `)).toEqual({ ok: true, avatar });
  });

  it("takes an empty field as no animal", () => {
    expect(parseAvatar("")).toEqual({ ok: true, avatar: null });
    expect(parseAvatar("  ")).toEqual({ ok: true, avatar: null });
  });

  it("refuses an unknown animal", () => {
    expect(parseAvatar("dragon")).toEqual({ ok: false });
    expect(parseAvatar("../fox")).toEqual({ ok: false });
  });
});
