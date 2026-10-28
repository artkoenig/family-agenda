import { randomBytes } from "node:crypto";
import {
  sdkVersion,
  SourceError,
  type Attachment,
  type Choice,
  type Origin,
  type PluginText,
  type RunContext,
  type SetupProgress,
  type SourcePlugin,
} from "@family-agenda/source-sdk";
import {
  bridgeClient,
  HomeserverError,
  homeserverClient,
  type BridgeClient,
  type HomeserverClient,
  type MatrixEvent,
  type SyncResponse,
} from "./homeserver";
import { defaultInstanceFile, instanceReader, type MatrixInstance } from "./instance";
import { messengerOf, messengers, type Messenger } from "./messengers";

export type { MatrixInstance } from "./instance";
export { messengers } from "./messengers";

export type MatrixPluginOptions = {
  /** The Instance's Matrix setup, or the file the Matrix profile writes it to. */
  instance?: MatrixInstance | string;
  /** How long a request to the homeserver or a bridge may take before the run fails. */
  timeoutMs?: number;
};

/**
 * The state blob: where `/sync` resumes, the names of the joined rooms and of the senders seen,
 * the allow-listed rooms read so far, so that a room allow-listed later is read back first, and
 * the edits of each message read, which go with it when it is redacted.
 */
type State = {
  since: string;
  rooms: Record<string, string>;
  names: Record<string, string>;
  read: string[];
  edits: Record<string, string[]>;
};

/** How far back a newly allow-listed chat is read, so that a busy group does not bring years of messages. */
const backfillDays = 14;

/** How many events of one room a run reads back at most, through `/messages`. */
const maximumBackfillEvents = 500;

/** The largest attachment kept, such as a PDF; larger ones are left out. */
const maximumAttachmentBytes = 25 * 1024 * 1024;

/** Message types whose `body` is the text of the message. */
const textTypes = new Set(["m.text", "m.notice", "m.emote"]);

/** Message types whose file is kept as an attachment. */
const fileTypes = new Set(["m.file", "m.image"]);

/** Login states of a bridge in which the account still works, if perhaps not at the moment. */
const workingStates = new Set(["CONNECTED", "BACKFILLING", "CONNECTING", "TRANSIENT_DISCONNECT", "RUNNING", "STARTING"]);

/** Login states that need an Admin to link the account again. */
const loggedOutStates = new Set(["LOGGED_OUT", "BAD_CREDENTIALS"]);

/** A QR code login going on for a Matrix user, kept while the Admin area polls it. */
type LoginSession = { qrCode: string | null; outcome: "waiting" | "done" | { failed: string } };

/**
 * Reads Messengers such as WhatsApp through bridges on the Instance's own homeserver (ADR-0011).
 * Each Source is one linked Messenger account, read by a Matrix user the plugin creates for it.
 * It only receives: its users never post, never mark a room read, and join only rooms their own
 * bridge invites them to.
 */
