/**
 * Just enough multicast DNS (RFC 6762) to make the Instance reachable by a name on the home
 * network, such as `family-agenda.local`: it answers A queries for one name and nothing else.
 */

const typeA = 1;
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
  if (message.length < 12 || message.readUInt16BE(2) & 0x8000) return false;
  let offset = 12;
  for (let left = message.readUInt16BE(4); left > 0; left--) {
    const question = readName(message, offset);
    if (!question || question.next + 4 > message.length) return false;
    if (questionAsksFor(message, question, hostname)) return true;
    offset = question.next + 4;
  }
  return false;
}

function questionAsksFor(message: Buffer, question: { name: string; next: number }, hostname: string): boolean {
  const type = message.readUInt16BE(question.next);
  const questionClass = message.readUInt16BE(question.next + 2) & ~cacheFlush;
  return question.name.toLowerCase() === hostname && (type === typeA || type === typeAny) && questionClass === classIn;
}

/** The response that tells `hostname` is at `addresses`. */
export function answerWith(hostname: string, addresses: string[]): Buffer {
  const name = Buffer.concat([
    ...hostname.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // a response, and an authoritative one
  header.writeUInt16BE(addresses.length, 6);
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
