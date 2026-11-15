import { bootWorker } from "@family-agenda/api/composition-root";
import { readConfig } from "@family-agenda/api/config";

// Due work, the purge and the sweep come from pg-boss schedules in the Family's database.
const worker = await bootWorker(readConfig());
console.log("Family Agenda worker started");

const shutdown = () => {
  void worker.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