export function createMatrixPlugin(options: MatrixPluginOptions = {}): SourcePlugin {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const readInstance = instanceReader(options.instance ?? process.env.MATRIX_INSTANCE_FILE ?? defaultInstanceFile);
  const sessions = new Map<string, LoginSession>();

  /** The homeserver and the bridge of a Source's Messenger, or why it cannot be read. */
  async function connectionOf(plain: RunContext["config"]["plain"]): Promise<{
    instance: MatrixInstance;
    homeserver: HomeserverClient;
    messenger: Messenger;
    bridge: BridgeClient;
  }> {
    const messenger = messengerOf(plain.messenger);
    if (!messenger) throw SourceError.definite(`"${JSON.stringify(plain.messenger)}" is no Messenger the Matrix plugin knows.`);
    let instance: MatrixInstance | null;
    try {
      instance = await readInstance();
    } catch (error) {
      throw SourceError.temporary(`The Matrix setup could not be read: ${messageOf(error)}`);
    }
    if (!instance) throw SourceError.definite("Matrix is not set up on this Instance: enable the Matrix Compose profile.");
    const bridge = instance.bridges[messenger.id];
    if (!bridge) throw SourceError.definite(`The ${messenger.attributeValue} bridge is not set up on this Instance.`);
    return {
      instance,
      messenger,
      homeserver: homeserverClient({ url: instance.homeserver.url, timeoutMs }),
      bridge: bridgeClient({ url: bridge.url, secret: bridge.provisioningSecret, timeoutMs }),
    };
  }

  function accountOf(context: RunContext): { userId: string; token: string } {
    const userId = context.config.plain.userId;
    const token = context.config.secrets.accessToken;
    if (typeof userId !== "string" || !token) throw SourceError.definite("The Source has no Matrix account. Remove it and add it again.");
    return { userId, token };
  }

  /** Fails the run unless the bridge has a working login for the Source's account. */
  async function checkLogin(bridge: BridgeClient, messenger: Messenger, userId: string): Promise<void> {
    let logins;
    try {
      logins = await bridge.logins(userId);
    } catch (error) {
      throw SourceError.temporary(`The ${messenger.attributeValue} bridge could not be reached: ${messageOf(error)}`);
    }
    if (logins.some((login) => workingStates.has(login.stateEvent))) return;
    const name = messenger.attributeValue;
    if (logins.length === 0) throw SourceError.definite(`The ${name} account is not linked. Press Fix to scan the QR code.`);
    if (logins.some((login) => loggedOutStates.has(login.stateEvent))) {
      const reason = logins.map((login) => login.reason).find((found) => found !== null);
      throw SourceError.definite(`The ${name} account was logged out${reason ? ` (${reason})` : ""}. Press Fix to scan the QR code again.`);
    }
    throw SourceError.temporary(`The ${name} bridge reports a problem with the account.`);
  }

  async function poll(context: RunContext) {
    const { homeserver, messenger, bridge, instance } = await connectionOf(context.config.plain);
    const { userId, token } = accountOf(context);
    await checkLogin(bridge, messenger, userId);
    const previous = parseState(context.state);
    const allowListed = new Set(chatsOf(context.config.plain.chats));
    const backfillStart = context.now.getTime() - backfillDays * 24 * 60 * 60 * 1000;

    try {
      const sync = await homeserver.sync(token, previous?.since ?? null);
      const state: State = {
        since: sync.next_batch,
        rooms: { ...previous?.rooms },
        names: { ...previous?.names },
        read: [],
        edits: { ...previous?.edits },
      };
      const left = new Set(Object.keys(sync.rooms?.leave ?? {}));
      state.rooms = Object.fromEntries(Object.entries(state.rooms).filter(([roomId]) => !left.has(roomId)));
      // A chat joined now can be allow-listed at once, though its messages come with the next run.
      for (const [roomId, name] of await acceptInvites(sync, { homeserver, userId, token, messenger, serverName: instance.homeserver.serverName })) {
        state.rooms[roomId] = name;
      }

      const withdrawn = new Set<string>();
      const events = new Map<string, { roomId: string; event: MatrixEvent }>();
      const take = (roomId: string, list: MatrixEvent[]) => {
        for (const event of list) {
          learn(state, roomId, event);
          if (event.type === "m.room.redaction") {
            const redacts = event.redacts ?? event.content.redacts;
            if (typeof redacts === "string") withdrawn.add(redacts);
          } else if (allowListed.has(roomId) && event.event_id) {
            events.set(event.event_id, { roomId, event });
          }
        }
      };

      for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
        for (const event of room.state?.events ?? []) learn(state, roomId, event);
        state.rooms[roomId] ??= roomId;
        take(roomId, room.timeline?.events ?? []);
        const isNew = previous !== null && !previous.read.includes(roomId);
        // A timeline cut short leaves out messages since the last run, which are read back.
        if (allowListed.has(roomId) && !isNew && room.timeline?.limited && room.timeline.prev_batch) {
          take(roomId, await readBack(homeserver, token, roomId, room.timeline.prev_batch, previous?.since ?? null, backfillStart));
        }
      }
      // A chat allow-listed since the last run is read back for some days.
      for (const roomId of allowListed) {
        if (!previous || previous.read.includes(roomId) || !(roomId in state.rooms)) continue;
        take(roomId, await readBack(homeserver, token, roomId, sync.next_batch, null, backfillStart));
      }

      // Chats allow-listed but not joined yet are read back once they are.
      state.read = [...allowListed].filter((roomId) => roomId in state.rooms);
      // An edit is a message of its own, which goes when the message it edits is redacted.
      for (const { event } of events.values()) {
        const edited = editedBy(event);
        if (edited && event.event_id) state.edits[edited] = [...new Set([...(state.edits[edited] ?? []), event.event_id])];
      }
      for (const redacted of [...withdrawn]) for (const edit of state.edits[redacted] ?? []) withdrawn.add(edit);
      state.edits = Object.fromEntries(Object.entries(state.edits).filter(([edited]) => !withdrawn.has(edited)));

      const origins: Origin[] = [];
      for (const { roomId, event } of events.values()) {
        if (withdrawn.has(event.event_id ?? "")) continue;
        const origin = await originOf(event, roomId, { state, userId, token, messenger, homeserver, serverName: instance.homeserver.serverName });
        if (origin) origins.push(origin);
      }
      origins.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
      return { origins, state: JSON.stringify(state), withdrawn: [...withdrawn] };
    } catch (error) {
      throw homeserverError(error);
    }
  }

  async function progress(context: RunContext): Promise<SetupProgress> {
    const { messenger, bridge } = await connectionOf(context.config.plain);
    const { userId } = accountOf(context);
    const session = sessions.get(userId);
    if (session && session.outcome !== "waiting") {
      sessions.delete(userId);
      if (session.outcome === "done") return { status: "done", message: linked(messenger) };
      return { status: "failed", message: session.outcome.failed };
    }
    if (session) return waiting(messenger, session.qrCode);
    try {
      if ((await bridge.logins(userId)).some((login) => workingStates.has(login.stateEvent))) {
        return { status: "done", message: linked(messenger) };
      }
      const step = await bridge.startLogin(userId, messenger.qrLoginFlow);
      if (step.type === "complete") return { status: "done", message: linked(messenger) };
      if (step.type !== "display_and_wait") return { status: "failed", message: step.instructions };
      const started: LoginSession = { qrCode: step.qrCode, outcome: "waiting" };
      sessions.set(userId, started);
      void awaitScan(bridge, userId, step, started);
      return waiting(messenger, started.qrCode);
    } catch (error) {
      return { status: "failed", message: `The ${messenger.attributeValue} bridge could not start the login: ${messageOf(error)}` };
    }
  }

  return {
    identity: { sourceTypeId: "matrix", displayName: { en: "Matrix", de: "Matrix" }, version: "0.1.0", sdkVersion },
    configuration: {
      version: 1,
      fields: [
        {
          key: "messenger",
          label: { en: "Messenger", de: "Messenger" },
          secret: false,
          required: true,
          description: {
            en: "The Messenger whose account this Source links. It cannot be changed later.",
            de: "Der Messenger, dessen Konto diese Quelle verknüpft. Er lässt sich später nicht ändern.",
          },
        },
        {
          key: "chats",
          label: { en: "Chats to read", de: "Zu lesende Chats" },
          secret: false,
          required: false,
          description: {
            en: "Only messages in the ticked chats are read, and sent to the LLM endpoint; all others are ignored. A chat ticked later is read back for two weeks.",
            de: "Nur Nachrichten in den angehakten Chats werden gelesen und an den LLM-Endpunkt geschickt; alle anderen werden ignoriert. Ein später angehakter Chat wird zwei Wochen zurück gelesen.",
          },
          choices: (context) => Promise.resolve(chatChoices(context)),
        },
        { key: "userId", label: { en: "Matrix user", de: "Matrix-Benutzer" }, secret: false, required: true, setByPlugin: true },
        { key: "accessToken", label: { en: "Access token", de: "Zugriffstoken" }, secret: true, required: true, setByPlugin: true },
      ],
    },
    setupSteps: [
      {
        id: "login",
        title: { en: "Link the account", de: "Konto verknüpfen" },
        description: {
          en: "Scan the QR code with the Messenger's app on the phone whose account the Family reads, as a linked device.",
          de: "Scanne den QR-Code mit der App des Messengers auf dem Handy, dessen Konto die Familie liest, als verknüpftes Gerät.",
        },
        progress,
      },
    ],
    ingestion: { mode: "polling", suggestedIntervalSeconds: 5 * 60, poll },
    originAttributes: [
      {
        key: "messenger",
        label: { en: "Messenger", de: "Messenger" },
        knownValues: () => Promise.resolve(messengers.map(({ attributeValue }) => ({ value: attributeValue, label: attributeValue }))),
      },
      {
        key: "chat",
        label: { en: "Chat", de: "Chat" },
        knownValues: (context) => {
          const chats = new Set(chatsOf(context.config.plain.chats));
          const allowListed = chatChoices(context).filter((choice) => chats.has(choice.value));
          return Promise.resolve(allowListed.map(({ label }) => ({ value: label, label })));
        },
      },
      {
        key: "sender",
        label: { en: "Sender", de: "Absender" },
        knownValues: (context) => {
          const names = [...new Set(Object.values(parseState(context.state)?.names ?? {}))].sort();
          return Promise.resolve(names.map((name) => ({ value: name, label: name })));
        },
      },
    ],
    // Class and club groups pause for weeks in the holidays.
    health: { silentApplies: false },
    catalogue: {
      title: { en: "Messengers", de: "Messenger" },
      configKey: "messenger",
      async entries() {
        const instance = await readInstance().catch(() => null);
        const entries = [];
        for (const messenger of messengers) {
          const bridge = instance?.bridges[messenger.id];
          const installed = bridge ? await bridgeClient({ url: bridge.url, secret: bridge.provisioningSecret, timeoutMs: 3000 }).running() : false;
          entries.push({
            id: messenger.id,
            displayName: messenger.displayName,
            description: messenger.description,
            installed,
            ...(messenger.riskNotice ? { riskNotice: messenger.riskNotice } : {}),
          });
        }
        return entries;
      },
    },
    async sourceAdded(context) {
      const { instance, homeserver } = await connectionOf(context.config.plain);
      try {
        const account = await homeserver.register(`family-agenda-${randomBytes(6).toString("hex")}`, instance.homeserver.registrationSharedSecret);
        return { plain: { userId: account.userId }, secrets: { accessToken: account.accessToken } };
      } catch (error) {
        throw SourceError.temporary(`The homeserver could not create a Matrix user: ${messageOf(error)}`);
      }
    },
    async sourceRemoved(context) {
      const { homeserver, bridge } = await connectionOf(context.config.plain);
      const { userId, token } = accountOf(context);
      sessions.delete(userId);
      // Unlinks the device from the Messenger account, then signs the Matrix user out.
      await bridge.logoutAll(userId).catch(() => undefined);
      await homeserver.logout(token);
    },
  };
}

