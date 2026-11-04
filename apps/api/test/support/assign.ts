import type { FamilyMemberId, SourceId } from "@family-agenda/domain";
import type { TestInstance } from "./boot";
import { testPluginControls } from "./test-source-plugin";

/**
 * Assigns every Source Attribute of a Source to the Family Members, as an Admin ticks them. A
 * Source that has not run yet declares a single attribute, `main`, in a run of its own, as its
 * plugin would; one that has run without declaring any cannot be assigned.
 */
export async function assignSource(instance: TestInstance, source: SourceId, members: FamilyMemberId[]): Promise<void> {
  const find = async () => (await instance.app.sources.list()).find((listed) => listed.id === source);
  let listed = await find();
  if (listed && listed.attributes.length === 0) {
    testPluginControls.declare(listed.sourceTypeId, [{ externalId: "main", name: "Main" }]);
    await instance.app.polling.pollDue();
    listed = await find();
  }
  if (!listed || listed.attributes.length === 0) throw new Error("the Source has no Source Attribute to assign");
  for (const attribute of listed.attributes) {
    const result = await instance.app.sources.assignAttribute(attribute.id, members);
    if (!result.ok) throw new Error(`assigning failed: ${result.problem}`);
  }
}
