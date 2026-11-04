import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeSourcePluginContract, recordingAttributes } from "@family-agenda/source-sdk/testing";
import { SourceError, type IngestResult, type Origin, type IngestContext, type RunContext, type SourcePlugin } from "@family-agenda/source-sdk";
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

const poll = (context: Partial<IngestContext> = {}, of: SourcePlugin = plugin()): Promise<IngestResult> => {
  if (of.ingestion.mode !== "polling") throw new Error("the IMAP plugin polls");
  return of.ingestion.poll({ config: config(), syncCursor: null, now, timeZone: "Europe/Berlin", attributes: recordingAttributes(), ...context });
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
      sender: "berger@schule.example.org",
      subject: "Elternabend 5b",
      attributes: ["Schule"],
    });
    expect(origin?.link).toBeUndefined();
    const content = message(origin);
    expect(content.text).toBe("Subject: Elternabend 5b\n\nLiebe Eltern,\n\nder Elternabend findet am Donnerstag, 17.09., um 19:30 Uhr statt.");
    expect(content.thread).toBe("<elternabend-1@schule.example.org>");
    expect(content.attachments).toEqual([
      { filename: "einladung.pdf", contentType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\n")) },
    ]);
  });

  it("dates a mail by when the mailbox received it, not by the date its sender wrote into it", async () => {
    const backdated = `From: berger@schule.example.org
Subject: Nachtrag
Date: Thu, 10 Sep 2026 08:00:00 +0200
Message-ID: <nachtrag@schule.example.org>
Content-Type: text/plain

Bitte Turnbeutel mitbringen.
`;
    server.deliver("Nachtraege", backdated, new Date("2026-09-14T06:30:00Z"));

    const { origins } = await poll({ config: config({ folders: ["Nachtraege"] }) });

    expect(origins.map((origin) => origin.occurredAt)).toEqual([new Date("2026-09-14T06:30:00Z")]);
  });

  it("reads later mails after the last UID it saw, and puts a reply into the thread it answers", async () => {
    const first = await poll();
    server.deliver("Schule", moved, new Date("2026-09-15T10:00:00Z"));

    const { origins, syncCursor } = await poll({ syncCursor: first.syncCursor, now: new Date(now.getTime() + days) });

    expect(origins.map((origin) => origin.externalId)).toEqual(["<elternabend-2@schule.example.org>"]);
    const content = message(origins[0]);
    expect(content.thread).toBe("<elternabend-1@schule.example.org>");
    expect(content.text).toContain("Der Elternabend wird auf 16 Uhr verlegt.");
    expect((await poll({ syncCursor })).origins).toEqual([]);
  });

  it("reads INBOX as the Source itself when no folder is configured", async () => {
    const { origins } = await poll({ config: config({ folders: undefined }) });

    expect(origins).toHaveLength(1);
    expect(origins[0]?.attributes).toEqual(["INBOX"]);
    expect(message(origins[0]).text).toContain("Nicht für die Schule.");
  });

  it("reads each allow-listed folder, with a sync cursor per folder, and declares one Source Attribute for each", async () => {
    const both = config({ folders: ["Schule", "INBOX"] });
    const declared = recordingAttributes();
    const first = await poll({ config: both, attributes: declared });

    expect([...new Set(first.origins.map((origin) => origin.attributes.join()))].sort()).toEqual(["INBOX", "Schule"]);
    expect(declared.active().sort()).toEqual(["INBOX", "Schule"]);
    expect(Object.keys((JSON.parse(first.syncCursor ?? "{}") as { containers: object }).containers).sort()).toEqual(["INBOX", "Schule"]);
    expect((await poll({ config: both, syncCursor: first.syncCursor })).origins).toEqual([]);
  });

  it("archives a folder that leaves the allow-list and keeps reading the others", async () => {
    const declared = recordingAttributes();
    const first = await poll({ config: config({ folders: ["Schule", "INBOX"] }), attributes: declared });

    const second = await poll({ config: config({ folders: ["Schule"] }), syncCursor: first.syncCursor, attributes: declared });

    expect(declared.active()).toEqual(["Schule"]);
    expect(second.origins).toEqual([]);
    expect(second.withdrawn ?? []).toEqual([]);
  });

  it("drops what is not allow-listed without a record", async () => {
    const { origins } = await poll({ config: config({ folders: ["Schule"] }) });

    expect(origins.length).toBeGreaterThan(0);
    expect(origins.every((origin) => origin.attributes.join() === "Schule")).toBe(true);
    expect(origins.map((origin) => origin.subject)).not.toContain("Privat");
  });

  it("migrates the single folder of a version 1 configuration into the list of folders", () => {
    const migrate = plugin().configuration.migrations?.[1];

    expect(migrate?.({ host: "h", folder: "Schule" })).toEqual({ host: "h", folders: ["Schule"] });
    expect(migrate?.({ host: "h", folder: "" })).toEqual({ host: "h" });
  });

  it("migrates the list of folders of a version 2 configuration into one field", () => {
    const migrate = plugin().configuration.migrations?.[2];

    expect(migrate?.({ host: "h", folders: ["Schule", "INBOX"] })).toEqual({ host: "h", folders: "Schule, INBOX" });
    expect(migrate?.({ host: "h", folders: [] })).toEqual({ host: "h" });
  });

  it("migrates the comma-separated folders of a version 3 configuration into a list of choices", () => {
    const migrate = plugin().configuration.migrations?.[3];

    expect(migrate?.({ host: "h", folders: "Schule, INBOX" })).toEqual({ host: "h", folders: ["Schule", "INBOX"] });
    expect(migrate?.({ host: "h", folders: "" })).toEqual({ host: "h" });
  });

  it("only reads, never marking, moving or deleting a mail", async () => {
    server.commands.length = 0;

    const first = await poll();
    await poll({ syncCursor: first.syncCursor });

    expect(server.commands.some((command) => command.startsWith("EXAMINE"))).toBe(true);
    const fetches = server.commands.filter((command) => command.startsWith("UID FETCH"));
    expect(fetches.length).toBeGreaterThan(0);
    const reading = fetches.filter((fetch) => /BODY/i.test(fetch));
    expect(reading.length).toBeGreaterThan(0);
    for (const fetch of reading) expect(fetch).toMatch(/BODY\.PEEK\[\]/i);
    expect(server.commands.filter((command) => /^(SELECT|STORE|UID STORE|COPY|UID COPY|MOVE|UID MOVE|EXPUNGE|UID EXPUNGE|APPEND|DELETE|RENAME|CREATE)\b/.test(command))).toEqual([]);
  });

  it("reads on after the last UID in use when a folder holds nothing recent at first", async () => {
    server.deliver("Archiv", old, new Date("2026-08-01T08:00:00Z"));
    const first = await poll({ config: config({ folders: ["Archiv"] }) });
    expect(first.origins).toEqual([]);
    server.deliver("Archiv", moved, new Date("2026-09-15T10:00:00Z"));

    const { origins } = await poll({ config: config({ folders: ["Archiv"] }), syncCursor: first.syncCursor, now: new Date(now.getTime() + days) });

    expect(origins.map((origin) => origin.externalId)).toEqual(["<elternabend-2@schule.example.org>"]);
  });

  it("starts over when the folder's UIDVALIDITY changes", async () => {
    const { syncCursor } = await poll();
    const mailbox = server.folders.get("Schule")!;
    mailbox.uidValidity += 1;

    const again = await poll({ syncCursor });

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

describe("the IMAP plugin's folders as Source Attributes", () => {
  const mail = (id: string) => `From: a@b.example\nSubject: ${id}\nMessage-ID: <${id}@x.example>\nContent-Type: text/plain\n\nBody ${id}\n`;
  const received = new Date("2026-09-14T06:00:00Z");

  it("names a folder by its MAILBOXID where the server has OBJECTID, so that a rename keeps it", async () => {
    server.deliver("Objekte", mail("o1"), received);
    server.folders.get("Objekte")!.mailboxId = "F42";
    server.capabilities = ["OBJECTID"];
    const declared = recordingAttributes();
    try {
      const first = await poll({ config: config({ folders: ["Objekte"] }), attributes: declared });
      expect(first.origins.map((origin) => origin.attributes)).toEqual([["F42"]]);
      expect(declared.active()).toEqual(["F42"]);
    } finally {
      server.capabilities = [];
    }
  });

  it("names a folder by its name where the server has no OBJECTID", async () => {
    server.deliver("Namen", mail("n1"), received);
    server.folders.get("Namen")!.mailboxId = "ignored";

    const { origins } = await poll({ config: config({ folders: ["Namen"] }) });

    expect(origins.map((origin) => origin.attributes)).toEqual([["Namen"]]);
  });

  it("emits a mail moved between allow-listed folders again with the new folder, and withdraws one moved out of all", async () => {
    const uid = server.deliver("Von", mail("m1"), received);
    server.deliver("Nach", mail("m2"), received);
    const both = config({ folders: ["Von", "Nach"] });
    const first = await poll({ config: both });
    expect(first.origins.find((origin) => origin.externalId === "<m1@x.example>")?.attributes).toEqual(["Von"]);

    server.move("Von", uid, "Nach");
    const second = await poll({ config: both, syncCursor: first.syncCursor });
    expect(second.origins.map((origin) => [origin.externalId, origin.attributes])).toEqual([["<m1@x.example>", ["Nach"]]]);
    expect(second.withdrawn ?? []).toEqual([]);

    const moved = server.folders.get("Nach")!.messages.find((message) => message.raw.includes("m1@x.example"))!;
    server.move("Nach", moved.uid, "Papierkorb");
    const third = await poll({ config: both, syncCursor: second.syncCursor });
    expect(third.origins).toEqual([]);
    expect(third.withdrawn).toEqual(["<m1@x.example>"]);
  });
});

describe("the IMAP plugin on Gmail", () => {
  const gmail = new ImapServerFixture(account);
  const allMail = "[Gmail]/All Mail";
  const mailLabelled = (id: string) => `From: a@b.example\nSubject: ${id}\nMessage-ID: <${id}@g.example>\nContent-Type: text/plain\n\nBody ${id}\n`;
  const at = new Date("2026-09-14T06:00:00Z");
  let uid = 0;
  beforeAll(async () => {
    await gmail.start();
    gmail.capabilities = ["X-GM-EXT-1", "SPECIAL-USE"];
    gmail.deliver(allMail, mailLabelled("unlabelled"), at);
    gmail.folders.get(allMail)!.specialUse = "\\All";
    uid = gmail.deliverLabelled(allMail, ["\\Inbox", "Schule"], mailLabelled("schule"), at);
    gmail.deliverLabelled(allMail, ["Privat"], mailLabelled("privat"), at);
    gmail.deliverLabelled(allMail, ["\\Inbox"], mailLabelled("inbox"), at);
  });
  afterAll(async () => {
    await gmail.stop();
  });
  const gconfig = (folders: string[]): RunContext["config"] => ({
    plain: { host: "127.0.0.1", port: String(gmail.port), username: account.user, folders },
    secrets: { password: account.password },
  });
  const gpoll = (context: Partial<IngestContext>): Promise<IngestResult> => {
    const of = plugin();
    if (of.ingestion.mode !== "polling") throw new Error("the IMAP plugin polls");
    return of.ingestion.poll({ config: gconfig(["Schule"]), syncCursor: null, now, timeZone: "Europe/Berlin", attributes: recordingAttributes(), ...context });
  };

  it("reads All Mail once and names only the allow-listed labels of a mail", async () => {
    const declared = recordingAttributes();
    const { origins } = await gpoll({ config: gconfig(["Schule", "Fehlt"]), attributes: declared });

    expect(origins.map((origin) => [origin.externalId, origin.attributes])).toEqual([["<schule@g.example>", ["Schule"]]]);
    expect(declared.active().sort()).toEqual(["Fehlt", "Schule"]);
  });

  it("calls the Inbox label INBOX and ignores the mails without an allow-listed label", async () => {
    const { origins } = await gpoll({ config: gconfig(["INBOX", "Schule"]) });

    const named = Object.fromEntries(origins.map((origin) => [origin.externalId, origin.attributes]));
    expect(named).toEqual({ "<schule@g.example>": ["INBOX", "Schule"], "<inbox@g.example>": ["INBOX"] });
  });

  it("emits a mail again when its labels change, and withdraws it when it has none of the allow-listed ones", async () => {
    const both = gconfig(["INBOX", "Schule"]);
    const first = await gpoll({ config: both });
    gmail.folders.get(allMail)!.messages.find((message) => message.uid === uid)!.labels = ["Schule"];

    const second = await gpoll({ config: both, syncCursor: first.syncCursor });
    expect(second.origins.map((origin) => [origin.externalId, origin.attributes])).toEqual([["<schule@g.example>", ["Schule"]]]);

    gmail.folders.get(allMail)!.messages.find((message) => message.uid === uid)!.labels = ["Privat"];
    const third = await gpoll({ config: both, syncCursor: second.syncCursor });
    expect(third.origins).toEqual([]);
    expect(third.withdrawn).toEqual(["<schule@g.example>"]);
  });

  it("offers the Inbox and the user labels as choices, not All Mail or the other system folders", async () => {
    gmail.folders.set("INBOX", { uidValidity: 1, messages: [] });
    gmail.folders.set("Schule", { uidValidity: 1, messages: [] });
    gmail.folders.set("[Gmail]/Spam", { uidValidity: 1, messages: [], specialUse: "\\Junk" });

    const choices = await foldersField().choices?.({ config: gconfig([]), syncCursor: null, now, timeZone: "Europe/Berlin" });

    expect(choices).toEqual([
      { value: "INBOX", label: "INBOX" },
      { value: "Schule", label: "Schule" },
    ]);
  });
});

describe("the IMAP plugin's choice of folders", () => {
  it("offers the folders of the live server", async () => {
    const choices = await foldersField().choices?.({ config: config(), syncCursor: null, now, timeZone: "Europe/Berlin" });

    expect(choices?.map((choice) => choice.value)).toEqual(expect.arrayContaining(["INBOX", "Schule"]));
  });
});

function foldersField() {
  const field = plugin().configuration.fields.find((candidate) => candidate.key === "folders");
  if (!field) throw new Error("no folders field");
  return field;
}

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
