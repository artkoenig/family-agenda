/** Runs the demo Source as an HTTP plugin on PORT (8080 by default), as its image does. */
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { demoPlugin } from "./plugin";

const port = Number(process.env.PORT ?? 8080);
await servePlugin(demoPlugin, { port });
console.log(`demo Source plugin listening on port ${port}`);
