import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import {
  sdkVersion,
  SourceError,
  type Attachment,
  type Origin,
  type RunContext,
  type SourcePlugin,
} from "@family-agenda/source-sdk";

export type ImapPluginOptions = {
  /**
   * Lets a connection without TLS log in, as to a test server; by default a server on another
   * port than 993 has to offer STARTTLS, so that the password never crosses the network in clear.
   */
  allowPlaintext?: boolean;
  /** How long connecting and each answer may take before the run fails. */
  timeoutMs?: number;
};

/** What was read of one folder: its UIDVALIDITY and the highest UID read, as the IMAP standard keys mails. */
type FolderState = { uidValidity: string; lastUid: number };

/** The sync cursor: what was read of each folder, by its name. */
type State = Record<string, FolderState>;

/** How far back the first run of a Source reads, so that adding a mailbox does not extract years of mail. */
const firstRunDays = 14;

const defaultPort = 993;

/**
 * Reads the mails in the folders of a mailbox, read-only: it opens each folder with `EXAMINE` and
 * fetches with `BODY.PEEK`, so it never sets a flag, and it never moves or deletes a mail. Each
 * run reads the mails after the highest UID the last run saw in each folder, and emits each as a
 * raw message for extraction, with its text body; attachments are kept, not read yet. The
 * folders are Parts of the Source, so an Admin can assign each to other Family Members; with none
 * configured, it reads INBOX as the Source itself.
 */
