import { bootWorker } from "@family-butler/api/composition-root";
import { readConfig } from "@family-butler/api/config";

const worker = await bootWorker({ databaseUrl: readConfig().databaseUrl });
console.log("Family Butler worker started");

const shutdown = () => void worker.close().then(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
