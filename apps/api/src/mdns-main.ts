import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { addressesFacing, answerWith, asksFor, asksForIpv6, denyIpv6, type Ipv4Interface } from "./mdns";

/**
 * Makes the Instance reachable by `MDNS_NAME` on the home network, like `homeassistant.local`. It
 * runs in the host's network namespace (see `compose.yaml`), where the interfaces are the host's own.
 */
const hostname = (process.env.MDNS_NAME ?? "family-agenda.local").toLowerCase();
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- the standard mDNS multicast address (RFC 6762)
const group = "224.0.0.251";
const port = 5353;

const interfaces = (): Ipv4Interface[] =>
  Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map(({ address, netmask }) => ({ address, netmask }));

// Address reuse, so that an Avahi or systemd-resolved already on the host does not keep us out.
const socket = createSocket({ type: "udp4", reuseAddr: true });

const join = () => {
  for (const { address } of interfaces()) {
    try {
      socket.addMembership(group, address);
    } catch {
      // Already a member of the group on this interface, or the interface cannot multicast.
    }
  }
};

socket.on("message", (message, sender) => {
  const answers = asksFor(message, hostname);
  if (!answers && !asksForIpv6(message, hostname)) return;
  const addresses = addressesFacing(sender.address, interfaces());
  const [first] = addresses;
  if (!first) return;
  socket.setMulticastInterface(first);
  socket.send(answers ? answerWith(hostname, addresses) : denyIpv6(hostname), port, group);
});

socket.on("error", (error) => {
  console.error(`mDNS failed: ${error.message}`);
  process.exit(1);
});

socket.bind(port, () => {
  socket.setMulticastTTL(255);
  join();
  // Interfaces come and go, such as with a DHCP renewal or a cable plugged in later.
  setInterval(join, 60_000).unref();
  console.log(`Family Agenda answers to ${hostname} on the home network`);
});

process.on("SIGTERM", () => socket.close(() => process.exit(0)));