export default createMatrixPlugin();

/** Waits for the QR code to be scanned in the background, showing each new code the bridge sends. */
async function awaitScan(
  bridge: BridgeClient,
  userId: string,
  first: { loginId: string; stepId: string },
  session: LoginSession,
): Promise<void> {
  let step = first;
  try {
    for (;;) {
      const next = await bridge.waitForStep(userId, step);
      if (next.type === "complete") {
        session.outcome = "done";
        return;
      }
      if (next.type !== "display_and_wait") {
        session.outcome = { failed: next.instructions };
        return;
      }
      session.qrCode = next.qrCode;
      step = next;
    }
  } catch (error) {
    session.outcome = { failed: `The login did not finish: ${messageOf(error)}` };
  }
}

function waiting(messenger: Messenger, qrCode: string | null): SetupProgress {
  return { status: "waiting", ...(qrCode ? { qrCode } : {}), message: messenger.scanHint };
}

function linked(messenger: Messenger): PluginText {
  return { en: `The ${messenger.attributeValue} account is linked.`, de: `Das ${messenger.attributeValue}-Konto ist verknüpft.` };
}

/**
 * Joins the rooms the Messenger's bridge invites the user to; every other invitation stays
 * unanswered. Returns the rooms joined, with their names.
 */
async function acceptInvites(
  sync: SyncResponse,
  bridge: { homeserver: HomeserverClient; userId: string; token: string; messenger: Messenger; serverName: string },
): Promise<Map<string, string>> {
  const joined = new Map<string, string>();
  for (const [roomId, room] of Object.entries(sync.rooms?.invite ?? {})) {
    const events = room.invite_state?.events ?? [];
    const invitation = events.find(
      (event) => event.type === "m.room.member" && event.state_key === bridge.userId && event.content.membership === "invite",
    );
    if (!invitation || !isOfBridge(invitation.sender, bridge.messenger, bridge.serverName)) continue;
    try {
      await bridge.homeserver.join(bridge.token, roomId);
    } catch {
      // An invitation that cannot be accepted now stays, and is accepted on a later run.
      continue;
    }
    const name = events.find((event) => event.type === "m.room.name")?.content.name;
    joined.set(roomId, typeof name === "string" && name.trim() !== "" ? name.trim() : roomId);
  }
  return joined;
}

