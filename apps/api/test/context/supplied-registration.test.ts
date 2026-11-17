import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryDelayMs, type WebhookPost } from "@family-agenda/application";
import { afterEach, describe, expect, it } from "vitest";
import { bootShared } from "../../src/composition-root";
import { contextHeader } from "../../src/context/context";
import { SuppliedFamilies } from "../../src/context/supplied-families";
import { suppliedFetch } from "../../src/context/supplied-http";
import { openSuppliedRegistration, startSuppliedRegistration, type SuppliedRegistration } from "../../src/context/supplied-registration";
import { FakeClock } from "../support/fake-clock";
import { InMemoryIdentityDirectory } from "../support/in-memory-identity-directory";
import { acquirePostgres, type InProcessPostgres } from "../support/in-process-postgres";

const idpSecret = "logto-signing-key";
const webhookSecret = "a-webhook-secret-of-at-least-32-chars";
const webhookUrl = "https://platform.example.org/hooks/family";

const postRegister = (userId: string, email: string) =>
  JSON.stringify({ event: "PostRegister", createdAt: "2026-11-17T07:00:00.000Z", user: { id: userId, primaryEmail: email } });
const signed = (body: string, key = idpSecret) => createHmac("sha256", key).update(body).digest("hex");

type Sent = { url: string; headers: Record<string, string>; body: string };

