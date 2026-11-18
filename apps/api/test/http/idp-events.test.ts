import { createHmac } from "node:crypto";
import type { Registration, RegistrationEvent } from "@family-agenda/application";
import { afterEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";

const secret = "logto-signing-key";

/** A Logto `PostRegister` event, as its webhook posts it. */
const postRegister = (user: Record<string, unknown> = {}, event = "PostRegister") =>
  JSON.stringify({
    hookId: "hook-1",
    event,
    createdAt: "2026-09-14T07:00:00.000Z",
    userId: "user-anna",
    user: { id: "user-anna", primaryEmail: "anna@example.org", ...user },
  });

const signatureOf = (body: string, key = secret) => createHmac("sha256", key).update(body).digest("hex");

/** Records the events handed to registration; fails while `failing`. */
class RecordingRegistration implements Registration {
  readonly events: RegistrationEvent[] = [];
  failing = false;
  register(event: RegistrationEvent): Promise<void> {
    if (this.failing) return Promise.reject(new Error("the Identity Provider is down"));
    this.events.push(event);
    return Promise.resolve();
  }
  isOpen(): Promise<boolean> {
    return Promise.resolve(true);
  }
  retry(): Promise<number> {
    return Promise.resolve(0);
  }
  settle(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

describe("registration events from the Identity Provider (ADR-0010)", () => {
  let instance: HttpTestInstance;
  let registration: RecordingRegistration;

  const boot = async (idpWebhookSecret: string | null = secret) => {
    registration = new RecordingRegistration();
    instance = await bootHttpForTest({}, { idpWebhookSecret, registration });
  };

  const send = (body: string, signature: string | null = signatureOf(body)) =>
    instance.request("/idp/events", {
      body: body as unknown as FormData,
      headers: { "content-type": "application/json", ...(signature === null ? {} : { "logto-signature-sha-256": signature }) },
    });

  afterEach(async () => {
    await instance.close();
  });

  it("hands a signed PostRegister event with a verified email to registration", async () => {
    await boot();

    const response = await send(postRegister());

    expect(response.status).toBe(204);
    expect(registration.events).toEqual([{ userId: "user-anna", email: "anna@example.org" }]);
  });

  it("refuses an event whose signature is missing or wrong", async () => {
    await boot();
    const body = postRegister();

    expect((await send(body, null)).status).toBe(401);
    expect((await send(body, signatureOf(body, "another-key"))).status).toBe(401);
    expect((await send(body, "not-hex")).status).toBe(401);
    expect((await send(body, signatureOf(`${body} `))).status).toBe(401);
    expect(registration.events).toEqual([]);
  });

  it("ignores an event without a verified email, and events other than PostRegister", async () => {
    await boot();

    expect((await send(postRegister({ primaryEmail: null }))).status).toBe(204);
    expect((await send(postRegister({ primaryEmail: "" }))).status).toBe(204);
    expect((await send(postRegister({}, "PostSignIn"))).status).toBe(204);
    expect((await send("not json")).status).toBe(400);
    expect((await send(JSON.stringify({ event: "PostRegister", user: { primaryEmail: "a@example.org" } }))).status).toBe(400);
    expect(registration.events).toEqual([]);
  });

  it("hands a replay to registration too, which keeps one registration per user", async () => {
    await boot();
    const body = postRegister();
    await send(body);

    expect((await send(body)).status).toBe(204);
    expect(registration.events).toHaveLength(2);
  });

  it("answers 500 when the registration could not be kept, so that a later delivery gets another go", async () => {
    await boot();
    const body = postRegister();
    registration.failing = true;

    expect((await send(body)).status).toBe(500);
    registration.failing = false;
    expect((await send(body)).status).toBe(204);
    expect(registration.events).toHaveLength(1);
  });

  it("is not served without IDP_WEBHOOK_SECRET", async () => {
    await boot(null);

    expect((await send(postRegister())).status).toBe(404);
  });
});
