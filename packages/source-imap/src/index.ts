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

/** The state blob: the folder's UIDVALIDITY and the highest UID read, as the IMAP standard keys mails. */
type State = { uidValidity: string; lastUid: number };

/** How far back the first run of a Source reads, so that adding a mailbox does not extract years of mail. */
const firstRunDays = 14;

const defaultPort = 993;

/**
 * Reads the mails in one folder of a mailbox, read-only: it opens the folder with `EXAMINE` and
 * fetches with `BODY.PEEK`, so it never sets a flag, and it never moves or deletes a mail. Each
 * run reads the mails after the highest UID the last run saw, and emits each as a raw message for
 * extraction, with its text body; attachments are kept, not read yet.
 */
export function createImapPlugin(options: ImapPluginOptions = {}): SourcePlugin {
  const timeoutMs = options.timeoutMs ?? 60_000;

  /** Runs `use` on a connection logged in with the Source's account and its folder open. */
  async function withFolder<T>(context: RunContext, use: (client: ImapFlow, uidValidity: string) => Promise<T>): Promise<T> {
    const { plain, secrets } = context.config;
    const host = typeof plain.host === "string" ? plain.host : "";
    const port = plain.port === undefined || plain.port === null || plain.port === "" ? defaultPort : Number(plain.port);
    if (host === "" || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw SourceError.definite("The mail server's address or port is not valid.");
    }
    const folder = typeof plain.folder === "string" && plain.folder !== "" ? plain.folder : "INBOX";
    const client = new ImapFlow({
      host,
      port,
      secure: port === defaultPort,
      doSTARTTLS: port === defaultPort ? undefined : !options.allowPlaintext,
      auth: { user: typeof plain.username === "string" ? plain.username : "", pass: secrets.password ?? "" },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
    // A connection that drops is reported by the command waiting on it.
    client.on("error", () => undefined);
    try {
      try {
        await client.connect();
      } catch (error) {
        throw connectionError(error);
      }
      let uidValidity: string;
      try {
        uidValidity = (await client.mailboxOpen(folder, { readOnly: true })).uidValidity.toString();
      } catch (error) {
        if (isNoResponse(error)) throw SourceError.definite(`The folder "${folder}" does not exist in the mailbox.`);
        throw temporary(error);
      }
      try {
        return await use(client, uidValidity);
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
      version: 1,
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
          key: "folder",
          label: { en: "Folder", de: "Ordner" },
          secret: false,
          required: false,
          description: {
            en: "Optional; INBOX by default. Use a folder your mail filters fill with school mail, or a mailbox only school mail is forwarded to: every mail in it is sent to the LLM endpoint.",
            de: "Optional; sonst INBOX. Nimm einen Ordner, den deine Mailfilter mit Schulmails füllen, oder ein Postfach, an das nur Schulmails weitergeleitet werden: Jede Mail darin geht an den LLM-Endpunkt.",
          },
        },
      ],
    },
    setupSteps: [],
    ingestion: {
      mode: "polling",
      suggestedIntervalSeconds: 5 * 60,
      poll: (context) =>
        withFolder(context, async (client, uidValidity) => {
          const previous = parseState(context.state);
          const resuming = previous?.uidValidity === uidValidity;
          let range: string;
          if (resuming) {
            range = `${previous.lastUid + 1}:*`;
          } else {
            const since = new Date(context.now.getTime() - firstRunDays * 24 * 60 * 60 * 1000);
            const uids = (await client.search({ since }, { uid: true })) || [];
            const uidNext = client.mailbox ? client.mailbox.uidNext : NaN;
            const highest = Number.isInteger(uidNext) ? uidNext - 1 : 0;
            if (uids.length === 0) return { origins: [], state: stateOf(uidValidity, highest) };
            range = uids.join(",");
          }
          const fetched = await client.fetchAll(range, { uid: true, source: true }, { uid: true });
          // `n:*` names the last mail even when its UID is below n.
          const fresh = fetched.filter((mail) => !resuming || mail.uid > previous.lastUid);
          const origins: Origin[] = [];
          for (const mail of fresh) origins.push(await originOf(mail, uidValidity, context.now));
          const lastUid = Math.max(resuming ? previous.lastUid : 0, ...fetched.map((mail) => mail.uid));
          return { origins, state: stateOf(uidValidity, lastUid) };
        }),
    },
    // School mail pauses for weeks in the holidays.
    health: { silentApplies: false },
  };
}

export default createImapPlugin();

async function originOf(mail: FetchMessageObject, uidValidity: string, now: Date): Promise<Origin> {
  const parsed = await simpleParser(mail.source ?? Buffer.alloc(0));
  const messageId = parsed.messageId?.trim();
  const sender = senderOf(parsed);
  const body = (parsed.text ?? "").replace(/\r\n/g, "\n").trim();
  const subject = parsed.subject?.trim();
  const thread = threadOf(parsed);
  const attachments: Attachment[] = parsed.attachments
    .filter((attachment) => !attachment.related)
    .map((attachment) => ({
      filename: attachment.filename ?? "attachment",
      contentType: attachment.contentType,
      bytes: new Uint8Array(attachment.content),
    }));
  return {
    externalId: messageId || `uid:${uidValidity}:${mail.uid}`,
    occurredAt: parsed.date ?? (mail.internalDate ? new Date(mail.internalDate) : now),
    attributes: sender ? { sender } : {},
    content: {
      kind: "raw-message",
      text: subject ? `Subject: ${subject}\n\n${body}` : body,
      attachments,
      ...(thread ? { thread } : {}),
    },
  };
}

/** The first mail of the conversation, by `References` or `In-Reply-To`, or the mail itself. */
function threadOf(parsed: ParsedMail): string | undefined {
  const references = typeof parsed.references === "string" ? [parsed.references] : (parsed.references ?? []);
  return references[0]?.trim() || parsed.inReplyTo?.trim() || parsed.messageId?.trim() || undefined;
}

function senderOf(parsed: ParsedMail): string | null {
  const from: AddressObject | undefined = Array.isArray(parsed.from) ? (parsed.from as AddressObject[])[0] : parsed.from;
  return from?.value[0]?.address?.toLowerCase() ?? null;
}

function parseState(state: string | null): State | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(state) as Partial<State>;
    return typeof parsed.uidValidity === "string" && typeof parsed.lastUid === "number"
      ? { uidValidity: parsed.uidValidity, lastUid: parsed.lastUid }
      : null;
  } catch {
    return null;
  }
}

function stateOf(uidValidity: string, lastUid: number): string {
  return JSON.stringify({ uidValidity, lastUid } satisfies State);
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
