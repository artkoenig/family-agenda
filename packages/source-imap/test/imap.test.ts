import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeSourcePluginContract } from "@family-agenda/source-sdk/testing";
import { SourceError, type IngestResult, type Origin, type RunContext, type SourcePlugin } from "@family-agenda/source-sdk";
import { createImapPlugin } from "../src";
import { ImapServerFixture } from "./imap-server";

const now = new Date("2026-09-14T07:00:00Z");
const days = 24 * 60 * 60 * 1000;

const invitation = `From: Frau Berger <Berger@Schule.example.org>
To: familie@example.org
Subject: Elternabend 5b
Date: Mon, 14 Sep 2026 08:12:00 +0200
Message-ID: <elternabend-1@schule.example.org>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 8bit

Liebe Eltern,

der Elternabend findet am Donnerstag, 17.09., um 19:30 Uhr statt.
--b1
Content-Type: application/pdf; name="einladung.pdf"
Content-Disposition: attachment; filename="einladung.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--b1--
`;

const moved = `From: Frau Berger <berger@schule.example.org>
To: familie@example.org
Subject: Re: Elternabend 5b
Date: Tue, 15 Sep 2026 12:00:00 +0200
Message-ID: <elternabend-2@schule.example.org>
In-Reply-To: <elternabend-1@schule.example.org>
References: <elternabend-1@schule.example.org>
Content-Type: text/html; charset=utf-8

<p>Der Elternabend wird auf <b>16 Uhr</b> verlegt.</p>
`;

const old = `From: verein@example.org
Subject: Saisonabschluss
Date: Sat, 01 Aug 2026 10:00:00 +0200
Message-ID: <alt@example.org>
Content-Type: text/plain

Danke für die Saison!
`;

const account = { user: "familie@example.org", password: "app-password" };
const server = new ImapServerFixture(account);
await server.start();
server.deliver("Schule", old, new Date("2026-08-01T08:00:00Z"));
server.deliver("Schule", invitation, new Date("2026-09-14T06:12:00Z"));
server.deliver("INBOX", "Subject: Privat\n\nNicht für die Schule.\n", new Date("2026-09-14T06:00:00Z"));

const config = (plain: Record<string, unknown> = {}, password = account.password): RunContext["config"] => ({
  plain: { host: "127.0.0.1", port: String(server.port), username: account.user, folders: ["Schule"], ...plain },
  secrets: { password },
});

const plugin = () => createImapPlugin({ allowPlaintext: true });

const poll = (context: Partial<RunContext> = {}, of: SourcePlugin = plugin()): Promise<IngestResult> => {
  if (of.ingestion.mode !== "polling") throw new Error("the IMAP plugin polls");
  return of.ingestion.poll({ config: config(), state: null, now, timeZone: "Europe/Berlin", ...context });
};

const message = (origin: Origin | undefined) => {
  if (origin?.content.kind !== "raw-message") throw new Error("not a raw message");
  return origin.content;
};

describeSourcePluginContract(plugin, {
  config: config(),
  now,
  languages: ["de"],
  packageJson: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
});

afterAll(async () => {
  await server.stop();
});

