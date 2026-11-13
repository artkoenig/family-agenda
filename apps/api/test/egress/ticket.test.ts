import { describe, expect, it } from "vitest";
import { mintTicket, ticketOfProxyAuthorization, verifyTicket, type Ticket } from "../../src/egress/ticket";

const key = "a-ticket-key-of-at-least-32-characters";
const ticket: Ticket = { familyId: "family-1", sourceTypeId: "imap", sourceId: "source-1", expiresAt: 2_000, hosts: null };

describe("a ticket", () => {
  it("verifies with the key it was minted with until it expires", () => {
    const minted = mintTicket(key, ticket);
    expect(verifyTicket(key, minted, 1_999)).toEqual(ticket);
    expect(verifyTicket(key, minted, 2_000)).toBeNull();
  });

  it("carries the hosts of a Source that is not stored", () => {
    const unstored = { ...ticket, hosts: ["imap.example.org:993"] };
    expect(verifyTicket(key, mintTicket(key, unstored), 0)).toEqual(unstored);
  });

  it("is refused with another key", () => {
    expect(verifyTicket("another-ticket-key-of-at-least-32-chars", mintTicket(key, ticket), 0)).toBeNull();
  });

  it("is refused when tampered with", () => {
    const [, signature] = mintTicket(key, ticket).split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...ticket, sourceId: "source-2" })).toString("base64url")}.${signature}`;
    expect(verifyTicket(key, forged, 0)).toBeNull();
  });

  it.each([["", "nothing"], ["abc", "no signature"], ["abc.def", "a wrong signature"], ["..", "empty parts"]])("is refused for %j (%s)", (text) => {
    expect(verifyTicket(key, text, 0)).toBeNull();
  });
});

describe("ticketOfProxyAuthorization", () => {
  it("reads the password of Basic credentials, as clients send a proxy URL's", () => {
    expect(ticketOfProxyAuthorization(`Basic ${Buffer.from("ticket:abc.def").toString("base64")}`)).toBe("abc.def");
  });

  it("reads a Bearer token", () => {
    expect(ticketOfProxyAuthorization("Bearer abc.def")).toBe("abc.def");
  });

  it.each([undefined, "", "Basic", "Basic !!!", `Basic ${Buffer.from("no-colon").toString("base64")}`, `Basic ${Buffer.from("user:").toString("base64")}`, "Digest abc"])(
    "finds none in %j",
    (header) => {
      expect(ticketOfProxyAuthorization(header)).toBeNull();
    },
  );
});
