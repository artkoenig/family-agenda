import type { ManagementApi } from "../src/management-api";

type Row = Record<string, unknown> & { id: string };

/**
 * An in-memory stand-in for the parts of Logto's Management API the setup uses, which records
 * every write so tests can tell whether a run created anything.
 */
export function fakeManagementApi() {
  let next = 0;
  const id = () => `id-${String(++next)}`;
  const tables: Record<string, Row[]> = {
    applications: [],
    roles: [],
    connectors: [],
    users: [],
    secrets: [],
    "organization-roles": [],
    organizations: [],
    hooks: [],
  };
  const userRoles: Record<string, string[]> = {};
  let signInExperience: Record<string, unknown> = {};
  let idTokenConfig: unknown;
  const writes: string[] = [];
  const insert = (table: string, row: Record<string, unknown>): Row => {
    const created = { ...row, id: id() };
    tables[table]?.push(created);
    return created;
  };
  const find = (table: string, rowId: string) => tables[table]?.find((row) => row.id === rowId);

  const api: ManagementApi = {
    get: (path) => {
      const url = new URL(path, "http://logto");
      const secrets = /^\/api\/applications\/([^/]+)\/secrets$/.exec(url.pathname);
      if (secrets) return Promise.resolve(tables.secrets?.filter((secret) => secret.applicationId === secrets[1]));
      if (url.pathname === "/api/users") return Promise.resolve(tables.users?.filter((user) => user.username === url.searchParams.get("search.username")));
      if (url.pathname === "/api/roles") return Promise.resolve(tables.roles?.filter((role) => role.type === url.searchParams.get("type")));
      return Promise.resolve(tables[url.pathname.replace("/api/", "")]);
    },
    post: (path, body) => {
      writes.push(`POST ${path}`);
      const row = body as Record<string, unknown>;
      const secrets = /^\/api\/applications\/([^/]+)\/secrets$/.exec(path);
      if (secrets) return Promise.resolve(insert("secrets", { ...row, applicationId: secrets[1], value: `secret-of-${secrets[1] ?? ""}` }));
      const roles = /^\/api\/users\/([^/]+)\/roles$/.exec(path);
      if (roles) {
        userRoles[roles[1] ?? ""] = (row as { roleIds: string[] }).roleIds;
        return Promise.resolve(undefined);
      }
      const created = insert(path.replace("/api/", ""), row);
      // Logto gives a new traditional web app a secret of its own.
      // Logto signs a new webhook's events with a key of its own making.
      if (path === "/api/hooks") created.signingKey = `signing-key-of-${created.id}`;
      if (path === "/api/applications") insert("secrets", { applicationId: created.id, value: `secret-of-${created.id}` });
      return Promise.resolve(created);
    },
    patch: (path, body) => {
      writes.push(`PATCH ${path}`);
      if (path === "/api/sign-in-exp") {
        signInExperience = { ...signInExperience, ...(body as object) };
        return Promise.resolve(signInExperience);
      }
      const [, , table = "", rowId = ""] = path.split("/");
      const row = find(table, rowId);
      if (!row) return Promise.reject(new Error(`PATCH ${path} failed (404)`));
      Object.assign(row, body);
      return Promise.resolve(row);
    },
    put: (path, body) => {
      writes.push(`PUT ${path}`);
      idTokenConfig = body;
      return Promise.resolve(body);
    },
  };
  return {
    api,
    tables,
    userRoles,
    writes,
    signInExperience: () => signInExperience,
    idTokenConfig: () => idTokenConfig,
  };
}
