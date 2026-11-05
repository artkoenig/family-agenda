import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  englishOf,
  sdkVersion,
  SourceError,
  type Attachment,
  type Choice,
  type Origin,
  type PluginText,
  type IngestContext,
  type RunContext,
  type SetupProgress,
  type Services,
  type SourcePlugin,
} from "@family-agenda/source-sdk";
import {
  bridgeClient,
  HomeserverError,
  homeserverClient,
  type BridgeClient,
  type HomeserverClient,
  type Invites,
  type JoinedRoom,
  type MatrixEvent,
  type SyncResponse,
} from "./homeserver";
import { defaultInstanceFile, instanceReader, type MatrixInstance } from "./instance";
import { messengerOf, messengers, type Messenger } from "./messengers";
import { defaultPrograms, isInstalled, matrixServices, readProblem, type MatrixPrograms } from "./services";

export type { MatrixInstance } from "./instance";
export { messengers } from "./messengers";

export type MatrixPluginOptions = {
  /** The Instance's Matrix setup, or the file the worker writes it to. */
  instance?: MatrixInstance | string;
  /** How long a request to the homeserver or a bridge may take before the run fails. */
  timeoutMs?: number;
  /** Synapse and the bridges the image ships; by default at their places in the image. */
  programs?: MatrixPrograms;
  /** How long adding a Source waits for the homeserver, which takes a while to start the first time. */
  startTimeoutMs?: number;
};

/**
 * The sync cursor: where `/sync` resumes, the names of the joined rooms and of the senders seen,
 * whether each joined room is a group chat, the WhatsApp JID the bridge gives each room, the
 * bridge's invitations not accepted yet, which `/sync` names only once, the allow-listed rooms
 * read so far, so that a room allow-listed later is read back first, the groups declared as
 * Source Attributes by their JID, and the edits of each message read, which go with it when it is
 * redacted.
 */
type State = {
  since: string;
  rooms: Record<string, string>;
  groups: Record<string, boolean>;
  jids: Record<string, string>;
  declared: string[];
  invites: Record<string, string>;
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

/** Room types the bridge marks rooms with that are not group chats. */
const nonGroupRoomTypes = new Set(["dm", "space"]);

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


/** The fields of the sync cursor carried over, each spread so the run mutates its own copy. */
function previousFields(previous: Previous | null) {
  return {
    rooms: { ...previous?.rooms },
    groups: { ...previous?.groups },
    jids: { ...previous?.jids },
    invites: { ...previous?.invites },
    names: { ...previous?.names },
    edits: { ...previous?.edits },
  };
}

/** Removes rooms and groups the user left, returning the set of left room ids. */
function pruneLeft(state: State, sync: SyncResponse): Set<string> {
  const left = new Set(Object.keys(sync.rooms?.leave ?? {}));
  state.rooms = Object.fromEntries(Object.entries(state.rooms).filter(([roomId]) => !left.has(roomId)));
  state.groups = Object.fromEntries(Object.entries(state.groups).filter(([roomId]) => !left.has(roomId)));
  state.jids = Object.fromEntries(Object.entries(state.jids).filter(([roomId]) => !left.has(roomId)));
  return left;
}

/** A sync cursor from before invitations were kept does not know those /sync named back then. */
async function fetchInvitations(
  previous: Previous | null,
  homeserver: HomeserverClient,
  token: string,
): Promise<Invites> {
  return previous && previous.invites === null ? await homeserver.invites(token) : {};
}

/** Merges new invitations into state and accepts those not in a left room. */
async function syncInvitations(
  state: State,
  homeserver: HomeserverClient,
  token: string,
  bridge: { userId: string; messenger: Messenger; serverName: string },
  sync: SyncResponse,
  left: Set<string>,
  previous: Previous | null,
): Promise<void> {
  const fetched = await fetchInvitations(previous, homeserver, token);
  Object.assign(state.invites, invitationsOf(fetched, bridge), invitationsOf(sync.rooms?.invite ?? {}, bridge));
  const pending = Object.entries(state.invites).filter(([roomId]) => !left.has(roomId));
  state.invites = {};
  // A chat joined now can be allow-listed at once, though its messages come with the next run.
  await acceptInvitations(state, homeserver, token, pending);
}

/** Learns names, group status and JIDs from the state events and the timeline of each room joined since the last run. */
function syncJoined(state: State, sync: SyncResponse): void {
  for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
    learnRoom(state, roomId, room);
  }
}

