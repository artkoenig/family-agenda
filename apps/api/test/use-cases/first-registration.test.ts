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

  it("records nothing when the Identity Provider fails, so a retry registers the Family", async () => {
    await boot();
    directory.failing = true;

    await expect(instance.app.registration.register(anna)).rejects.toThrow();
    directory.failing = false;
    await instance.app.registration.register(anna);

    expect(await instance.query("select organization_id is not null as recorded from family")).toEqual([{ recorded: true }]);
    expect(directory.registrationOpen).toBe(false);
  });

  it("is never open without a management API", async () => {
    await boot({ withDirectory: false });

    await instance.app.registration.register(anna);

    expect(await instance.app.registration.isOpen()).toBe(false);
    expect(await instance.query("select organization_id from family")).toEqual([{ organization_id: null }]);
  });
});
