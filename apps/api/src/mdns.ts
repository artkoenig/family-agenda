/**
 * Just enough multicast DNS (RFC 6762) to make the Instance reachable by a name on the home
 * network, such as `family-agenda.local`: it answers A queries for one name and nothing else. It has
 * no IPv6 address, which it says outright, so that a client asking for one does not wait for a timeout.
 */

const typeA = 1;
const typeAaaa = 28;
const typeNsec = 47;
const typeAny = 255;
const classIn = 1;
/** Tells caches that this record replaces what they hold for the name. */
const cacheFlush = 0x8000;
const timeToLive = 120;

export type Ipv4Interface = { address: string; netmask: string };

const octetsOf = (address: string) => address.split(".").map(Number);

const numberOf = (address: string) => octetsOf(address).reduce((sum, octet) => sum * 256 + octet, 0);

/** The addresses of the interfaces whose network the sender is on, which is where it can reach us. */
export function addressesFacing(sender: string, interfaces: Ipv4Interface[]): string[] {
  const from = numberOf(sender);
  return interfaces
    .filter(({ address, netmask }) => ((from ^ numberOf(address)) & numberOf(netmask)) === 0)
    .map(({ address }) => address);
}

const maximumPointerJumps = 8;

type NamePart = { kind: "end" } | { kind: "label"; text: string; after: number } | { kind: "pointer"; target: number };

/** The part of a name at `offset`: its end, a label, or a compression pointer; null if it is malformed. */
function namePartAt(message: Buffer, offset: number): NamePart | null {
  const length = message[offset];
  if (length === undefined) return null;
  if (length === 0) return { kind: "end" };
  if ((length & 0xc0) === 0xc0) {
    const low = message[offset + 1];
    return low === undefined ? null : { kind: "pointer", target: ((length & 0x3f) << 8) | low };
  }
  if (length > 63 || offset + 1 + length > message.length) return null;
  return { kind: "label", text: message.toString("utf8", offset + 1, offset + 1 + length), after: offset + 1 + length };
}

/** Reads a name at `offset`, following compression pointers; `next` is where the message goes on. */
function readName(message: Buffer, start: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let offset = start;
  let next: number | null = null;
  for (let jumps = 0; jumps <= maximumPointerJumps; ) {
    const part = namePartAt(message, offset);
    if (part === null) return null;
    if (part.kind === "end") return { name: labels.join("."), next: next ?? offset + 1 };
    if (part.kind === "label") {
      labels.push(part.text);
      offset = part.after;
    } else {
      next ??= offset + 2;
      offset = part.target;
      jumps++;
    }
  }
  return null;
}

/** Whether a DNS message is a query that asks for the address of `hostname`. */
export function asksFor(message: Buffer, hostname: string): boolean {
  return asksAbout(message, hostname, [typeA, typeAny]);
}

/** Whether a DNS message is a query that asks for an IPv6 address of `hostname`. */
export function asksForIpv6(message: Buffer, hostname: string): boolean {
  return asksAbout(message, hostname, [typeAaaa]);
}

function asksAbout(message: Buffer, hostname: string, types: number[]): boolean {
  if (message.length < 12 || message.readUInt16BE(2) & 0x8000) return false;
  let offset = 12;
  for (let left = message.readUInt16BE(4); left > 0; left--) {
    const question = readName(message, offset);
    if (!question || question.next + 4 > message.length) return false;
    if (questionAsksFor(message, question, hostname, types)) return true;
    offset = question.next + 4;
  }
  return false;
}

function questionAsksFor(
  message: Buffer,
  question: { name: string; next: number },
  hostname: string,
  types: number[],
): boolean {
  const type = message.readUInt16BE(question.next);
  const questionClass = message.readUInt16BE(question.next + 2) & ~cacheFlush;
  return question.name.toLowerCase() === hostname && types.includes(type) && questionClass === classIn;
}

const encodedName = (hostname: string) =>
  Buffer.concat([
    ...hostname.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);

/** A response header with `answers` records; it is an authoritative one. */
function responseHeader(answers: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(answers, 6);
  return header;
}

/** The response that tells `hostname` is at `addresses`. */
export function answerWith(hostname: string, addresses: string[]): Buffer {
  const name = encodedName(hostname);
  const header = responseHeader(addresses.length);
  const records = addresses.map((address) => {
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(typeA, 0);
    fixed.writeUInt16BE(classIn | cacheFlush, 2);
    fixed.writeUInt32BE(timeToLive, 4);
    fixed.writeUInt16BE(4, 8);
    return Buffer.concat([name, fixed, Buffer.from(octetsOf(address))]);
  });
  return Buffer.concat([header, ...records]);
}

/** The window, length and bitmap of an NSEC record that lists only the A record (type 1). */
const onlyTypeA = Buffer.from([0, 1, 0x40]);

/** The response that tells `hostname` has no IPv6 address: an NSEC record that lists only A (RFC 6762 section 6.1). */
export function denyIpv6(hostname: string): Buffer {
  const name = encodedName(hostname);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(typeNsec, 0);
  fixed.writeUInt16BE(classIn | cacheFlush, 2);
  fixed.writeUInt32BE(timeToLive, 4);
  fixed.writeUInt16BE(name.length + onlyTypeA.length, 8);
  return Buffer.concat([responseHeader(1), name, fixed, name, onlyTypeA]);
}
