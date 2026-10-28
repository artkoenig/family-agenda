#!/usr/bin/env node
// Stands in for Synapse's Python: serves /health on the port of the configuration it is given.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";

const config = readFileSync(process.argv[process.argv.indexOf("--config-path") + 1], "utf8");
const port = Number(/- port: (\d+)/.exec(config)[1]);
createServer((request, response) => {
  response.writeHead(request.url === "/health" ? 200 : 404).end("OK");
}).listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
