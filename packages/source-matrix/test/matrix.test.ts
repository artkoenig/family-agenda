import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { describeSourcePluginContract } from "@family-agenda/source-sdk/testing";
import { SourceError, type IngestResult, type Origin, type RunContext, type SetupProgress, type SourcePlugin } from "@family-agenda/source-sdk";
import { createMatrixPlugin } from "../src";
import { FakeHomeserver } from "../src/testing";

const now = new Date("2026-09-14T07:30:00Z");
const days = 24 * 60 * 60 * 1000;

const homeserver = new FakeHomeserver();
await homeserver.start();
afterAll(() => homeserver.close());

const plugin = () => createMatrixPlugin({ instance: homeserver.instance(), timeoutMs: 5000 });

/** Adds a Source as the core does: the plugin creates its Matrix user, whose values go into its configuration. */
async function addSource(of: SourcePlugin = plugin()): Promise<RunContext["config"]> {
  const config = { plain: { messenger: "whatsapp" }, secrets: {} };
  const prepared = await of.sourceAdded!({ config, now, timeZone: "Europe/Berlin" });
  return { plain: { ...config.plain, ...prepared.plain }, secrets: prepared.secrets };
}

const userOf = (config: RunContext["config"]) => config.plain.userId as string;

const poll = (config: RunContext["config"], state: string | null = null, of: SourcePlugin = plugin(), at = now): Promise<IngestResult> => {
  if (of.ingestion.mode !== "polling") throw new Error("the Matrix plugin polls");
  return of.ingestion.poll({ config, state, now: at, timeZone: "Europe/Berlin" });
};

const allowListing = (config: RunContext["config"], ...chats: string[]): RunContext["config"] => ({
  ...config,
  plain: { ...config.plain, chats },
});

const textOf = (origin: Origin | undefined) => {
  if (origin?.content.kind !== "raw-message") throw new Error("not a raw message");
  return origin.content.text;
};

/** A recorded `/sync` response, with the Source's own user and an uploaded PDF put in. */
function recorded(name: string, user: string, pdf = ""): never {
  const text = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(text.replaceAll("{{user}}", user).replaceAll("{{pdf}}", pdf)) as never;
}

// A Source linked to WhatsApp, reading one class group, for the contract tests.
const contractConfig = await addSource();
homeserver.setLogin(userOf(contractConfig), "CONNECTED");
const contractRoom = homeserver.createRoom("Klasse 5b Eltern", { [homeserver.ghost("4917612345678")]: "Frau Berger (WA)" });
homeserver.addMember(contractRoom, userOf(contractConfig));
homeserver.text(contractRoom, homeserver.ghost("4917612345678"), "Elternabend am Donnerstag um 19:30 Uhr.", new Date("2026-09-14T06:00:00Z"));

describeSourcePluginContract(plugin, {
  config: allowListing(contractConfig, contractRoom),
  now,
  languages: ["de"],
  packageJson: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
});

