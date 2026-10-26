import { bootWorker } from "@family-butler/api/composition-root";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const worker = await bootWorker({ databaseUrl });
console.log("Family Butler worker started");

const shutdown = () => void worker.close().then(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
