import { describe, expect, it } from "vitest";
import { addressesFacing, answerWith, asksFor, asksForIpv6, denyIpv6 } from "../src/mdns";

/** A DNS query for `name`, as a resolver sends it. */
function query(name: string, type = 1, questionClass = 1): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  const labels = name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(questionClass, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}

describe("multicast DNS", () => {
  it("is asked for the address of its name, in any case, also with the unicast bit set", () => {
    expect(asksFor(query("family-agenda.local"), "family-agenda.local")).toBe(true);
    expect(asksFor(query("Family-Agenda.LOCAL"), "family-agenda.local")).toBe(true);
    expect(asksFor(query("family-agenda.local", 255), "family-agenda.local")).toBe(true);
    expect(asksFor(query("family-agenda.local", 1, 0x8001), "family-agenda.local")).toBe(true);
  });

  it("ignores other names, other record types and responses", () => {
    expect(asksFor(query("printer.local"), "family-agenda.local")).toBe(false);
    expect(asksFor(query("family-agenda.local", 28), "family-agenda.local")).toBe(false);
    const response = query("family-agenda.local");
    response.writeUInt16BE(0x8400, 2);
    expect(asksFor(response, "family-agenda.local")).toBe(false);
    expect(asksFor(Buffer.from([1, 2, 3]), "family-agenda.local")).toBe(false);
  });

  it("follows compression pointers in a question name", () => {
    // The second question's name points back at the first one's, at offset 12.
    const header = Buffer.alloc(12);
    header.writeUInt16BE(2, 4);
    const first = query("printer.local").subarray(12);
    const second = Buffer.concat([Buffer.from([0xc0, 12]), Buffer.from([0, 1, 0, 1])]);
    expect(asksFor(Buffer.concat([header, first, second]), "printer.local")).toBe(true);
  });

  it("ignores a query with a malformed name", () => {
    const hostname = "family-agenda.local";
    const withName = (name: number[], tail = [0, 1, 0, 1]) => {
      const header = Buffer.alloc(12);
      header.writeUInt16BE(1, 4);
      return Buffer.concat([header, Buffer.from([...name, ...tail])]);
    };
    // A label running past the end of the message.
    expect(asksFor(withName([9, 97]), hostname)).toBe(false);
    // A label longer than 63 octets.
    expect(asksFor(withName([64, ...new Array<number>(64).fill(97), 0]), hostname)).toBe(false);
    // A pointer without its second octet.
    expect(asksFor(withName([0xc0], []), hostname)).toBe(false);
    // A pointer that points at itself, which never ends.
    expect(asksFor(withName([0xc0, 12]), hostname)).toBe(false);
    // A name without its type and class.
    expect(asksFor(withName([1, 97, 0], []), hostname)).toBe(false);
  });

  it("answers with an A record per address", () => {
    const answer = answerWith("family-agenda.local", ["192.168.1.10"]);
    expect(answer.readUInt16BE(2)).toBe(0x8400);
    expect(answer.readUInt16BE(6)).toBe(1);
    expect(answer.subarray(12, 12 + 20).toString("latin1")).toContain("family-agenda");
    expect([...answer.subarray(answer.length - 4)]).toEqual([192, 168, 1, 10]);
    // Class IN with the cache-flush bit, and a time to live of two minutes.
    const record = answer.length - 14;
    expect(answer.readUInt16BE(record + 2)).toBe(0x8001);
    expect(answer.readUInt32BE(record + 4)).toBe(120);
  });

  it("is asked for an IPv6 address of its name, which it has none of", () => {
    expect(asksForIpv6(query("family-agenda.local", 28), "family-agenda.local")).toBe(true);
    expect(asksForIpv6(query("Family-Agenda.LOCAL", 28, 0x8001), "family-agenda.local")).toBe(true);
    expect(asksForIpv6(query("family-agenda.local", 1), "family-agenda.local")).toBe(false);
    expect(asksForIpv6(query("printer.local", 28), "family-agenda.local")).toBe(false);
  });

  it("denies an IPv6 address with an NSEC record that lists only the A record (RFC 6762 section 6.1)", () => {
    const denial = denyIpv6("family-agenda.local");
    expect(denial.readUInt16BE(2)).toBe(0x8400);
    expect(denial.readUInt16BE(6)).toBe(1);
    const name = Buffer.from("\x0dfamily-agenda\x05local\x00", "latin1");
    expect(denial.subarray(12, 12 + name.length)).toEqual(name);
    const record = 12 + name.length;
    expect(denial.readUInt16BE(record)).toBe(47);
    expect(denial.readUInt16BE(record + 2)).toBe(0x8001);
    expect(denial.readUInt32BE(record + 4)).toBe(120);
    // The data is the next name, here the same one, then a bitmap of window 0, one octet long, with A set.
    expect(denial.readUInt16BE(record + 8)).toBe(name.length + 3);
    expect(denial.subarray(record + 10)).toEqual(Buffer.concat([name, Buffer.from([0, 1, 0x40])]));
  });

  it("offers only the addresses on the network of whoever asks", () => {
    const interfaces = [
      { address: "192.168.1.10", netmask: "255.255.255.0" },
      { address: "172.17.0.1", netmask: "255.255.0.0" },
    ];
    expect(addressesFacing("192.168.1.42", interfaces)).toEqual(["192.168.1.10"]);
    expect(addressesFacing("172.17.0.5", interfaces)).toEqual(["172.17.0.1"]);
    expect(addressesFacing("10.0.0.7", interfaces)).toEqual([]);
  });
});