/** Whether a Matrix user is the Messenger's bridge bot or one of its ghosts on this homeserver. */
function isOfBridge(userId: string, messenger: Messenger, serverName: string): boolean {
  const match = /^@([^:]+):(.+)$/.exec(userId);
  if (!match || match[2] !== serverName) return false;
  const localpart = match[1] ?? "";
  return localpart === messenger.botLocalpart || localpart.startsWith(messenger.ghostPrefix);
}

/** Remembers room names and the display names of senders from state events. */
function learn(state: State, roomId: string, event: MatrixEvent): void {
  if (event.type === "m.room.name" && typeof event.content.name === "string" && event.content.name.trim() !== "") {
    state.rooms[roomId] = event.content.name.trim();
  }
  if (event.type === "m.room.member" && event.state_key && typeof event.content.displayname === "string") {
    state.names[event.state_key] = event.content.displayname;
  }
}

/**
 * Reads a room back through `/messages`, newest first, from `from` down to `to` or to `since`,
 * and returns its events oldest first.
 */
async function readBack(
  homeserver: HomeserverClient,
  token: string,
  roomId: string,
  from: string,
  to: string | null,
  since: number | null,
): Promise<MatrixEvent[]> {
  const events: MatrixEvent[] = [];
  let next: string | undefined = from;
  while (next && events.length < maximumBackfillEvents) {
    const page = await homeserver.messages(token, roomId, next, to, 100);
    if (page.chunk.length === 0) break;
    for (const event of page.state ?? []) events.push(event);
    let reachedSince = false;
    for (const event of page.chunk) {
      if (since !== null && (event.origin_server_ts ?? 0) < since) {
        reachedSince = true;
        break;
      }
      events.push(event);
    }
    if (reachedSince || page.end === next) break;
    next = page.end;
  }
  return events.reverse();
}

