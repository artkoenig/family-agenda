import { describe, expect, it } from "vitest";
import { newId } from "../src/id";

describe("newId", () => {
  it("is a UUID of version 7 that starts with the milliseconds it was made at", () => {
    const id = newId(Date.UTC(2026, 8, 14, 7));

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(Date.UTC(2026, 8, 14, 7));
  });

  it("sorts ids made later after earlier ones", () => {
    const ids = [newId(1_000), newId(2_000), newId(1_000_000_000_000)];

    expect([...ids].sort()).toEqual(ids);
  });
});
