// Runs inside a plugin container whose egress proxy allows example.com:443 only (plugins.yml here),
// and only for a plugin call with a ticket the core signed (plugin contract 3.0): the proxy refuses
// a CONNECT to example.com without a ticket and with a forged one (407), and a public address is
// not reachable without the proxy. The tests of apps/api cover what a valid ticket lets through.
// Read from stdin: `node --input-type=module - < check-egress.mjs`.
/* global process, console, URL, Buffer */
import http from "node:http";
import net from "node:net";

const proxy = new URL(process.env.HTTPS_PROXY ?? "");
const timeoutMs = 15_000;

/** The proxy's answer to CONNECT `target`, and the tunnel if it opened one. */
function connect(target, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: target, headers });
    request.on("connect", (response, socket) => resolve({ status: response.statusCode, socket }));
    request.on("error", reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`CONNECT ${target} timed out`)));
    request.end();
  });
}

/** Whether a TCP connection to a public address (Cloudflare's 1.1.1.1, no DNS involved) opens. */
function reachesDirectly() {
  return new Promise((resolve) => {
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a public address on purpose, so no DNS is involved.
    const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 10_000 });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

async function main() {
  const without = await connect("example.com:443");
  without.socket.destroy();
  const forgedTicket = `${Buffer.from(JSON.stringify({ familyId: "x", sourceTypeId: "demo", sourceId: "x", expiresAt: Date.now() + 60_000, hosts: ["example.com:443"] })).toString("base64url")}.forged`;
  const forged = await connect("example.com:443", { "proxy-authorization": `Basic ${Buffer.from(`ticket:${forgedTicket}`).toString("base64")}` });
  forged.socket.destroy();
  const direct = await reachesDirectly();
  console.log({ withoutTicket: without.status, forgedTicket: forged.status, direct });
  if (without.status !== 407 || forged.status !== 407 || direct) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
