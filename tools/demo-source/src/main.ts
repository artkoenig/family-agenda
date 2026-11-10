/**
 * Runs the demo Source as an HTTP plugin on PORT (8080 by default), as its image does. Its endpoints
 * answer after DEMO_DELAY_MS (2000 by default), so that a preview shows the loading states.
 */
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { demoPlugin, withDelay } from "./plugin";

const port = Number(process.env.PORT ?? 8080);
const delayMs = Number(process.env.DEMO_DELAY_MS ?? 2000);
await servePlugin(withDelay(demoPlugin, delayMs), { port });
console.log(`demo Source plugin listening on port ${port}, answering after ${delayMs} ms`);
