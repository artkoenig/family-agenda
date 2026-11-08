import { decode, encode } from "@family-agenda/plugin-protocol";
import type { SourcePlugin } from "@family-agenda/source-sdk";
import { testPluginWith, type Ask, type TestPluginOptions } from "./test-plugin-shape";

/** The test plugin as a Plugin Host runs it, asking the test at `controlUrl`. */
export function remoteTestSourcePlugin(controlUrl: string, options: TestPluginOptions): SourcePlugin {
  const ask: Ask = async (question, sourceTypeId, args) => {
    const response = await fetch(controlUrl, { method: "POST", body: encode({ question, sourceTypeId, args }) });
    if (!response.ok) throw new Error(`The test did not answer ${question}: ${response.status}`);
    return decode(await response.text()) as never;
  };
  return testPluginWith(options, ask);
}