describe("recorded /sync responses", () => {
  const klasse = "!kTWfeGdLqDbHpZoRsX:family-agenda.local";
  const club = "!nEwClubRoomFussball:family-agenda.local";
  let config: RunContext["config"];
  beforeEach(async () => {
    config = allowListing(await addSource(), klasse, club);
    homeserver.setLogin(userOf(config), "CONNECTED");
  });

  it("turns the messages of allow-listed chats into raw messages, and nothing else", async () => {
    const pdf = homeserver.upload(new TextEncoder().encode("%PDF-1.4\n"));
    homeserver.replaySync(userOf(config), [recorded("sync-initial", userOf(config), pdf)]);

    const { origins } = await poll(config);

    expect(origins.map((origin) => origin.externalId)).toEqual([
      "$WnDtrip5bfriday0aTreffpunktSchultor8Uhr0001",
      "$PdFeinverstaendniserklaerungMittwoch000002",
      "$ReplyJonasPapaMitbringen0000000000000003",
    ]);
    expect(origins[0]).toEqual({
      externalId: "$WnDtrip5bfriday0aTreffpunktSchultor8Uhr0001",
      occurredAt: new Date("2026-09-14T06:12:00Z"),
      attributes: { messenger: "WhatsApp", chat: "Klasse 5b Eltern", sender: "Frau Berger (WA)" },
      content: {
        kind: "raw-message",
        text: "Liebe Eltern, am Freitag, 18.09., ist Wandertag. Treffpunkt 8:00 Uhr am Schultor.",
        attachments: [],
        thread: "$WnDtrip5bfriday0aTreffpunktSchultor8Uhr0001",
      },
    });
    expect(origins[1]?.content).toMatchObject({
      text: "Hier die Einverständniserklärung, bitte bis Mittwoch zurück.",
      attachments: [{ filename: "einverstaendnis.pdf", contentType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4\n") }],
    });
    // A reply belongs to the conversation of the message it answers.
    expect(origins[2]?.content).toMatchObject({ thread: "$WnDtrip5bfriday0aTreffpunktSchultor8Uhr0001" });
    expect(origins[2]?.attributes.sender).toBe("Jonas' Papa (WA)");
  });

  it("accepts only invitations of its own bridge", async () => {
    homeserver.replaySync(userOf(config), [recorded("sync-initial", userOf(config))]);

    await poll(config);

    const joins = homeserver.requests.filter((request) => request.includes("/join"));
    expect(joins).toContain(`POST /_matrix/client/v3/rooms/${encodeURIComponent(club)}/join`);
    expect(joins.some((request) => request.includes("evil.example"))).toBe(false);
  });

  it("withdraws redacted messages", async () => {
    homeserver.replaySync(userOf(config), [recorded("sync-initial", userOf(config)), recorded("sync-redaction", userOf(config))]);
    const first = await poll(config);

    const second = await poll(config, first.state);

    expect(second.origins).toEqual([]);
    expect(second.withdrawn).toEqual(["$WnDtrip5bfriday0aTreffpunktSchultor8Uhr0001", "$PrivateOmaKaffeeSonntag00000000000000006"]);
  });

  it("reads the bridge's backfill as ordinary messages, with their send times", async () => {
    homeserver.replaySync(userOf(config), [recorded("sync-initial", userOf(config)), recorded("sync-backfill", userOf(config))]);
    const first = await poll(config);

    const { origins, state } = await poll(config, first.state);

    expect(origins.map((origin) => [origin.occurredAt.toISOString(), origin.attributes.chat, textOf(origin)])).toEqual([
      ["2026-09-12T08:00:00.000Z", "FC Eltern U11", "Training am Dienstag fällt aus, Platz gesperrt."],
      ["2026-09-13T06:13:20.000Z", "FC Eltern U11", "Samstag Turnier in Musterstadt, Abfahrt 9 Uhr."],
    ]);
    // The chats a Source can allow-list are named as the bridge names them.
    const choices = await plugin().configuration.fields.find((field) => field.key === "chats")!.choices!({ config, state, now, timeZone: "Europe/Berlin" });
    expect(choices).toEqual([
      { value: club, label: "FC Eltern U11" },
      { value: klasse, label: "Klasse 5b Eltern" },
      { value: "!aBcPrivatFamilieChat:family-agenda.local", label: "Oma (WA)" },
    ]);
  });
});

describe("the bridge's login states", () => {
  let config: RunContext["config"];
  beforeEach(async () => {
    config = await addSource();
  });

  const failure = async () => {
    try {
      await poll(config);
    } catch (error) {
      if (error instanceof SourceError) return { kind: error.kind, message: error.message };
      throw error;
    }
    throw new Error("the run did not fail");
  };

  it("is a definite error before the account is linked", async () => {
    expect(await failure()).toEqual({ kind: "definite", message: "The WhatsApp account is not linked. Press Fix to scan the QR code." });
  });

  it("is a definite error once the account is logged out", async () => {
    homeserver.setLogin(userOf(config), "LOGGED_OUT", "Unlinked from the phone");

    expect(await failure()).toEqual({
      kind: "definite",
      message: "The WhatsApp account was logged out (Unlinked from the phone). Press Fix to scan the QR code again.",
    });
  });

  it("reads while the bridge reconnects", async () => {
    homeserver.setLogin(userOf(config), "TRANSIENT_DISCONNECT");

    await expect(poll(config)).resolves.toMatchObject({ origins: [] });
  });

  it("is a temporary error while the bridge does not answer", async () => {
    homeserver.bridgeRunning = false;
    try {
      expect((await failure()).kind).toBe("temporary");
    } finally {
      homeserver.bridgeRunning = true;
    }
  });

  it("is a definite error once the homeserver no longer knows the Source's user", async () => {
    homeserver.setLogin(userOf(config), "CONNECTED");

    config = { ...config, secrets: { accessToken: "syt_forgotten" } };

    expect((await failure()).kind).toBe("definite");
  });
});

describe("linking the account by QR code", () => {
  it("shows the bridge's QR codes until the phone scans one", async () => {
    const of = plugin();
    const config = await addSource(of);
    const step = of.setupSteps.find((candidate) => candidate.id === "login")!;
    const progress = (): Promise<SetupProgress> => step.progress!({ config, state: null, now, timeZone: "Europe/Berlin" });

    const first = await progress();
    expect(first).toMatchObject({ status: "waiting", qrCode: expect.stringMatching(/^2@qr-code-\d+$/) as unknown });
    expect(await progress()).toEqual(first);

    await waitUntil(() => Promise.resolve(homeserver.awaitsScan(userOf(config))));
    homeserver.refreshQr(userOf(config));
    const qrCode = async () => {
      const shown = await progress();
      return shown.status === "waiting" ? shown.qrCode : null;
    };
    await waitUntil(async () => (await qrCode()) !== (first.status === "waiting" ? first.qrCode : null));
    expect(await qrCode()).toMatch(/^2@qr-code-\d+$/);

    await waitUntil(() => Promise.resolve(homeserver.awaitsScan(userOf(config))));
    homeserver.scanQr(userOf(config));
    await waitUntil(async () => (await progress()).status === "done");
    // Once linked, the Source reads.
    await expect(poll(config)).resolves.toMatchObject({ origins: [] });
  });

  it("says it is done for an account already linked", async () => {
    const of = plugin();
    const config = await addSource(of);
    homeserver.setLogin(userOf(config), "CONNECTED");

    expect(await of.setupSteps[0]!.progress!({ config, state: null, now, timeZone: "Europe/Berlin" })).toMatchObject({ status: "done" });
  });
});

describe("chats", () => {
  let config: RunContext["config"];
  let room: string;
  const sender = homeserver.ghost("4917612345678");
  beforeEach(async () => {
    config = await addSource();
    homeserver.setLogin(userOf(config), "CONNECTED");
    room = homeserver.createRoom("Klasse 5b Eltern", { [sender]: "Frau Berger (WA)" });
    homeserver.invite(room, userOf(config));
  });

  it("are read only once allow-listed, then back for two weeks", async () => {
    homeserver.text(room, sender, "Vor drei Wochen: Schulfest.", new Date(now.getTime() - 21 * days));
    homeserver.text(room, sender, "Vor einer Woche: Wandertag am Freitag.", new Date(now.getTime() - 7 * days));
    const first = await poll(config);
    expect(first.origins).toEqual([]);
    expect(homeserver.isMember(room, userOf(config))).toBe(true);

    const second = await poll(allowListing(config, room), first.state);

    expect(second.origins.map(textOf)).toEqual(["Vor einer Woche: Wandertag am Freitag."]);
    const third = await poll(allowListing(config, room), second.state);
    expect(third.origins).toEqual([]);
  });

  it("are read back when the timeline since the last run was cut short", async () => {
    const first = await poll(allowListing(config, room));
    for (let message = 1; message <= 60; message++) {
      homeserver.text(room, sender, `Nachricht ${message}`, new Date(now.getTime() - 60_000 + message * 1000));
    }

    const { origins } = await poll(allowListing(config, room), first.state);

    expect(origins.map(textOf)).toEqual(Array.from({ length: 60 }, (_, index) => `Nachricht ${index + 1}`));
  });

  it("keep an edit as a message of its own in the edited message's conversation", async () => {
    const first = await poll(allowListing(config, room));
    const original = homeserver.text(room, sender, "Elternabend um 19 Uhr", now);
    homeserver.send(
      room,
      sender,
      {
        msgtype: "m.text",
        body: "* Elternabend um 19:30 Uhr",
        "m.new_content": { msgtype: "m.text", body: "Elternabend um 19:30 Uhr" },
        "m.relates_to": { rel_type: "m.replace", event_id: original },
      },
      now,
    );

    const { origins } = await poll(allowListing(config, room), first.state);

    expect(origins.map((origin) => [textOf(origin), origin.content.kind === "raw-message" ? origin.content.thread : null])).toEqual([
      ["Elternabend um 19 Uhr", original],
      ["Elternabend um 19:30 Uhr", original],
    ]);
  });

  it("are never written to, marked read or shown as typing, and nobody else's invitation is accepted", async () => {
    const stranger = homeserver.createRoom("Gewinnspiel");
    homeserver.invite(stranger, userOf(config), "@spam:other.example");
    const first = await poll(allowListing(config, room));
    homeserver.text(room, sender, "Bitte bestätigen!", now);
    await poll(allowListing(config, room), first.state);

    expect(homeserver.isMember(stranger, userOf(config))).toBe(false);
    const writes = homeserver.requests.filter((request) => /\/(send|receipt|read_markers|typing|presence|state)\//.test(request));
    expect(writes).toEqual([]);
  });
});

describe("the catalogue of Messengers", () => {
  it("lists WhatsApp as installed while its bridge runs", async () => {
    expect((await plugin().catalogue!.entries()).map(({ id, installed }) => ({ id, installed }))).toEqual([{ id: "whatsapp", installed: true }]);

    homeserver.bridgeRunning = false;
    try {
      expect((await plugin().catalogue!.entries())[0]?.installed).toBe(false);
    } finally {
      homeserver.bridgeRunning = true;
    }
  });

  it("lists WhatsApp as not installed without the Matrix profile", async () => {
    const without = createMatrixPlugin({ instance: "/nonexistent/instance.json" });

    expect((await without.catalogue!.entries())[0]).toMatchObject({ id: "whatsapp", installed: false, riskNotice: expect.anything() as unknown });
    await expect(poll({ plain: { messenger: "whatsapp", userId: "@x:y" }, secrets: { accessToken: "t" } }, null, without)).rejects.toThrow(
      "Matrix is not set up on this Instance",
    );
  });
});

describe("a removed Source", () => {
  it("unlinks its account from the Messenger and signs its Matrix user out", async () => {
    const of = plugin();
    const config = await addSource(of);
    homeserver.setLogin(userOf(config), "CONNECTED");

    await of.sourceRemoved!({ config, state: null, now, timeZone: "Europe/Berlin" });

    await expect(poll(config)).rejects.toThrow("The WhatsApp account is not linked.");
    homeserver.setLogin(userOf(config), "CONNECTED");
    await expect(poll(config)).rejects.toThrow("no longer knows the Source's Matrix user");
  });
});

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}