export function createImapPlugin(options: ImapPluginOptions = {}): SourcePlugin {
  const timeoutMs = options.timeoutMs ?? 60_000;

  /** Creates a logged-in IMAP client from the Source's config, validating the address. */
  function mailboxClient(plain: Record<string, unknown>, secrets: Record<string, string | undefined>): ImapFlow {
    const host = stringOf(plain.host);
    const port = portOf(plain.port);
    if (host === "" || !isPort(port)) {
      throw SourceError.definite("The mail server's address or port is not valid.");
    }
    return new ImapFlow({
      host,
      port,
      secure: port === defaultPort,
      doSTARTTLS: port === defaultPort ? undefined : !options.allowPlaintext,
      auth: { user: stringOf(plain.username), pass: secrets.password ?? "" },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
  }

  /** Runs `use` on a connection logged in with the Source's account. */
  async function withMailbox<T>(context: RunContext, use: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = mailboxClient(context.config.plain, context.config.secrets);
    // A connection that drops is reported by the command waiting on it.
    client.on("error", () => undefined);
    try {
      try {
        await client.connect();
      } catch (error) {
        throw connectionError(error);
      }
      try {
        return await use(client);
      } catch (error) {
        throw error instanceof SourceError ? error : temporary(error);
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  return {
    identity: { sourceTypeId: "imap", displayName: { en: "IMAP mailbox", de: "IMAP-Postfach" }, version: "0.1.0", sdkVersion },
    configuration: {
      version: 2,
      migrations: {
        // The single folder became a list of folders, each assigned on its own.
        1: ({ folder, ...rest }) => (typeof folder === "string" && folder !== "" ? { ...rest, folders: [folder] } : rest),
      },
      fields: [
        {
          key: "host",
          label: { en: "Mail server", de: "Mailserver" },
          secret: false,
          required: true,
          description: { en: "Such as imap.gmx.net or imap.gmail.com.", de: "Etwa imap.gmx.net oder imap.gmail.com." },
        },
        {
          key: "port",
          label: { en: "Port", de: "Port" },
          secret: false,
          required: false,
          description: {
            en: "Optional; 993 by default. On another port the server has to offer STARTTLS.",
            de: "Optional; sonst 993. Auf einem anderen Port muss der Server STARTTLS anbieten.",
          },
        },
        {
          key: "username",
          label: { en: "User name", de: "Benutzername" },
          secret: false,
          required: true,
          description: { en: "Usually the mail address.", de: "Meist die Mailadresse." },
        },
        {
          key: "password",
          label: { en: "Password", de: "Passwort" },
          secret: true,
          required: true,
          description: {
            en: "An app password where the provider has them, such as for Gmail with 2-Step Verification.",
            de: "Ein App-Passwort, wo der Anbieter welche hat, etwa bei Gmail mit Bestätigung in zwei Schritten.",
          },
        },
        {
          key: "folders",
          label: { en: "Folders", de: "Ordner" },
          secret: false,
          required: false,
          parts: true,
          description: {
            en: "Optional; INBOX by default. Use folders your mail filters fill with school mail, or a mailbox only school mail is forwarded to: every mail in them is sent to the LLM endpoint. Assign each folder to the Family Members it concerns.",
            de: "Optional; sonst INBOX. Nimm Ordner, die deine Mailfilter mit Schulmails füllen, oder ein Postfach, an das nur Schulmails weitergeleitet werden: Jede Mail darin geht an den LLM-Endpunkt. Weise jeden Ordner den Familienmitgliedern zu, die er betrifft.",
          },
        },
      ],
    },
    setupSteps: [],
    ingestion: {
      mode: "polling",
      suggestedIntervalSeconds: 5 * 60,
      poll: (context) =>
        withMailbox(context, async (client) => {
          const configured = foldersOf(context.config.plain);
          // Without folders, INBOX is read as the Source itself.
          const folders = configured.length > 0 ? configured : ["INBOX"];
          const previous = parseState(context.syncCursor, folders[0]);
          const origins = new Map<string, Origin>();
          const state: State = {};
          for (const folder of folders) {
            const read = await readFolder(client, folder, previous[folder] ?? null, context.now);
            state[folder] = read.state;
            for (const mail of read.mails) {
              // A mail in several folders, such as under several labels, counts once, in the first.
              if (origins.has(mail.externalId)) continue;
              origins.set(mail.externalId, configured.length > 0 ? { ...mail, part: folder } : mail);
            }
          }
          return { origins: [...origins.values()], syncCursor: JSON.stringify(state) };
        }),
    },
    // School mail pauses for weeks in the holidays.
    health: { silentApplies: false },
  };
}

export default createImapPlugin();

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The port an Admin configured, or the default one when left empty. */
function portOf(value: unknown): number {
  return value === undefined || value === null || value === "" ? defaultPort : Number(value);
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** The folders an Admin configured, in their order. */
function foldersOf(plain: Record<string, unknown>): string[] {
  return Array.isArray(plain.folders) ? plain.folders.filter((folder): folder is string => typeof folder === "string" && folder !== "") : [];
}

/** Opens the folder and reads its mails after the highest UID seen, or the last days on the first read. */
async function readFolder(
  client: ImapFlow,
  folder: string,
  previous: FolderState | null,
  now: Date,
): Promise<{ mails: Origin[]; state: FolderState }> {
  const uidValidity = await openFolder(client, folder);
  const resuming = previous !== null && previous.uidValidity === uidValidity;
  let range: string;
  if (resuming) {
    range = `${previous.lastUid + 1}:*`;
  } else {
    const since = new Date(now.getTime() - firstRunDays * 24 * 60 * 60 * 1000);
    const uids = (await client.search({ since }, { uid: true })) || [];
    if (uids.length === 0) return { mails: [], state: { uidValidity, lastUid: highestUid(client) } };
    range = uids.join(",");
  }
  const fetched = await client.fetchAll(range, { uid: true, source: true, internalDate: true }, { uid: true });
  // `n:*` names the last mail even when its UID is below n.
  const fresh = fetched.filter((mail) => !resuming || mail.uid > previous.lastUid);
  const mails: Origin[] = [];
  for (const mail of fresh) mails.push(await originOf(mail, uidValidity, now));
  const lastUid = Math.max(resuming ? previous.lastUid : 0, ...fetched.map((mail) => mail.uid));
  return { mails, state: { uidValidity, lastUid } };
}

/** Opens the folder read-only and returns its UID validity. */
async function openFolder(client: ImapFlow, folder: string): Promise<string> {
  try {
    return (await client.mailboxOpen(folder, { readOnly: true })).uidValidity.toString();
  } catch (error) {
    if (isNoResponse(error)) throw SourceError.definite(`The folder "${folder}" does not exist in the mailbox.`);
    throw temporary(error);
  }
}

/** The highest UID in use in the open folder, 0 if that is unknown. */
function highestUid(client: ImapFlow): number {
  const uidNext = client.mailbox ? client.mailbox.uidNext : NaN;
  return Number.isInteger(uidNext) ? uidNext - 1 : 0;
}

async function originOf(mail: FetchMessageObject, uidValidity: string, now: Date): Promise<Origin> {
  const parsed = await simpleParser(mail.source ?? Buffer.alloc(0));
  const sender = senderOf(parsed);
  const thread = threadOf(parsed);
  return {
    externalId: parsed.messageId?.trim() || `uid:${uidValidity}:${mail.uid}`,
    occurredAt: receivedAt(mail, parsed, now),
    attributes: sender ? { sender } : {},
    content: {
      kind: "raw-message",
      text: textOf(parsed),
      attachments: attachmentsOf(parsed),
      ...(thread ? { thread } : {}),
    },
  };
}

/** When the mailbox received a mail; the Date header is whatever the sender's program wrote. */
function receivedAt(mail: FetchMessageObject, parsed: ParsedMail, now: Date): Date {
  return mail.internalDate ? new Date(mail.internalDate) : (parsed.date ?? now);
}

/** The body of a mail, led by its subject. */
function textOf(parsed: ParsedMail): string {
  const body = (parsed.text ?? "").replace(/\r\n/g, "\n").trim();
  const subject = parsed.subject?.trim();
  return subject ? `Subject: ${subject}\n\n${body}` : body;
}

/** The attachments of a mail, without the images its HTML shows inline. */
function attachmentsOf(parsed: ParsedMail): Attachment[] {
  return parsed.attachments
    .filter((attachment) => !attachment.related)
    .map((attachment) => ({
      filename: attachment.filename ?? "attachment",
      contentType: attachment.contentType,
      bytes: new Uint8Array(attachment.content),
    }));
}

/** The first mail of the conversation, by `References` or `In-Reply-To`, or the mail itself. */
function threadOf(parsed: ParsedMail): string | undefined {
  const references = typeof parsed.references === "string" ? [parsed.references] : (parsed.references ?? []);
  return firstOf(references[0]?.trim(), parsed.inReplyTo?.trim(), parsed.messageId?.trim());
}

function firstOf(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
}

function senderOf(parsed: ParsedMail): string | null {
  const from: AddressObject | undefined = Array.isArray(parsed.from) ? (parsed.from as AddressObject[])[0] : parsed.from;
  return from?.value[0]?.address?.toLowerCase() ?? null;
}

/**
 * What was read of each folder. A sync cursor from before a Source had several folders is that of its
 * only folder, which is `first` now.
 */
function parseState(state: string | null, first: string | undefined): State {
  if (!state) return {};
  try {
    const parsed = JSON.parse(state) as Record<string, unknown>;
    if (isFolderState(parsed)) return first === undefined ? {} : { [first]: parsed };
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, FolderState] => isFolderState(entry[1])));
  } catch {
    return {};
  }
}

function isFolderState(value: unknown): value is FolderState {
  const candidate = value as Partial<FolderState> | null;
  return typeof candidate?.uidValidity === "string" && typeof candidate.lastUid === "number";
}

/** A wrong password or a server without the TLS it needs need an Admin; anything else may pass. */
function connectionError(error: unknown): SourceError {
  const details = error as { authenticationFailed?: boolean; code?: string; message?: string };
  if (details.authenticationFailed) return SourceError.definite("The mail server refused the user name or password.");
  if (/STARTTLS/i.test(details.message ?? "") || details.code === "NoStartTLS") {
    return SourceError.definite("The mail server offers no encrypted connection, so the password is not sent to it.");
  }
  return temporary(error);
}

function isNoResponse(error: unknown): boolean {
  const details = error as { serverResponseCode?: string; responseStatus?: string };
  return details.responseStatus === "NO" || details.serverResponseCode === "NONEXISTENT";
}

function temporary(error: unknown): SourceError {
  const reason = error instanceof Error ? error.message : String(error);
  return SourceError.temporary(`The mail server could not be read: ${reason}`);
}
