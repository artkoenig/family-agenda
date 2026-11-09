// Runs inside a plugin container whose egress proxy allows example.com:443 only (plugins.yml here):
// a TLS round trip to example.com through the proxy succeeds, the proxy refuses example.org, and a
// public address is not reachable without the proxy. Read from stdin: `node --input-type=module - < check-egress.mjs`.
/* global process, console, URL */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

const proxy = new URL(process.env.HTTPS_PROXY ?? "");
const timeoutMs = 15_000;

/** The proxy's answer to CONNECT `target`, and the tunnel if it opened one. */
function connect(target) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: target });
    request.on("connect", (response, socket) => resolve({ status: response.statusCode, socket }));
    request.on("error", reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`CONNECT ${target} timed out`)));
    request.end();
  });
}

/** The status line of GET / over TLS through `socket`, checking example.com's certificate. */
function httpsThrough(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => {
      secure.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let received = "";
    secure.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\r\n")) {
        resolve(received.split("\r\n")[0]);
        secure.destroy();
      }
    });
    secure.on("error", reject);
    secure.setTimeout(timeoutMs, () => secure.destroy(new Error("TLS round trip timed out")));
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
  const allowed = await connect("example.com:443");
  const statusLine = allowed.status === 200 ? await httpsThrough(allowed.socket, "example.com") : null;
  const other = await connect("example.org:443");
  other.socket.destroy();
  const direct = await reachesDirectly();
  console.log({ allowed: allowed.status, statusLine, other: other.status, direct });
  if (allowed.status !== 200 || !statusLine?.startsWith("HTTP/1.1 ") || other.status !== 403 || direct) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
