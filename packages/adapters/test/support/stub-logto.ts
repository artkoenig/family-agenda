import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;
type Invitation = { id: string; invitee: string; organizationId: string; expiresAt: number; status: string; organizationRoleIds: string[]; messagePayload: unknown };

/**
 * A stand-in for Logto's Management API: enough Organizations, members, roles and invitations to see
 * what the adapter sends, kept in memory.
 */
export class StubLogto {
  readonly organizations = new Map<string, { name: string; customData: unknown; members: Map<string, string[]> }>();
  readonly users = new Map<string, { primaryEmail: string | null; lastSignInAt: number | null }>();
  readonly invitations = new Map<string, Invitation>();
  roles = [{ id: "role-admin", name: "admin" }, { id: "role-other", name: "admin-like" }];
  /** The tokens handed out, and the requests made with each. */
  readonly tokenRequests: { authorization: string; form: URLSearchParams }[] = [];
  readonly requests: { method: string; path: string; authorization: string }[] = [];
  /** Answers the next API request with this status instead. */
  failNext: number | null = null;
  refuseToken = false;
  tokenLifetimeSeconds = 3600;
  private nextId = 1;

  private constructor(private readonly server: Server) {}

  static async start(): Promise<StubLogto> {
    const server = createServer();
    const stub = new StubLogto(server);
    server.on("request", (request: IncomingMessage, response: ServerResponse) => {
      let text = "";
      request.on("data", (chunk: Buffer) => (text += chunk.toString()));
      request.on("end", () => {
        stub.handle(request, text, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return stub;
  }

  get endpoint(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
      this.server.closeAllConnections();
    });
  }

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  private handle(request: IncomingMessage, text: string, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", this.endpoint);
    const authorization = request.headers.authorization ?? "";
    const [status, answer] = this.answer(request.method ?? "", url, authorization, text);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(answer === undefined ? "" : JSON.stringify(answer));
  }

  private answer(method: string, url: URL, authorization: string, text: string): [number, unknown?] {
    if (url.pathname === "/oidc/token") {
      this.tokenRequests.push({ authorization, form: new URLSearchParams(text) });
      if (this.refuseToken) return [401, { error: "invalid_client" }];
      return [200, { access_token: `token-${this.tokenRequests.length}`, expires_in: this.tokenLifetimeSeconds, token_type: "Bearer" }];
    }
    this.requests.push({ method, path: url.pathname + url.search, authorization });
    if (this.failNext !== null) {
      const status = this.failNext;
      this.failNext = null;
      return [status, { message: "failed" }];
    }
    return this.route(method, url, (text === "" ? {} : JSON.parse(text)) as Json);
  }

  private route(method: string, url: URL, body: Json): [number, unknown?] {
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const route = `${method} ${parts.map((part, index) => (index % 2 === 1 ? ":" : part)).join("/")}`;
    switch (route) {
      case "POST organizations": {
        const id = this.id("org");
        this.organizations.set(id, { name: String(body.name), customData: body.customData, members: new Map() });
        return [201, { id, name: body.name, customData: body.customData }];
      }
      case "POST organizations/:/users": {
        const members = this.organizations.get(parts[1] ?? "")?.members;
        if (!members) return [404];
        for (const userId of body.userIds as string[]) members.set(userId, []);
        return [201];
      }
      case "POST organizations/:/users/:/roles": {
        const roles = this.organizations.get(parts[1] ?? "")?.members.get(parts[3] ?? "");
        if (!roles) return [404];
        roles.push(...(body.organizationRoleIds as string[]));
        return [201];
      }
      case "GET organizations/:/users": {
        const members = this.organizations.get(parts[1] ?? "")?.members;
        if (!members) return [404];
        const page = Number(url.searchParams.get("page"));
        const size = Number(url.searchParams.get("page_size"));
        const users = [...members.keys()].map((id) => ({ id, ...this.users.get(id) }));
        return [200, users.slice((page - 1) * size, page * size)];
      }
      case "DELETE organizations/:/users/:":
        this.organizations.get(parts[1] ?? "")?.members.delete(parts[3] ?? "");
        return [204];
      case "GET organization-roles":
        return [200, this.roles.filter((role) => role.name.includes(url.searchParams.get("q") ?? ""))];
      case "POST organization-invitations": {
        const invitation: Invitation = {
          id: this.id("invitation"),
          invitee: String(body.invitee),
          organizationId: String(body.organizationId),
          expiresAt: Number(body.expiresAt),
          status: "Pending",
          organizationRoleIds: body.organizationRoleIds as string[],
          messagePayload: body.messagePayload,
        };
        this.invitations.set(invitation.id, invitation);
        return [201, invitation];
      }
      case "GET organization-invitations":
        return [200, [...this.invitations.values()].filter((invitation) => invitation.organizationId === url.searchParams.get("organizationId"))];
      case "GET organization-invitations/:": {
        const invitation = this.invitations.get(parts[1] ?? "");
        return invitation ? [200, invitation] : [404];
      }
      case "PUT organization-invitations/:/status": {
        const invitation = this.invitations.get(parts[1] ?? "");
        if (!invitation) return [404];
        invitation.status = String(body.status);
        return [200, invitation];
      }
      default:
        return [404];
    }
  }
}