describe("the IMAP plugin", () => {
  it("emits each recent mail of its folder as a raw message, with the sender as an Origin attribute", async () => {
    const { origins } = await poll();

    expect(origins).toHaveLength(1);
    const [origin] = origins;
    expect(origin).toMatchObject({
      externalId: "<elternabend-1@schule.example.org>",
      occurredAt: new Date("2026-09-14T06:12:00Z"),
      attributes: { sender: "berger@schule.example.org" },
      part: "Schule",
    });
    expect(origin?.link).toBeUndefined();
    const content = message(origin);
    expect(content.text).toBe("Subject: Elternabend 5b\n\nLiebe Eltern,\n\nder Elternabend findet am Donnerstag, 17.09., um 19:30 Uhr statt.");
    expect(content.thread).toBe("<elternabend-1@schule.example.org>");
    expect(content.attachments).toEqual([
      { filename: "einladung.pdf", contentType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\n")) },
    ]);
  });

  it("reads later mails after the last UID it saw, and puts a reply into the thread it answers", async () => {
    const first = await poll();
    server.deliver("Schule", moved, new Date("2026-09-15T10:00:00Z"));

    const { origins, state } = await poll({ state: first.state, now: new Date(now.getTime() + days) });

    expect(origins.map((origin) => origin.externalId)).toEqual(["<elternabend-2@schule.example.org>"]);
    const content = message(origins[0]);
    expect(content.thread).toBe("<elternabend-1@schule.example.org>");
    expect(content.text).toContain("Der Elternabend wird auf 16 Uhr verlegt.");
    expect((await poll({ state })).origins).toEqual([]);
  });

  it("reads INBOX as the Source itself when no folder is configured", async () => {
    const { origins } = await poll({ config: config({ folders: undefined }) });

    expect(origins).toHaveLength(1);
    expect(origins[0]?.part).toBeUndefined();
    expect(message(origins[0]).text).toContain("Nicht für die Schule.");
  });

  it("reads each configured folder as a Part of its own, with state per folder", async () => {
    const both = config({ folders: ["Schule", "INBOX"] });
    const first = await poll({ config: both });

    const parts = first.origins.map((origin) => origin.part);
    expect(parts).toContain("Schule");
    expect(parts.filter((part) => part === "INBOX")).toHaveLength(1);
    expect(parts.every((part) => part === "Schule" || part === "INBOX")).toBe(true);
    expect(Object.keys(JSON.parse(first.state ?? "{}") as object).sort()).toEqual(["INBOX", "Schule"]);
    expect((await poll({ config: both, state: first.state })).origins).toEqual([]);
  });

  it("keeps the state of the single folder from before a Source had several", async () => {
    const legacy = (await poll()).state as string;
    const [only] = Object.values(JSON.parse(legacy) as Record<string, unknown>);

    const { origins } = await poll({ state: JSON.stringify(only) });

    expect(origins).toEqual([]);
  });

  it("migrates the single folder of a version 1 configuration into the list of folders", () => {
    const migrate = plugin().configuration.migrations?.[1];

    expect(migrate?.({ host: "h", folder: "Schule" })).toEqual({ host: "h", folders: ["Schule"] });
    expect(migrate?.({ host: "h", folder: "" })).toEqual({ host: "h" });
  });

  it("only reads, never marking, moving or deleting a mail", async () => {
    server.commands.length = 0;

    const first = await poll();
    await poll({ state: first.state });

    expect(server.commands.some((command) => command.startsWith("EXAMINE"))).toBe(true);
    const fetches = server.commands.filter((command) => command.startsWith("UID FETCH"));
    expect(fetches.length).toBeGreaterThan(0);
    for (const fetch of fetches) expect(fetch).toMatch(/BODY\.PEEK\[\]/i);
    expect(server.commands.filter((command) => /^(SELECT|STORE|UID STORE|COPY|UID COPY|MOVE|UID MOVE|EXPUNGE|UID EXPUNGE|APPEND|DELETE|RENAME|CREATE)\b/.test(command))).toEqual([]);
  });

  it("starts over when the folder's UIDVALIDITY changes", async () => {
    const { state } = await poll();
    const mailbox = server.folders.get("Schule")!;
    mailbox.uidValidity += 1;

    const again = await poll({ state });

    expect(again.origins.map((origin) => origin.externalId)).toContain("<elternabend-1@schule.example.org>");
    mailbox.uidValidity -= 1;
  });

  it("fails definitely on a wrong password or a folder that does not exist", async () => {
    await expect(poll({ config: config({}, "wrong") })).rejects.toMatchObject({ kind: "definite" });
    await expect(poll({ config: config({ folders: ["Nirgends"] }) })).rejects.toMatchObject({ kind: "definite" });
  });

  it("fails temporarily when the server cannot be reached", async () => {
    const error = await poll({ config: config({ port: "1" }) }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ kind: "temporary" });
  });
});

describe("the IMAP plugin's connection", () => {
  let tlsOnly: SourcePlugin;
  beforeAll(() => {
    tlsOnly = createImapPlugin();
  });

  it("never sends the password unencrypted to a server that offers no TLS", async () => {
    server.commands.length = 0;

    await expect(poll({}, tlsOnly)).rejects.toMatchObject({ kind: "definite" });
    expect(server.commands).not.toContain("LOGIN ***");
  });
});