/** A message of an allow-listed room as an Origin; null for anything that is not one to read. */
async function originOf(
  event: MatrixEvent,
  roomId: string,
  context: { state: State; userId: string; token: string; messenger: Messenger; homeserver: HomeserverClient; serverName: string },
): Promise<Origin | null> {
  const { state, messenger } = context;
  if (event.type !== "m.room.message" || !event.event_id || event.unsigned?.redacted_because !== undefined) return null;
  if (event.sender === context.userId || event.sender === `@${messenger.botLocalpart}:${context.serverName}`) return null;
  const relation = event.content["m.relates_to"] as { rel_type?: string; event_id?: string; "m.in_reply_to"?: { event_id?: string } } | undefined;
  // An edit stands for the message it changes, with its new text.
  const content = relation?.rel_type === "m.replace" && isObject(event.content["m.new_content"]) ? event.content["m.new_content"] : event.content;
  const msgtype = content.msgtype;
  const body = typeof content.body === "string" ? content.body.trim() : "";
  let text = "";
  const attachments: Attachment[] = [];
  if (typeof msgtype === "string" && textTypes.has(msgtype)) text = body;
  if (typeof msgtype === "string" && fileTypes.has(msgtype)) {
    const filename = typeof content.filename === "string" && content.filename !== "" ? content.filename : body || "attachment";
    // A file's body is its caption when it differs from its name.
    if (body !== "" && body !== filename) text = body;
    const info = isObject(content.info) ? content.info : {};
    const size = typeof info.size === "number" ? info.size : 0;
    if (typeof content.url === "string" && size <= maximumAttachmentBytes) {
      const bytes = await context.homeserver.download(context.token, content.url, maximumAttachmentBytes);
      const contentType = typeof info.mimetype === "string" ? info.mimetype : "application/octet-stream";
      if (bytes) attachments.push({ filename, contentType, bytes });
    }
  }
  if (text === "" && attachments.length === 0) return null;
  const thread =
    relation?.rel_type === "m.replace" || relation?.rel_type === "m.thread"
      ? relation.event_id
      : (relation?.["m.in_reply_to"]?.event_id ?? event.event_id);
  return {
    externalId: event.event_id,
    occurredAt: new Date(event.origin_server_ts ?? Date.now()),
    attributes: {
      messenger: messenger.attributeValue,
      chat: state.rooms[roomId] ?? roomId,
      sender: state.names[event.sender] ?? event.sender,
    },
    content: { kind: "raw-message", text, attachments, ...(thread ? { thread } : {}) },
  };
}

