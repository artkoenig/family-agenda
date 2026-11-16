import { describe, expect, it } from "vitest";
import { connectManagementApi, managementApiResource } from "../src/management-api";

interface Call { url: string; init: RequestInit }

function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fetchFn = (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(responses.shift() ?? new Response("", { status: 500 }));
  };
  return { calls, fetchFn: fetchFn as typeof fetch };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("the Management API connection", () => {
  it("gets a token with the client credentials and sends it with every call", async () => {
    const { calls, fetchFn } = fakeFetch([json({ access_token: "token" }), json([{ id: "a" }]), json({ id: "b" }), new Response(null, { status: 204 }), json({})]);

    const api = await connectManagementApi("http://logto:3001/", "app", "secret", fetchFn);
    const listed = await api.get("/api/roles");
    await api.post("/api/roles", { name: "r" });
    const patched = await api.patch("/api/sign-in-exp", {});
    await api.put("/api/configs/id-token", {});

    const [token, get, post, patch, put] = calls;
    expect(token?.url).toBe("http://logto:3001/oidc/token");
    expect((token?.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("app:secret").toString("base64")}`);
    expect((token?.init.body as URLSearchParams).toString()).toBe(`grant_type=client_credentials&resource=${encodeURIComponent(managementApiResource)}&scope=all`);
    expect(listed).toEqual([{ id: "a" }]);
    expect(patched).toBeUndefined();
    expect([get, post, patch, put].map((call) => [call?.init.method, call?.url])).toEqual([
      ["GET", "http://logto:3001/api/roles"],
      ["POST", "http://logto:3001/api/roles"],
      ["PATCH", "http://logto:3001/api/sign-in-exp"],
      ["PUT", "http://logto:3001/api/configs/id-token"],
    ]);
    expect(post?.init.body).toBe(JSON.stringify({ name: "r" }));
    expect((get?.init.headers as Record<string, string>).authorization).toBe("Bearer token");
  });

  it("fails naming Logto's answer when the app is refused or a call fails", async () => {
    await expect(connectManagementApi("http://logto:3001", "app", "wrong", fakeFetch([new Response("invalid_client", { status: 401 })]).fetchFn)).rejects.toThrow(
      "Logto refused the machine-to-machine app (401): invalid_client",
    );
    const api = await connectManagementApi("http://logto:3001", "app", "secret", fakeFetch([json({ access_token: "token" }), new Response("nope", { status: 422 })]).fetchFn);
    await expect(api.get("/api/users")).rejects.toThrow("GET /api/users failed (422): nope");
  });
});
