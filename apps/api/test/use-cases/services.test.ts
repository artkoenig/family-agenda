import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";

describe("the services of Source Types, as the worker runs them", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    testPluginControls.catalogue("bridged", [
      { id: "whatsapp", displayName: "WhatsApp", description: "Reads WhatsApp.", installed: true },
      { id: "signal", displayName: "Signal", description: "Reads Signal.", installed: true },
    ]);
    instance = await bootForTest();
    await writeTestPluginPackage(instance.workspacePackages, {
      sourceTypeId: "bridged",
      configuration: `{ version: 1, fields: [{ key: "network", label: "Network", secret: false, required: true }] }`,
      catalogue: { configKey: "network" },
      services: true,
    });
    await instance.restart();
  });
  afterEach(async () => {
    await instance.close();
  });

  const reconciled = () => testPluginControls.reconciled("bridged");

  it("leaves the services of a disabled Source Type alone", async () => {
    const before = reconciled().length;

    expect(await instance.app.services.reconcile()).toEqual({ failed: [] });

    expect(reconciled()).toHaveLength(before);
  });

  it("starts what an Admin enables, and stops it all once the Source Type is disabled", async () => {
    await instance.app.sourceTypes.enable("bridged");
    await instance.app.services.reconcile();
    expect(reconciled().at(-1)).toEqual({ enabled: true, entries: [] });

    await instance.app.catalogues.enable("bridged", "whatsapp");
    await instance.app.services.reconcile();
    expect(reconciled().at(-1)).toEqual({ enabled: true, entries: ["whatsapp"] });

    await instance.app.sourceTypes.disable("bridged");
    await instance.app.services.reconcile();
    expect(reconciled().at(-1)).toEqual({ enabled: false, entries: [] });

    // Told once; from then on the disabled Source Type is left alone again.
    const told = reconciled().length;
    await instance.app.services.reconcile();
    expect(reconciled()).toHaveLength(told);
  });

  it("reports a failure and tries again next time", async () => {
    await instance.app.sourceTypes.enable("bridged");
    testPluginControls.failReconciling("bridged");

    expect(await instance.app.services.reconcile()).toEqual({ failed: [{ sourceTypeId: "bridged", message: "the homeserver did not start" }] });
    expect(await instance.app.services.reconcile()).toEqual({ failed: [] });
  });

  it("stops the services as the worker shuts down", async () => {
    await instance.app.sourceTypes.enable("bridged");
    await instance.app.services.reconcile();
    const before = testPluginControls.stopped("bridged");

    await instance.app.services.stop();

    expect(testPluginControls.stopped("bridged")).toBe(before + 1);
  });
});