/** The message an edit changes; none for any other event. */
function editedBy(event: MatrixEvent): string | null {
  const relation = event.content["m.relates_to"];
  if (!isObject(relation) || relation.rel_type !== "m.replace") return null;
  return typeof relation.event_id === "string" ? relation.event_id : null;
}

/** The joined rooms a Source can allow-list, by name. */
function chatChoices(context: RunContext): Choice[] {
  const rooms = parseState(context.state)?.rooms ?? {};
  return Object.entries(rooms)
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function chatsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((chat): chat is string => typeof chat === "string") : [];
}

function parseState(state: string | null): State | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(state) as Partial<State>;
    if (typeof parsed.since !== "string") return null;
    return {
      since: parsed.since,
      rooms: isObject(parsed.rooms) ? parsed.rooms : {},
      names: isObject(parsed.names) ? parsed.names : {},
      read: Array.isArray(parsed.read) ? parsed.read.filter((room): room is string => typeof room === "string") : [],
      edits: isObject(parsed.edits) ? parsed.edits : {},
    };
  } catch {
    return null;
  }
}

/** A user that no longer exists, or a token it lost, needs an Admin; anything else may pass. */
function homeserverError(error: unknown): SourceError {
  if (error instanceof SourceError) return error;
  if (error instanceof HomeserverError && error.errcode === "M_UNKNOWN_TOKEN") {
    return SourceError.definite("The homeserver no longer knows the Source's Matrix user. Remove the Source and add it again.");
  }
  return SourceError.temporary(`The homeserver could not be read: ${messageOf(error)}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
