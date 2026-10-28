#!/usr/bin/env node
// Stands in for a mautrix bridge: answers /_matrix/mau/live on its appservice port, and ends on /end.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";

const config = readFileSync(process.argv[process.argv.indexOf("-c") + 1], "utf8");
const port = Number(/\n {2}port: (\d+)/.exec(config)[1]);
createServer((request, response) => {
  if (request.url === "/end") process.exit(1);
  response.writeHead(request.url === "/_matrix/mau/live" ? 200 : 404).end("{}");
}).listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
