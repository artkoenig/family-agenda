import { once } from "node:events";
import { request, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressProxy, isPublicAddress, targetOf, type AllowlistFetch, type EgressProxyOptions } from "../../src/egress/proxy";

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

async function proxy(allowlist: AllowlistFetch, options: Partial<EgressProxyOptions> = { isReachable: () => true }): Promise<number> {
  return listening(createEgressProxy({ allowlist, log: () => {}, ...options }));
}

describe("the egress proxy", () => {
  it("tunnels to an allowed host", async () => {
    const port = await upstream();
    const proxyPort = await proxy(() => Promise.resolve([`127.0.0.1:${port}`]));

    expect(await connectThrough(proxyPort, `127.0.0.1:${port}`, "ping")).toEqual({ status: "HTTP/1.1 200 Connection Established", body: "helloping" });
  });

  it("tunnels an allowed name to the address it resolves to", async () => {
    const port = await upstream();
    const proxyPort = await proxy(() => Promise.resolve([`api.example.com:${port}`]), { resolve: () => Promise.resolve(["127.0.0.1"]), isReachable: () => true });

    expect((await connectThrough(proxyPort, `api.example.com:${port}`)).status).toBe("HTTP/1.1 200 Connection Established");
  });

  it("refuses a host not allowed", async () => {
    const port = await upstream();
    const proxyPort = await proxy(() => Promise.resolve(["example.org:443"]));

    expect((await connectThrough(proxyPort, `127.0.0.1:${port}`)).status).toBe("HTTP/1.1 403 Forbidden");
  });

  it("refuses an allowed internal address by default", async () => {
    const proxyPort = await proxy(() => Promise.resolve(["127.0.0.1:8080", "10.0.0.1:80"]), {});

    expect((await connectThrough(proxyPort, "127.0.0.1:8080")).status).toBe("HTTP/1.1 403 Forbidden");
    expect((await connectThrough(proxyPort, "10.0.0.1:80")).status).toBe("HTTP/1.1 403 Forbidden");
  });

  it("refuses an allowed name that resolves to an internal address", async () => {
    const proxyPort = await proxy(() => Promise.resolve(["rebind.example.com:443"]), { resolve: () => Promise.resolve(["93.184.216.34", "192.168.1.5"]) });

    expect((await connectThrough(proxyPort, "rebind.example.com:443")).status).toBe("HTTP/1.1 403 Forbidden");
  });

  it("answers 502 when an allowed name does not resolve", async () => {
    const proxyPort = await proxy(() => Promise.resolve(["gone.example.com:443"]), { resolve: () => Promise.reject(new Error("ENOTFOUND")) });

    expect((await connectThrough(proxyPort, "gone.example.com:443")).status).toBe("HTTP/1.1 502 Bad Gateway");
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

  it("refuses a malformed target, a single-label name and any plain request", async () => {
    const proxyPort = await proxy(() => Promise.resolve(["api:3001"]));

    expect((await connectThrough(proxyPort, "no-port")).status).toBe("HTTP/1.1 400 Bad Request");
    expect((await connectThrough(proxyPort, "api:3001")).status).toBe("HTTP/1.1 400 Bad Request");
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
    ["Example.ORG:443", { host: "example.org", port: 443 }],
    ["[::1]:8443", { host: "::1", port: 8443 }],
    ["[1.2.3.4]:8443", null],
    ["10.0.0.1:80", { host: "10.0.0.1", port: 80 }],
    ["api:3001", null],
    ["example.org", null],
    ["example.org:0", null],
    ["example.org:70000", null],
  ])("%s", (authority, target) => {
    expect(targetOf(authority)).toEqual(target);
  });
});

describe("isPublicAddress", () => {
  it.each([
    ["93.184.216.34", true],
    ["2606:2800:220:1:248:1893:25c8:1946", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.17.0.2", false],
    ["192.168.0.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["224.0.0.1", false],
    ["::1", false],
    ["::", false],
    ["::ffff:127.0.0.1", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["not-an-ip", false],
  ])("%s → %s", (address, isPublic) => {
    expect(isPublicAddress(address)).toBe(isPublic);
  });
});
