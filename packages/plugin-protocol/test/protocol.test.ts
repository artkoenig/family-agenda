import { describe, expect, it } from "vitest";
import { SourceError } from "@family-agenda/source-sdk";
import { decode, encode, failureOf, isCallName } from "../src";

const roundTrip = (value: unknown) => decode(encode(value));

describe("the Plugin Host wire protocol", () => {
  it("keeps dates and binary data through a round-trip", () => {
    const value = { occurredAt: new Date("2026-09-14T07:00:00Z"), attachments: [{ bytes: new Uint8Array([0, 1, 255]) }] };

    const back = roundTrip(value) as typeof value;

    expect(back.occurredAt).toBeInstanceOf(Date);
    expect(back.occurredAt.toISOString()).toBe("2026-09-14T07:00:00.000Z");
    expect(back.attachments[0]?.bytes).toBeInstanceOf(Uint8Array);
    expect([...(back.attachments[0]?.bytes ?? [])]).toEqual([0, 1, 255]);
  });

  it("keeps a slice of a larger buffer as only that slice", () => {
    const bytes = new Uint8Array([9, 8, 7, 6]).subarray(1, 3);

    expect([...(roundTrip(bytes) as Uint8Array)]).toEqual([8, 7]);
  });

  it("gives back a plugin's own object that looks like a tag as it was", () => {
    const value = { a: { $date: "not a date" }, b: { $bytes: "x" }, c: { $plain: { $date: "y" } } };

    expect(roundTrip(value)).toEqual(value);
  });

  it("leaves plain JSON alone and drops undefined fields", () => {
    expect(roundTrip({ text: "a", n: 1, flag: true, none: null, list: ["x", 2], gone: undefined })).toEqual({ text: "a", n: 1, flag: true, none: null, list: ["x", 2] });
  });

  it("tells a Source error from any other failure", () => {
    expect(failureOf(SourceError.definite("wrong password"))).toEqual({ sourceError: "definite", message: "wrong password" });
    expect(failureOf(SourceError.temporary("timeout"))).toEqual({ sourceError: "temporary", message: "timeout" });
    expect(failureOf(Object.assign(new Error("odd"), { name: "SourceError", kind: "other" }))).toEqual({ sourceError: null, message: "odd" });
    expect(failureOf(new TypeError("boom"))).toEqual({ sourceError: null, message: "boom" });
    expect(failureOf("thrown text")).toEqual({ sourceError: null, message: "thrown text" });
  });

  it("knows its call names", () => {
    expect(isCallName("poll")).toBe(true);
    expect(isCallName("constructor")).toBe(false);
  });
});
