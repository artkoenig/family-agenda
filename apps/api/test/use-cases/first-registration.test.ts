import { organizationName, registrationRetryDelayMs } from "@family-agenda/application";
import { afterEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryIdentityDirectory } from "../support/in-memory-identity-directory";

const anna = { userId: "user-anna", email: "anna@example.org" };
const ben = { userId: "user-ben", email: "ben@example.org" };

describe("the first registration of a fixed Instance (ADR-0010)", () => {
  let instance: TestInstance;
  let directory: InMemoryIdentityDirectory;

  const boot = async (options: { withDirectory?: boolean } = {}) => {
    directory = new InMemoryIdentityDirectory();
    instance = await bootForTest({
      idpWebhookSecret: "logto-signing-key",
      ...(options.withDirectory === false ? {} : { identityDirectoryClient: directory }),
    });
  };

  afterEach(async () => {
    await instance.close();
  });

  it("is open until a Family is registered", async () => {
    await boot();
    expect(await instance.app.registration.isOpen()).toBe(true);
    expect(directory.registrationOpen).toBe(true);
  });

  it("creates the Family's organization with its Family id, records it, makes the user an Admin and closes registration", async () => {
    await boot();

    await instance.app.registration.register(anna);

    const [organizationId, organization] = [...directory.organizations.entries()][0] ?? [];
    expect(directory.organizations.size).toBe(1);
    expect(organization).toMatchObject({ familyId: instance.app.familyId });
    expect([...(organization?.members.keys() ?? [])]).toEqual(["user-anna"]);
    expect(await instance.query("select organization_id from family")).toEqual([{ organization_id: organizationId }]);
    expect(directory.registrationOpen).toBe(false);
    expect(await instance.app.registration.isOpen()).toBe(false);
  });

  it("creates nothing for a later registration that slipped through, and closes registration again", async () => {
    await boot();
    await instance.app.registration.register(anna);
    directory.registrationOpen = true;

    await instance.app.registration.register(ben);

    expect(directory.organizations.size).toBe(1);
    expect([...([...directory.organizations.values()][0]?.members.keys() ?? [])]).toEqual(["user-anna"]);
    expect(directory.registrationOpen).toBe(false);
  });

  it("keeps one Family when two registrations arrive at the same moment", async () => {
    await boot();

    await Promise.all([instance.app.registration.register(anna), instance.app.registration.register(ben)]);

    const [recorded] = await instance.query("select organization_id from family");
    const withMembers = [...directory.organizations.entries()].filter(([, organization]) => organization.members.size > 0);
    expect(withMembers.map(([id]) => id)).toEqual([recorded?.organization_id]);
  });

  it("never reopens registration once the Family exists, also after a restart", async () => {
    await boot();
    await instance.app.registration.register(anna);

    await instance.restart();

    expect(await instance.app.registration.isOpen()).toBe(false);
  });

  it("keeps a registration the Identity Provider failed, and carries it through once it is due again", async () => {
    await boot();
    directory.failing = true;

    await instance.app.registration.register(anna);
    expect(await instance.query("select attempts, done_at is null as pending from registration")).toEqual([{ attempts: 1, pending: true }]);
    directory.failing = false;
    expect(await instance.app.registration.retry()).toBe(0);
    instance.clock.advance(registrationRetryDelayMs(1));
    expect(await instance.app.registration.retry()).toBe(1);

    expect(await instance.query("select organization_id is not null as recorded from family")).toEqual([{ recorded: true }]);
    expect(directory.registrationOpen).toBe(false);
  });

  it("does nothing for a redelivered registration", async () => {
    await boot();
    await instance.app.registration.register(anna);

    await instance.app.registration.register(anna);

    expect(directory.organizations.size).toBe(1);
    expect(await instance.query("select user_id, done_at is not null as done from registration")).toEqual([{ user_id: "user-anna", done: true }]);
  });

  it("leaves an event to a core of the older version that recorded it, and records the ones it takes for them", async () => {
    await boot();
    await instance.query(`insert into processed_idp_event (event_id, processed_at) values ('PostRegister:user-anna', now())`);

    await instance.app.registration.register(anna);
    await instance.app.registration.register(ben);

    expect([...([...directory.organizations.values()][0]?.members.keys() ?? [])]).toEqual(["user-ben"]);
    expect(await instance.query("select event_id from processed_idp_event order by event_id")).toEqual([{ event_id: "PostRegister:user-anna" }, { event_id: "PostRegister:user-ben" }]);
    expect(await instance.query("select user_id, done_at is not null as done from registration order by user_id")).toEqual([
      { user_id: "user-anna", done: true },
      { user_id: "user-ben", done: true },
    ]);
  });

  it("goes on with the organization noted when adding the Admin failed, creating no second one", async () => {
    await boot();
    directory.failingToAdd = true;
    await instance.app.registration.register(anna);
    directory.failingToAdd = false;

    instance.clock.advance(registrationRetryDelayMs(1));
    await instance.app.registration.retry();

    const [organizationId] = directory.organizations.keys();
    expect(directory.organizations.size).toBe(1);
    expect(await instance.query("select organization_id from family")).toEqual([{ organization_id: organizationId }]);
    expect([...(directory.organization(organizationId ?? "").members.keys())]).toEqual(["user-anna"]);
  });

  it("finds the organization a core created before it died, by the Family id in its name, and creates no second one", async () => {
    await boot();
    // A core took Anna's registration, created the organization and died before noting it.
    const created = await directory.createOrganization(instance.app.familyId, organizationName(instance.app.familyId));
    await instance.query(`insert into registration (user_id, email, next_attempt_at, leased_until) values ('user-anna', 'anna@example.org', '2026-09-14T06:00:00Z', '2026-09-14T06:05:00Z')`);

    expect(await instance.app.registration.retry()).toBe(1);

    expect([...directory.organizations.keys()]).toEqual([created]);
    expect(await instance.query("select organization_id from family")).toEqual([{ organization_id: created }]);
  });

  it("takes no registration while another core holds one, so that only the first creates anything", async () => {
    await boot();
    await instance.query(`insert into registration (user_id, email, next_attempt_at, leased_until) values ('user-anna', 'anna@example.org', '2026-09-14T06:59:00Z', '2026-09-14T07:04:00Z')`);

    await instance.app.registration.register(ben);

    expect(directory.organizations.size).toBe(0);
    expect(await instance.query("select user_id from registration where done_at is null order by user_id")).toEqual([{ user_id: "user-anna" }, { user_id: "user-ben" }]);
  });

  it("creates nothing for a user who deleted their account before their registration was carried through", async () => {
    await boot();
    directory.deleted.add("user-anna");

    await instance.app.registration.register(anna);

    expect(directory.organizations.size).toBe(0);
    expect(await instance.app.registration.isOpen()).toBe(true);
    expect(await instance.query("select done_at is not null as done from registration")).toEqual([{ done: true }]);
  });

  it("is never open without a management API", async () => {
    await boot({ withDirectory: false });

    await instance.app.registration.register(anna);

    expect(await instance.app.registration.isOpen()).toBe(false);
    expect(await instance.query("select organization_id from family")).toEqual([{ organization_id: null }]);
  });
});