function learnRoom(state: State, roomId: string, room: JoinedRoom): void {
  // A rename arrives in the timeline, after the state the room had before it.
  for (const event of [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])]) learn(state, roomId, event);
  state.rooms[roomId] ??= roomId;
}

/**
 * Reads Messengers such as WhatsApp through bridges on the Instance's own homeserver (ADR-0011).
 * Each Source is one linked Messenger account, read by a Matrix user the plugin creates for it.
 * It only receives: its users never post, never mark a room read, and join only rooms their own
 * bridge invites them to.
 */
export function createMatrixPlugin(options: MatrixPluginOptions = {}): SourcePlugin {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startTimeoutMs = options.startTimeoutMs ?? 90_000;
  const programs = options.programs ?? programsFromEnvironment();
  const instanceSource = options.instance ?? process.env.MATRIX_INSTANCE_FILE ?? defaultInstanceFile;
  const readInstance = instanceReader(instanceSource);
  const sessions = new Map<string, LoginSession>();
  let services: Services | null = null;

  /** Why the worker could not start Synapse or a bridge, if it said so. */
  const problem = () => (typeof instanceSource === "string" ? readProblem(instanceSource) : Promise.resolve(null));

  /** Why a Messenger cannot be reached now: not installed, broken, or still starting. */
  async function unavailable(messenger: Messenger): Promise<SourceError> {
    const name = messenger.attributeValue;
    if (!(await isInstalled(programs, messenger))) return SourceError.definite(`${name} is not installed on this Instance.`);
    const found = await problem();
    if (found) return SourceError.definite(found);
    return SourceError.temporary(englishOf(starting(messenger)));
  }

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
    const bridge = instance?.bridges[messenger.id];
    if (!instance || !bridge) throw await unavailable(messenger);
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
      if (!(error instanceof HomeserverError)) throw await unavailable(messenger);
      throw SourceError.temporary(`The ${messenger.attributeValue} bridge could not be reached: ${messageOf(error)}`);
    }
    loginStateProblem(logins, messenger.attributeValue);
  }

  function loginStateProblem(logins: { stateEvent: string; reason: string | null }[], name: string): void {
    if (logins.some((login) => workingStates.has(login.stateEvent))) return;
    if (logins.length === 0) throw SourceError.definite(`The ${name} account is not linked. Press Fix to scan the QR code.`);
    const loggedOut = logins.find((login) => loggedOutStates.has(login.stateEvent));
    if (!loggedOut) throw SourceError.temporary(`The ${name} bridge reports a problem with the account.`);
    const reason = logins.map((login) => login.reason).find((found) => found !== null);
    throw SourceError.definite(`The ${name} account was logged out${reason ? ` (${reason})` : ""}. Press Fix to scan the QR code again.`);
  }

  async function poll(context: IngestContext) {
    const { homeserver, messenger, bridge, instance } = await connectionOf(context.config.plain);
    const { userId, token } = accountOf(context);
    await checkLogin(bridge, messenger, userId);
    const previous = parseState(context.syncCursor);
    const backfillStart = context.now.getTime() - backfillDays * 24 * 60 * 60 * 1000;

    try {
      const sync = await homeserver.sync(token, previous?.since ?? null);
      const state: State = { since: sync.next_batch, ...previousFields(previous), declared: [], read: [] };
      const left = pruneLeft(state, sync);
      const bridge = { userId, messenger, serverName: instance.homeserver.serverName };
      await syncInvitations(state, homeserver, token, bridge, sync, left, previous);
      syncJoined(state, sync);
      await classify(state, homeserver, token);
      // Only group chats are read: a direct chat is never one to read, even when allow-listed before.
      const allowedJids = allowedJidsOf(chatsOf(context.config.plain.chats), state);
      const allowListed = new Set(Object.keys(state.rooms).filter((roomId) => state.groups[roomId] === true && allowedJids.has(state.jids[roomId] ?? "")));
      await declareChats(context, state, previous, allowedJids, allowListed);

      const { withdrawn, events } = await collectEvents(state, homeserver, token, sync, previous, allowListed, backfillStart);

      // Chats allow-listed but not joined yet are read back once they are.
      state.read = [...allowListed].filter((roomId) => roomId in state.rooms);
      pruneEdits(state, events, withdrawn);

      const origins = await originsOf(events, withdrawn, { state, userId, token, messenger, homeserver, serverName: instance.homeserver.serverName });
      return { origins, syncCursor: JSON.stringify(state), withdrawn: [...withdrawn] };
    } catch (error) {
      throw homeserverError(error);
    }
  }

  async function progress(context: RunContext): Promise<SetupProgress> {
    let connection;
    try {
      connection = await connectionOf(context.config.plain);
    } catch (error) {
      return notYet(error, messengerOf(context.config.plain.messenger));
    }
    const { messenger, bridge } = connection;
    const { userId } = accountOf(context);
    const session = sessions.get(userId);
    if (session) return sessionProgress(userId, session, messenger);
    return startLoginOrExplain(bridge, userId, messenger);
  }

  /** The first step of a login; why it could not start when the bridge does not answer or refuses. */
  async function startLoginOrExplain(bridge: BridgeClient, userId: string, messenger: Messenger): Promise<SetupProgress> {
    try {
      return await startLogin(bridge, userId, messenger);
    } catch (error) {
      if (!(error instanceof HomeserverError)) return notYet(await unavailable(messenger), messenger);
      return { status: "failed", message: `The ${messenger.attributeValue} bridge could not start the login: ${messageOf(error)}` };
    }
  }

  /** How the login in progress stands; one that ended is reported once and forgotten. */
  function sessionProgress(userId: string, session: LoginSession, messenger: Messenger): SetupProgress {
    if (session.outcome === "waiting") return waiting(messenger, session.qrCode);
    sessions.delete(userId);
    if (session.outcome === "done") return { status: "done", message: linked(messenger) };
    return { status: "failed", message: session.outcome.failed };
  }

  async function startLogin(bridge: BridgeClient, userId: string, messenger: Messenger): Promise<SetupProgress> {
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
  }

  /** While the Messenger starts, the step waits; otherwise it failed. */
  function notYet(error: unknown, messenger: Messenger | undefined): SetupProgress {
    if (messenger && error instanceof SourceError && error.kind === "temporary") return { status: "waiting", message: starting(messenger) };
    return { status: "failed", message: messageOf(error) };
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
    // Class and club groups pause for weeks in the holidays.
    health: { silentApplies: false },
    catalogue: {
      title: { en: "Messengers", de: "Messenger" },
      configKey: "messenger",
      async entries() {
        const entries = [];
        for (const messenger of messengers) {
          const installed = await isInstalled(programs, messenger);
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
    services: {
      reconcile(enabled) {
        services ??= matrixServices(servicesFromEnvironment(programs, typeof instanceSource === "string" ? instanceSource : defaultInstanceFile));
        return services.reconcile(enabled);
      },
      async stop() {
        await services?.stop();
      },
    },
    async sourceAdded(context) {
      // An Admin may add a Source right after enabling a Messenger, while the worker starts Synapse.
      const deadline = Date.now() + startTimeoutMs;
      for (;;) {
        try {
          const { instance, homeserver } = await connectionOf(context.config.plain);
          const account = await homeserver.register(`family-agenda-${randomBytes(6).toString("hex")}`, instance.homeserver.registrationSharedSecret);
          return { plain: { userId: account.userId }, secrets: { accessToken: account.accessToken } };
        } catch (error) {
          if (!mayPass(error) || Date.now() >= deadline) throw registrationFailure(error);
          await sleep(1000);
        }
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

/** The programs at the places the environment names, or where the image has them. */
function programsFromEnvironment(): MatrixPrograms {
  return {
    synapse: process.env.SYNAPSE_PYTHON ?? defaultPrograms.synapse,
    bridges: { whatsapp: process.env.MAUTRIX_WHATSAPP ?? defaultPrograms.bridges.whatsapp },
  };
}

/** Where the worker keeps Synapse and the bridges, as the environment of the image says. */
export function servicesFromEnvironment(programs: MatrixPrograms, instanceFile: string) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set, so Synapse has no database.");
  const database = new URL(databaseUrl);
  return {
    programs,
    databaseUrl,
    dataDirectory: process.env.MATRIX_DATA_DIRECTORY ?? "/var/lib/family-agenda/matrix-data",
    instanceFile,
    host: process.env.MATRIX_HOST ?? "worker",
    serverName: process.env.MATRIX_SERVER_NAME ?? "family-agenda.local",
    ports: { synapse: 8008, bridges: { whatsapp: 29318 } },
    database: { host: database.hostname, port: Number(database.port || 5432), name: "synapse", user: "synapse" },
  };
}

/** That a Messenger's bridge or the homeserver is still starting. */
function starting(messenger: Messenger): PluginText {
  const name = messenger.attributeValue;
  return {
    en: `${name} is starting on this Instance. This takes up to a minute the first time.`,
    de: `${name} startet auf dieser Instanz. Beim ersten Mal dauert das bis zu einer Minute.`,
  };
}

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
 * The rooms the Messenger's bridge invites the user to, with their names; every other invitation
 * stays unanswered.
 */
function invitationsOf(invites: Invites, bridge: { userId: string; messenger: Messenger; serverName: string }): Record<string, string> {
  const invited: Record<string, string> = {};
  for (const [roomId, room] of Object.entries(invites)) {
    const name = invitationNameOf(roomId, room, bridge);
    if (name !== null) invited[roomId] = name;
  }
  return invited;
}

function invitationNameOf(roomId: string, room: Invites[string], bridge: { userId: string; messenger: Messenger; serverName: string }): string | null {
  const events = room.invite_state?.events ?? [];
  const invitation = findBridgeInvitation(events, bridge);
  if (!invitation) return null;
  const name = events.find((event) => event.type === "m.room.name")?.content.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : roomId;
}

function findBridgeInvitation(events: MatrixEvent[], bridge: { userId: string; messenger: Messenger; serverName: string }): MatrixEvent | undefined {
  return events.find(
    (event) => event.type === "m.room.member" && event.state_key === bridge.userId && event.content.membership === "invite" && isOfBridge(event.sender, bridge.messenger, bridge.serverName),
  );
}

/** Whether a Matrix user is the Messenger's bridge bot or one of its ghosts on this homeserver. */
function isOfBridge(userId: string, messenger: Messenger, serverName: string): boolean {
  const match = /^@([^:]+):(.+)$/.exec(userId);
  if (!match || match[2] !== serverName) return false;
  const localpart = match[1] ?? "";
  return localpart === messenger.botLocalpart || localpart.startsWith(messenger.ghostPrefix);
}

/**
 * Whether a room is a group chat, from the bridge's `m.bridge` state event: a direct chat is
 * marked as one, and a room without it, such as the one with the bridge bot, is no chat at all.
 */
function isGroup(events: MatrixEvent[]): boolean {
  return events.some((event) => event.type === "m.bridge" && !nonGroupRoomTypes.has(String(event.content["com.beeper.room_type"])));
}

/**
 * The WhatsApp JID of the chat a room is the portal of, from the bridge's `m.bridge` state event.
 * The bridge deletes the room when the chat is deleted on the phone and creates a new one for the
 * same group, so the room id does not identify the group; the JID does.
 */
function jidOf(events: MatrixEvent[]): string | undefined {
  for (const event of events) {
    const channel = event.type === "m.bridge" ? event.content.channel : undefined;
    const id = isObject(channel) ? channel.id : undefined;
    if (typeof id === "string" && id !== "") return id;
  }
  return undefined;
}

/** Remembers from the bridge's state events whether a room is a group chat and which chat it is the portal of. */
function learnBridge(state: State, roomId: string, events: MatrixEvent[]): void {
  state.groups[roomId] = isGroup(events);
  const jid = jidOf(events);
  if (jid !== undefined) state.jids[roomId] = jid;
}

/**
 * The JIDs of the chats an Admin allow-listed: the entries of `chats`, and the chats of the rooms
 * an Admin chose by their id before groups were told apart by their JID.
 */
function allowedJidsOf(chats: string[], state: State): Set<string> {
  const allowed = new Set(chats);
  for (const chat of chats) {
    const jid = state.jids[chat];
    if (jid !== undefined) allowed.add(jid);
  }
  return allowed;
}

/**
 * Declares the allow-listed groups as Source Attributes by their JID, named as the bridge names
 * their rooms, and archives those that left the allow-list. A group stays declared while its room
 * is missing, such as between the bridge deleting it and creating it again.
 */
async function declareChats(
  context: IngestContext,
  state: State,
  previous: Previous | null,
  allowedJids: Set<string>,
  allowListed: Set<string>,
): Promise<void> {
  const names = namesByJid(state, allowListed);
  await context.attributes.declare([...names].map(([externalId, name]) => ({ externalId, name })));
  // A Source from before groups were Source Attributes declared one for the whole account.
  const before = previous?.declared ?? [legacyAttribute];
  state.declared = [...new Set([...before.filter((jid) => allowedJids.has(jid)), ...names.keys()])].sort();
  for (const jid of before) if (!state.declared.includes(jid)) await context.attributes.archive(jid);
}

/** The names of the rooms by the JID of their group; a group with several rooms has the name of the last. */
function namesByJid(state: Pick<State, "rooms" | "jids">, rooms: Set<string>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [roomId, name] of Object.entries(state.rooms)) {
    const jid = state.jids[roomId];
    if (rooms.has(roomId) && jid !== undefined) names.set(jid, name);
  }
  return names;
}

/** Finds out whether the joined rooms not known yet are group chats, and the JID of each group not known yet; a room that cannot be read now is tried again on the next run. */
async function classify(state: State, homeserver: HomeserverClient, token: string): Promise<void> {
  for (const roomId of Object.keys(state.rooms)) {
    if (roomId in state.groups && (state.groups[roomId] !== true || roomId in state.jids)) continue;
    try {
      learnBridge(state, roomId, await homeserver.state(token, roomId));
    } catch {
      continue;
    }
  }
}

/** Remembers room names, whether rooms are group chats and their JIDs, and the display names of senders from state events. */
function learn(state: State, roomId: string, event: MatrixEvent): void {
  if (event.type === "m.bridge") learnBridge(state, roomId, [event]);
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
    if (shouldStop(page, since, events, next)) break;
    next = page.end;
  }
  return events.reverse();
}

function shouldStop(page: { chunk: MatrixEvent[]; state?: MatrixEvent[]; end?: string }, since: number | null, events: MatrixEvent[], next: string): boolean {
  if (page.chunk.length === 0) return true;
  for (const event of page.state ?? []) events.push(event);
  return readChunk(page.chunk, since, events) || page.end === next;
}

function readChunk(chunk: MatrixEvent[], since: number | null, events: MatrixEvent[]): boolean {
  for (const event of chunk) {
    if (since !== null && (event.origin_server_ts ?? 0) < since) return true;
    events.push(event);
  }
  return false;
}

/** Accepts the pending invitations, keeping those that fail for a later run. */
async function acceptInvitations(state: State, homeserver: HomeserverClient, token: string, pending: [string, string][]): Promise<void> {
  for (const [roomId, name] of pending) {
    try {
      await homeserver.join(token, roomId);
      state.rooms[roomId] = name;
    } catch {
      // An invitation that cannot be accepted now, such as past the homeserver's rate limit, is accepted on a later run.
      state.invites[roomId] = name;
    }
  }
}

/** The events of one room a run reads: learns them, withdraws the redacted, and keeps the allow-listed. */
function takeEvents(
  state: State,
  roomId: string,
  list: MatrixEvent[],
  allowListed: Set<string>,
  withdrawn: Set<string>,
  events: Map<string, { roomId: string; event: MatrixEvent }>,
): void {
  for (const event of list) {
    learn(state, roomId, event);
    if (event.type === "m.room.redaction") {
      const redacts = event.redacts ?? event.content.redacts;
      if (typeof redacts === "string") withdrawn.add(redacts);
    } else if (allowListed.has(roomId) && event.event_id) {
      events.set(event.event_id, { roomId, event });
    }
  }
}

/** The events of the allow-listed rooms a run reads, and the redactions that withdraw them. */
async function collectEvents(
  state: State,
  homeserver: HomeserverClient,
  token: string,
  sync: SyncResponse,
  previous: Previous | null,
  allowListed: Set<string>,
  backfillStart: number,
): Promise<{ withdrawn: Set<string>; events: Map<string, { roomId: string; event: MatrixEvent }> }> {
  const withdrawn = new Set<string>();
  const events = new Map<string, { roomId: string; event: MatrixEvent }>();
  const take = (roomId: string, list: MatrixEvent[]) => {
    takeEvents(state, roomId, list, allowListed, withdrawn, events);
  };

  await collectJoinedEvents(state, homeserver, token, sync, previous, allowListed, backfillStart, take);
  await collectNewlyAllowListed(state, homeserver, token, sync, previous, allowListed, backfillStart, take);
  return { withdrawn, events };
}

function backfillToken(
  roomId: string,
  isNew: boolean,
  room: JoinedRoom,
  allowListed: Set<string>,
): string | null {
  if (!allowListed.has(roomId) || isNew || !room.timeline?.limited || !room.timeline.prev_batch) return null;
  return room.timeline.prev_batch;
}

async function collectJoinedEvents(
  state: State,
  homeserver: HomeserverClient,
  token: string,
  sync: SyncResponse,
  previous: Previous | null,
  allowListed: Set<string>,
  backfillStart: number,
  take: (roomId: string, list: MatrixEvent[]) => void,
): Promise<void> {
  for (const [roomId, room] of Object.entries(sync.rooms?.join ?? {})) {
    await collectRoomEvents(homeserver, token, roomId, room, previous, allowListed, backfillStart, take);
  }
}

async function collectRoomEvents(
  homeserver: HomeserverClient,
  token: string,
  roomId: string,
  room: JoinedRoom,
  previous: Previous | null,
  allowListed: Set<string>,
  backfillStart: number,
  take: (roomId: string, list: MatrixEvent[]) => void,
): Promise<void> {
  take(roomId, room.timeline?.events ?? []);
  const isNew = previous !== null && !previous.read.includes(roomId);
  const prevBatch = backfillToken(roomId, isNew, room, allowListed);
  if (prevBatch) {
    take(roomId, await readBack(homeserver, token, roomId, prevBatch, previous?.since ?? null, backfillStart));
  }
}

async function collectNewlyAllowListed(
  state: State,
  homeserver: HomeserverClient,
  token: string,
  sync: SyncResponse,
  previous: Previous | null,
  allowListed: Set<string>,
  backfillStart: number,
  take: (roomId: string, list: MatrixEvent[]) => void,
): Promise<void> {
  // A chat allow-listed since the last run is read back for some days.
  for (const roomId of allowListed) {
    if (!previous || previous.read.includes(roomId) || !(roomId in state.rooms)) continue;
    take(roomId, await readBack(homeserver, token, roomId, sync.next_batch, null, backfillStart));
  }
}

/** The edits that stay, dropping those whose message is redacted. */
function pruneEdits(
  state: State,
  events: Map<string, { roomId: string; event: MatrixEvent }>,
  withdrawn: Set<string>,
): void {
  // An edit is a message of its own, which goes when the message it edits is redacted.
  for (const { event } of events.values()) {
    const edited = editedBy(event);
    if (edited && event.event_id) state.edits[edited] = [...new Set([...(state.edits[edited] ?? []), event.event_id])];
  }
  for (const redacted of [...withdrawn]) for (const edit of state.edits[redacted] ?? []) withdrawn.add(edit);
  state.edits = Object.fromEntries(Object.entries(state.edits).filter(([edited]) => !withdrawn.has(edited)));
}

/** The Origins of the events read, in the order they occurred. */
async function originsOf(
  events: Map<string, { roomId: string; event: MatrixEvent }>,
  withdrawn: Set<string>,
  context: { state: State; userId: string; token: string; messenger: Messenger; homeserver: HomeserverClient; serverName: string },
): Promise<Origin[]> {
  const origins: MessageOrigin[] = [];
  for (const { roomId, event } of events.values()) {
    if (withdrawn.has(event.event_id ?? "")) continue;
    const origin = await originOf(event, roomId, context);
    if (origin) origins.push(origin);
  }
  origins.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  return origins;
}

/** The caption and the attachments of a file message; the caption is its body when that differs from the name. */
async function attachmentsOf(
  content: Record<string, unknown>,
  body: string,
  context: { token: string; homeserver: HomeserverClient },
): Promise<{ text: string; attachments: Attachment[] }> {
  const filename = stringOr(content.filename, body || "attachment");
  // A file's body is its caption when it differs from its name.
  const text = body !== filename ? body : "";
  const { size, contentType } = fileInfoOf(content);
  if (typeof content.url !== "string" || size > maximumAttachmentBytes) return { text, attachments: [] };
  const bytes = await context.homeserver.download(context.token, content.url, maximumAttachmentBytes);
  return { text, attachments: bytes ? [{ filename, contentType, bytes }] : [] };
}

const stringOr = (value: unknown, fallback: string): string => (typeof value === "string" && value !== "" ? value : fallback);

/** The size and media type a file message states; 0 and a generic type when it states none. */
function fileInfoOf(content: Record<string, unknown>): { size: number; contentType: string } {
  const info = isObject(content.info) ? content.info : {};
  return { size: typeof info.size === "number" ? info.size : 0, contentType: stringOr(info.mimetype, "application/octet-stream") };
}

/** An Origin of a message, which always has the time its homeserver got it. */
type MessageOrigin = Origin & { occurredAt: Date };

/** A message of an allow-listed room as an Origin; null for anything that is not one to read. */
async function originOf(
  event: MatrixEvent,
  roomId: string,
  context: { state: State; userId: string; token: string; messenger: Messenger; homeserver: HomeserverClient; serverName: string },
): Promise<MessageOrigin | null> {
  const eventId = event.event_id;
  if (!eventId || !isReadable(event, context)) return null;
  const relation = event.content["m.relates_to"] as { rel_type?: string; event_id?: string; "m.in_reply_to"?: { event_id?: string } } | undefined;
  const { content, body } = contentOf(event, relation);
  const { text, attachments } = await originContent(content, body, context);
  if (text === "" && attachments.length === 0) return null;
  const thread = originThread(relation, eventId);
  return {
    externalId: eventId,
    occurredAt: new Date(event.origin_server_ts ?? Date.now()),
    attributes: attributesOf(context.state, roomId),
    ...describedBy(event, roomId, context.state),
    content: { kind: "raw-message", text, attachments, ...(thread ? { thread } : {}) },
  };
}

/** The Source Attribute a message of a room names: the group the room is the portal of. */
function attributesOf(state: State, roomId: string): string[] {
  const jid = state.jids[roomId];
  return jid === undefined ? [] : [jid];
}

/** Who sent a message, and in which chat, as the Admin area shows it with the message. */
function describedBy(event: MatrixEvent, roomId: string, state: State): { sender: string; subject: string } {
  return { sender: state.names[event.sender] ?? event.sender, subject: state.rooms[roomId] ?? roomId };
}

/** The Source Attribute the whole account was one before its groups became Source Attributes. */
const legacyAttribute = "account";

function isReadable(
  event: MatrixEvent,
  context: { userId: string; messenger: Messenger; serverName: string },
): boolean {
  if (event.type !== "m.room.message" || !event.event_id || event.unsigned?.redacted_because !== undefined) return false;
  if (event.sender === context.userId || event.sender === `@${context.messenger.botLocalpart}:${context.serverName}`) return false;
  return true;
}

function contentOf(
  event: MatrixEvent,
  relation: { rel_type?: string; event_id?: string; "m.in_reply_to"?: { event_id?: string } } | undefined,
): { content: Record<string, unknown>; body: string } {
  // An edit stands for the message it changes, with its new text.
  const content = relation?.rel_type === "m.replace" && isObject(event.content["m.new_content"]) ? event.content["m.new_content"] : event.content;
  const body = typeof content.body === "string" ? content.body.trim() : "";
  return { content, body };
}

/** The text and attachments of a Matrix message, by its msgtype. */
async function originContent(
  content: Record<string, unknown>,
  body: string,
  context: { token: string; homeserver: HomeserverClient },
): Promise<{ text: string; attachments: Attachment[] }> {
  const msgtype = content.msgtype;
  let text = "";
  const attachments: Attachment[] = [];
  if (typeof msgtype === "string" && textTypes.has(msgtype)) text = body;
  if (typeof msgtype === "string" && fileTypes.has(msgtype)) {
    const file = await attachmentsOf(content, body, { token: context.token, homeserver: context.homeserver });
    text = file.text;
    attachments.push(...file.attachments);
  }
  return { text, attachments };
}

/** The thread a message belongs to: the event it edits or replies to, or itself. */
function originThread(
  relation: { rel_type?: string; event_id?: string; "m.in_reply_to"?: { event_id?: string } } | undefined,
  eventId: string,
): string | undefined {
  if (relation?.rel_type === "m.replace" || relation?.rel_type === "m.thread") return relation.event_id;
  return relation?.["m.in_reply_to"]?.event_id ?? eventId;
}

/** The message an edit changes; none for any other event. */
function editedBy(event: MatrixEvent): string | null {
  const relation = event.content["m.relates_to"];
  if (!isObject(relation) || relation.rel_type !== "m.replace") return null;
  return typeof relation.event_id === "string" ? relation.event_id : null;
}

/** The joined group chats a Source can allow-list, by name; a group is chosen by its JID, so it is offered once however many rooms it has had. */
function chatChoices(context: RunContext): Choice[] {
  const state = parseState(context.syncCursor);
  const groups = new Set(Object.keys(state?.groups ?? {}).filter((roomId) => state?.groups[roomId] === true));
  const byJid = state ? namesByJid(state, groups) : new Map<string, string>();
  return [...byJid].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function chatsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((chat): chat is string => typeof chat === "string") : [];
}

/** The record a stored value is, or an empty one. */
function recordOf<T>(value: Record<string, T> | undefined): Record<string, T> {
  return isObject(value) ? value : {};
}

/** A sync cursor as read; `invites` is null in one written before invitations were kept, `declared` in one written before groups were Source Attributes. */
type Previous = Omit<State, "invites" | "declared"> & { invites: Record<string, string> | null; declared: string[] | null };

function parseState(state: string | null): Previous | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(state) as Partial<State>;
    if (typeof parsed.since !== "string") return null;
    return {
      since: parsed.since,
      rooms: recordOf(parsed.rooms),
      groups: recordOf(parsed.groups),
      jids: recordOf(parsed.jids),
      declared: Array.isArray(parsed.declared) ? chatsOf(parsed.declared) : null,
      invites: isObject(parsed.invites) ? parsed.invites : null,
      names: recordOf(parsed.names),
      read: chatsOf(parsed.read),
      edits: recordOf(parsed.edits),
    };
  } catch {
    return null;
  }
}

/** Whether registering may work later, as when the homeserver is not up yet. */
function mayPass(error: unknown): boolean {
  if (error instanceof SourceError) return error.kind === "temporary";
  return !(error instanceof HomeserverError);
}

function registrationFailure(error: unknown): SourceError {
  if (error instanceof SourceError) return error;
  return SourceError.temporary(`The homeserver could not create a Matrix user: ${messageOf(error)}`);
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