describe("registration in supplied mode (ADR-0010)", () => {
  let database: InProcessPostgres;
  let directory: InMemoryIdentityDirectory;
  let clock: FakeClock;
  let registering: SuppliedRegistration;
  let sent: Sent[];
  /** What the platform answers next, by try; 204 once they are used up. */
  let answers: (number | Error)[];
  let fetch: (request: Request) => Promise<Response>;
  let tessdata: string;

  const post: WebhookPost = (url, init) => {
    sent.push({ url, ...init });
    const answer = answers.shift() ?? 204;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };

  const boot = async () => {
    tessdata = await mkdtemp(join(tmpdir(), "family-agenda-registration-"));
    database = await acquirePostgres();
    directory = new InMemoryIdentityDirectory();
    clock = new FakeClock(new Date("2026-11-17T07:00:00Z"));
    sent = [];
    answers = [];
    const shared = await bootShared({ tessdataDirectory: tessdata, bundledTessdataDirectory: null, clock, idpWebhookSecret: idpSecret, identityDirectoryClient: directory });
    const opened = await openSuppliedRegistration({ shared, webhook: { url: webhookUrl, secret: webhookSecret }, database: database.connect(), post });
    if (opened === null) throw new Error("registration is off");
    registering = opened;
    const families = new SuppliedFamilies({ shared, serving: () => () => new Response("a Family") });
    fetch = suppliedFetch({ contextKey: "a-context-key-of-at-least-32-characters", families, version: "test", log: { warn: () => {} }, registrationEvents: registering.events });
  };

  const send = (body: string, signature = signed(body), headers: Record<string, string> = {}) =>
    fetch(new Request("http://core/idp/events", { method: "POST", body, headers: { "logto-signature-sha-256": signature, ...headers } }));

  afterEach(async () => {
    await registering.close();
    await database.release();
    await rm(tessdata, { recursive: true, force: true });
  });

  it("is open", async () => {
    await boot();
    expect(await registering.registration.isOpen()).toBe(true);
  });

  it("gives each registration a new Family and organization with the user as its Admin, and tells the platform with a signed webhook", async () => {
    await boot();

    expect((await send(postRegister("user-anna", "anna@example.org"))).status).toBe(204);
    expect((await send(postRegister("user-ben", "ben@example.org"))).status).toBe(204);

    const organizations = [...directory.organizations.entries()];
    expect(organizations.map(([, organization]) => [...organization.members.keys()])).toEqual([["user-anna"], ["user-ben"]]);
    const [[annasOrganization, anna] = []] = organizations;
    expect(sent).toHaveLength(2);
    const [first] = sent;
    expect(first?.url).toBe(webhookUrl);
    expect(JSON.parse(first?.body ?? "")).toEqual({ event: "family.created", familyId: anna?.familyId, organizationId: annasOrganization, email: "anna@example.org" });
    expect(first?.headers).toEqual({
      "content-type": "application/json",
      "idempotency-key": anna?.familyId,
      "family-agenda-signature-sha-256": signed(first?.body ?? "", webhookSecret),
    });
    expect(organizations[0]?.[1].familyId).not.toBe(organizations[1]?.[1].familyId);
    expect(await database.query("select * from family_created_delivery")).toEqual([]);
  });

  it("does nothing for an event seen before, a wrong signature or an unverified email", async () => {
    await boot();
    const body = postRegister("user-anna", "anna@example.org");

    await send(body);
    expect((await send(body)).status).toBe(204);
    expect((await send(postRegister("user-ben", "ben@example.org"), signed("other"))).status).toBe(401);
    expect((await send(postRegister("user-carl", ""))).status).toBe(204);
    expect((await send("not json")).status).toBe(400);

    expect(directory.organizations.size).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("creates no Family for a user who registers through an invitation", async () => {
    await boot();
    await send(postRegister("user-anna", "anna@example.org"));
    const [organizationId] = directory.organizations.keys();
    await directory.invite(organizationId ?? "", "ben@example.org", { expiresAt: new Date("2026-11-24T07:00:00Z"), link: "https://x", locale: "en" });

    expect((await send(postRegister("user-ben", "ben@example.org"))).status).toBe(204);

    expect(directory.organizations.size).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("keeps a delivery the platform did not take, and retries it with backoff until it answers 2xx", async () => {
    await boot();
    answers = [503, new Error("connection refused"), 500];

    await send(postRegister("user-anna", "anna@example.org"));
    expect(sent).toHaveLength(1);
    expect(await database.query("select attempts from family_created_delivery")).toEqual([{ attempts: 1 }]);

    clock.advance(retryDelayMs(1) - 1);
    expect(await registering.webhook.deliverDue()).toBe(0);
    expect(sent).toHaveLength(1);

    clock.advance(1);
    expect(await registering.webhook.deliverDue()).toBe(0);
    clock.advance(retryDelayMs(2));
    expect(await registering.webhook.deliverDue()).toBe(0);
    expect(await database.query("select attempts from family_created_delivery")).toEqual([{ attempts: 3 }]);
    clock.advance(retryDelayMs(3));
    expect(await registering.webhook.deliverDue()).toBe(1);

    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((delivery) => delivery.headers["idempotency-key"])).size).toBe(1);
    expect(await database.query("select * from family_created_delivery")).toEqual([]);
  });

  it("does not try a delivery another core has just taken", async () => {
    await boot();
    answers = [503];
    await send(postRegister("user-anna", "anna@example.org"));
    clock.advance(retryDelayMs(1));
    await database.query("update family_created_delivery set next_attempt_at = now() + interval '1 hour'");

    expect(await registering.webhook.deliverDue()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("waits longer after each failed try, at most an hour", () => {
    expect([1, 2, 3, 20].map(retryDelayMs)).toEqual([10_000, 20_000, 40_000, 3_600_000]);
  });

  it("starts off without the webhook, and on with it, offering sign-up to every Family", async () => {
    await boot();
    const shared = await bootShared({ tessdataDirectory: tessdata, bundledTessdataDirectory: null, clock, idpWebhookSecret: idpSecret, identityDirectoryClient: directory });
    const off = await startSuppliedRegistration(shared, null, { error: () => {} });
    expect(off.events).toBeNull();
    expect(off.shared).toBe(shared);
    await off.close();
    const second = await acquirePostgres();
    try {
      const on = await startSuppliedRegistration(shared, { url: webhookUrl, secret: webhookSecret, registrationDatabaseUrl: "postgres://unused" }, { error: () => {} }, () => second.connect());
      expect(on.events).not.toBeNull();
      expect(await on.shared.registration?.isOpen()).toBe(true);
      await on.close();
    } finally {
      await second.release();
    }
  });

  it("leaves a request with a Context, or another path, to the Families", async () => {
    await boot();
    expect((await fetch(new Request("http://core/idp/events", { method: "POST", body: "{}", headers: { [contextHeader]: "forged" } }))).status).toBe(401);
    expect((await fetch(new Request("http://core/idp/other", { method: "POST", body: "{}" }))).status).toBe(401);
    expect(directory.organizations.size).toBe(0);
  });
});
