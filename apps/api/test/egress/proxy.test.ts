import { once } from "node:events";
import { request, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressProxy, targetOf, type AllowlistFetch } from "../../src/egress/proxy";

const servers: (Server | TcpServer)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listening(server: Server | TcpServer): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** An upstream that answers every connection with "hello" and echoes what it gets. */
async function upstream(): Promise<number> {
  const server = createTcpServer();
  server.on("connection", (socket) => {
    socket.write("hello");
    socket.pipe(socket);
  });
  return listening(server);
}

/** Sends CONNECT to the proxy and resolves with the status line and the bytes after it. */
async function connectThrough(proxyPort: number, authority: string, send = ""): Promise<{ status: string; body: string }> {
  const socket = connect(proxyPort, "127.0.0.1");
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n${send}`);
  let received = "";
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString();
    if (received.includes("\r\n\r\nhello") && received.endsWith(send)) socket.end();
  });
  await once(socket, "close");
  const [head = "", body = ""] = received.split("\r\n\r\n");
  return { status: head.split("\r\n")[0] ?? "", body };
}

async function proxy(allowlist: AllowlistFetch): Promise<number> {
  const lines: string[] = [];
  return listening(createEgressProxy(allowlist, (line) => lines.push(line)));
}

describe("the egress proxy", () => {
  it("tunnels to an allowed host", async () => {
    const port = await upstream();
    const proxyPort = await proxy(() => Promise.resolve([`127.0.0.1:${port}`]));

    expect(await connectThrough(proxyPort, `127.0.0.1:${port}`, "ping")).toEqual({ status: "HTTP/1.1 200 Connection Established", body: "helloping" });
  });

  it("refuses a host not allowed", async () => {
    const port = await upstream();
    const proxyPort = await proxy(() => Promise.resolve(["example.org:443"]));

    expect((await connectThrough(proxyPort, `127.0.0.1:${port}`)).status).toBe("HTTP/1.1 403 Forbidden");
  });

  it("fails closed when the allowlist cannot be fetched", async () => {
    const port = await upstream();
    const proxyPort = await proxy(() => Promise.reject(new Error("core down")));

    expect((await connectThrough(proxyPort, `127.0.0.1:${port}`)).status).toBe("HTTP/1.1 503 Service Unavailable");
  });

  it("answers 502 when the allowed host cannot be reached", async () => {
    const closed = await upstream();
    await new Promise((resolve) => servers.pop()?.close(resolve));
    const proxyPort = await proxy(() => Promise.resolve([`127.0.0.1:${closed}`]));

    expect((await connectThrough(proxyPort, `127.0.0.1:${closed}`)).status).toBe("HTTP/1.1 502 Bad Gateway");
  });

  it("refuses a malformed target and any plain request", async () => {
    const proxyPort = await proxy(() => Promise.resolve(["*"]));

    expect((await connectThrough(proxyPort, "no-port")).status).toBe("HTTP/1.1 400 Bad Request");
    const response = await new Promise<number | undefined>((resolve, reject) => {
      request({ host: "127.0.0.1", port: proxyPort, path: "http://example.org/" }, (answer) => {
        answer.resume();
        resolve(answer.statusCode);
      })
        .on("error", reject)
        .end();
    });
    expect(response).toBe(405);
  });
});

describe("targetOf", () => {
  it.each([
    ["example.org:443", { host: "example.org", port: 443 }],
    ["[::1]:8443", { host: "::1", port: 8443 }],
    ["example.org", null],
    ["example.org:0", null],
    ["example.org:70000", null],
  ])("%s", (authority, target) => {
    expect(targetOf(authority)).toEqual(target);
  });
});
