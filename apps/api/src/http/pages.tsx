import {
  pollIntervalRange,
  type AdminSummary,
  type FamilyMemberSummary,
  type LlmEndpointSummary,
  type MessageDetails,
  type RecoveryKit,
  type SourceForm,
  type SourceSummary,
  type SourceTypeSummary,
  type ViewSummary,
} from "@family-butler/application";
import {
  defaultHorizonDays,
  horizonDaysRange,
  maximumNameLength,
  minimumPasswordLength,
  photoTypes,
} from "@family-butler/domain";
import type { Child } from "hono/jsx";
import { Layout, Problem } from "./layout";
import { Avatar, viewUrl } from "./view-page";

export function FirstAdminPage(props: { email?: string; problem?: string }) {
  return (
    <Layout title="Create the first Admin">
      <h1>Create the first Admin</h1>
      <p>This Instance has no Admin yet. Create your Admin account to protect the Admin area.</p>
      <Problem message={props.problem} />
      <form method="post" action="/setup">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="username" value={props.email} />
        <label for="password">Password (at least {minimumPasswordLength} characters)</label>
        <input id="password" name="password" type="password" required minlength={minimumPasswordLength} autocomplete="new-password" />
        <button type="submit">Create Admin</button>
      </form>
    </Layout>
  );
}

export function SignInPage(props: { email?: string; problem?: string }) {
  return (
    <Layout title="Sign in">
      <h1>Sign in</h1>
      <Problem message={props.problem} />
      <form method="post" action="/admin/sign-in">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="username" value={props.email} />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
    </Layout>
  );
}

/** The Admin a page is shown to, and whether the Admin area shows the new-Source-Types banner. */
export type SignedInAdmin = AdminSummary & { newSourceTypes: boolean };

function AdminLayout(props: { title: string; admin: SignedInAdmin; children: Child }) {
  return (
    <Layout title={props.title}>
      <nav>
        <a href="/admin">Admin area</a>
        <a href="/admin/family-members">Family Members</a>
        <a href="/admin/views">Views</a>
        <a href="/admin/source-types">Source Types</a>
        <a href="/admin/sources">Sources</a>
        <a href="/admin/llm">LLM endpoint</a>
        <a href="/admin/admins">Admins</a>
        <a href="/admin/recovery-kit">Recovery Kit</a>
        <span>{props.admin.email}</span>
        <form method="post" action="/admin/sign-out">
          <button type="submit">Sign out</button>
        </form>
      </nav>
      {props.admin.newSourceTypes ? (
        <p class="banner">
          New Source Types are available. <a href="/admin/source-types">Look at them</a>
        </p>
      ) : null}
      <h1>{props.title}</h1>
      {props.children}
    </Layout>
  );
}

export function AdminHomePage(props: { admin: SignedInAdmin }) {
  return (
    <AdminLayout title="Admin area" admin={props.admin}>
      <ul>
        <li>
          <a href="/admin/family-members">Family Members</a>: whom Items can concern.
        </li>
        <li>
          <a href="/admin/views">Views</a>: what the Family opens on the home network, without signing in.
        </li>
        <li>
          <a href="/admin/source-types">Source Types</a>: the kinds of channels the Family's Sources can be.
        </li>
        <li>
          <a href="/admin/sources">Sources</a>: the channels information arrives through, such as calendars.
        </li>
        <li>
          <a href="/admin/llm">LLM endpoint</a>: the model that reads Events from mails and messages.
        </li>
      </ul>
    </AdminLayout>
  );
}

export function AdminsPage(props: {
  admin: SignedInAdmin;
  admins: AdminSummary[];
  email?: string;
  problem?: string;
}) {
  return (
    <AdminLayout title="Admins" admin={props.admin}>
      <Problem message={props.problem} />
      <ul>
        {props.admins.map((other) => (
          <li>
            {other.email}
            {other.id === props.admin.id ? (
              " (you)"
            ) : (
              <form method="post" action={`/admin/admins/${other.id}/password`}>
                <label for={`password-${other.id}`}>New password</label>
                <input id={`password-${other.id}`} name="password" type="password" required minlength={minimumPasswordLength} autocomplete="new-password" />
                <button type="submit">Reset password</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <h2>Add an Admin</h2>
      <form method="post" action="/admin/admins">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required value={props.email} />
        <label for="password">Password (at least {minimumPasswordLength} characters)</label>
        <input id="password" name="password" type="password" required minlength={minimumPasswordLength} autocomplete="new-password" />
        <button type="submit">Add Admin</button>
      </form>
    </AdminLayout>
  );
}

const recoveryKitPurpose = [
  "Keep this kit offline, printed or saved away from the Instance.",
  "Restoring a Backup needs it to read the Source credentials, and Backups are encrypted with a key derived from it.",
  "Anyone with this kit and a Backup can read the Source credentials.",
];

/** The kit as a text file to download. */
export function recoveryKitText(kit: RecoveryKit): string {
  return ["Family Butler Recovery Kit", "", "Master key:", kit.masterKey, "", ...recoveryKitPurpose, ""].join("\n");
}

export function RecoveryKitPage(props: {
  admin: SignedInAdmin;
  kit: RecoveryKit;
  confirmed: boolean;
  problem?: string | undefined;
}) {
  return (
    <AdminLayout title="Recovery Kit" admin={props.admin}>
      {props.confirmed ? null : (
        <p>Print or save this Recovery Kit before you continue. Any Admin can show it again later.</p>
      )}
      <h2>Master key</h2>
      <p class="secret">{props.kit.masterKey}</p>
      {recoveryKitPurpose.map((sentence) => (
        <p>{sentence}</p>
      ))}
      <p class="actions">
        <button type="button" onclick="window.print()">Print</button>
        <a href="/admin/recovery-kit/download">Download as a text file</a>
      </p>
      {props.confirmed ? null : (
        <form method="post" action="/admin/recovery-kit/confirm">
          <Problem message={props.problem} />
          <label>
            <input type="checkbox" name="saved" value="yes" required /> I have printed or saved the Recovery Kit.
          </label>
          <button type="submit">Continue</button>
        </form>
      )}
    </AdminLayout>
  );
}

export function FamilyMembersPage(props: {
  admin: SignedInAdmin;
  members: FamilyMemberSummary[];
  name?: string;
  problem?: string;
}) {
  return (
    <AdminLayout title="Family Members" admin={props.admin}>
      <Problem message={props.problem} />
      <ul class="entries">
        {props.members.map((member) => (
          <li>
            <form method="post" action={`/admin/family-members/${member.id}`} enctype="multipart/form-data">
              <Avatar member={member} />
              <label for={`name-${member.id}`}>Name</label>
              <input id={`name-${member.id}`} name="name" required maxlength={maximumNameLength} value={member.name} />
              <label for={`photo-${member.id}`}>{member.hasPhoto ? "Replace photo" : "Photo (optional)"}</label>
              <input id={`photo-${member.id}`} name="photo" type="file" accept={photoTypes.join(",")} />
              {member.hasPhoto ? (
                <label>
                  <input type="checkbox" name="removePhoto" value="yes" /> Remove photo
                </label>
              ) : null}
              <button type="submit">Save</button>
            </form>
            <form method="post" action={`/admin/family-members/${member.id}/remove`}>
              <button type="submit">Remove {member.name}</button>
            </form>
          </li>
        ))}
      </ul>
      <h2>Add a Family Member</h2>
      <form method="post" action="/admin/family-members" enctype="multipart/form-data">
        <label for="name">Name</label>
        <input id="name" name="name" required maxlength={maximumNameLength} value={props.name} />
        <label for="photo">Photo (optional; without one, the avatar shows the initial)</label>
        <input id="photo" name="photo" type="file" accept={photoTypes.join(",")} />
        <button type="submit">Add Family Member</button>
      </form>
    </AdminLayout>
  );
}

export function ViewsPage(props: {
  admin: SignedInAdmin;
  views: ViewSummary[];
  members: FamilyMemberSummary[];
  problem?: string;
}) {
  const nameOf = (id: string) => props.members.find((member) => member.id === id)?.name ?? "";
  return (
    <AdminLayout title="Views" admin={props.admin}>
      <p>
        Anyone on the home network can open a View at its address, without signing in. Its quick filter
        starts with the preselected Family Members, or with everyone if none are.
      </p>
      <Problem message={props.problem} />
      <ul class="entries">
        {props.views.map((view) => (
          <li>
            <p>
              <a href={viewUrl(view.id)}>{viewUrl(view.id)}</a>:{" "}
              {view.preselected.length > 0 ? view.preselected.map(nameOf).join(", ") : "everyone"}, {view.horizonDays}{" "}
              {view.horizonDays === 1 ? "day" : "days"}
            </p>
            <ViewSettingsForm action={`/admin/views/${view.id}`} members={props.members} view={view} submit="Save" />
            <form method="post" action={`/admin/views/${view.id}/remove`}>
              <button type="submit">Remove View</button>
            </form>
          </li>
        ))}
      </ul>
      <h2>Create a View</h2>
      <ViewSettingsForm action="/admin/views" members={props.members} submit="Create View" />
    </AdminLayout>
  );
}

function ViewSettingsForm(props: {
  action: string;
  members: FamilyMemberSummary[];
  view?: ViewSummary;
  submit: string;
}) {
  const id = (name: string) => `${name}-${props.view?.id ?? "new"}`;
  return (
    <form method="post" action={props.action}>
      <fieldset>
        <legend>Preselected Family Members</legend>
        {props.members.length === 0 ? <p>No Family Members yet.</p> : null}
        {props.members.map((member) => (
          <label>
            <input
              type="checkbox"
              name="preselected"
              value={member.id}
              checked={props.view?.preselected.includes(member.id) ?? false}
            />{" "}
            {member.name}
          </label>
        ))}
      </fieldset>
      <label for={id("horizon")}>
        Horizon in days ({horizonDaysRange.min} to {horizonDaysRange.max}), today included
      </label>
      <input
        id={id("horizon")}
        name="horizonDays"
        type="number"
        required
        min={horizonDaysRange.min}
        max={horizonDaysRange.max}
        value={String(props.view?.horizonDays ?? defaultHorizonDays)}
      />
      <button type="submit">{props.submit}</button>
    </form>
  );
}

export function SourceTypesPage(props: {
  admin: SignedInAdmin;
  sourceTypes: SourceTypeSummary[];
  problem?: string;
}) {
  return (
    <AdminLayout title="Source Types" admin={props.admin}>
      <p>
        Each Source Type is provided by an installed plugin. Enable the ones your Family uses: only their
        code is loaded, and only they are offered when adding a Source. Nothing is enabled without an Admin.
      </p>
      <Problem message={props.problem} />
      {props.sourceTypes.length === 0 ? <p>No Source Types are installed.</p> : null}
      <ul class="entries">
        {props.sourceTypes.map((type) => (
          <li>
            <h2>
              {type.displayName} {type.isNew ? <small>(new in {type.firstSeenIn})</small> : null}
            </h2>
            <p>{type.description}</p>
            <p>
              Version {type.version}
              {type.needsLlm ? ". Its Sources need the LLM endpoint." : null}
            </p>
            {type.notLoadable !== null ? <p class="problem">Not loadable: {type.notLoadable}</p> : null}
            {type.enabled ? (
              <form method="post" action={`/admin/source-types/${type.id}/disable`}>
                <p>Enabled. It can be disabled once it has no Sources.</p>
                <button type="submit">Disable {type.displayName}</button>
              </form>
            ) : type.notLoadable !== null ? null : (
              <form method="post" action={`/admin/source-types/${type.id}/enable`}>
                {type.riskNotice !== null ? (
                  <>
                    <p class="problem">{type.riskNotice}</p>
                    <label>
                      <input type="checkbox" name="riskAcknowledged" value="yes" required /> I understand the risk.
                    </label>
                  </>
                ) : null}
                <button type="submit">Enable {type.displayName}</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </AdminLayout>
  );
}

export function SourcesPage(props: {
  admin: SignedInAdmin;
  sources: SourceSummary[];
  forms: SourceForm[];
  problem?: string;
}) {
  const formOf = (id: string) => props.forms.find((form) => form.sourceTypeId === id);
  return (
    <AdminLayout title="Sources" admin={props.admin}>
      <Problem message={props.problem} />
      <ul class="entries">
        {props.sources.map((source) => {
          const form = formOf(source.sourceTypeId);
          return (
            <li>
              <h2>{source.displayName}</h2>
              {form ? (
                <form method="post" action={`/admin/sources/${source.id}`}>
                  <SourceFields form={form} prefix={source.id} source={source} />
                  <button type="submit">Save</button>
                </form>
              ) : (
                <p class="problem">Its Source Type is not enabled or not installed, so it is not read.</p>
              )}
              <form method="post" action={`/admin/sources/${source.id}/remove`}>
                <p>Removing a Source stops reading it. What it has brought in stays on the timeline.</p>
                <button type="submit">Remove this {source.displayName}</button>
              </form>
            </li>
          );
        })}
      </ul>
      {props.forms.length === 0 ? (
        <p>
          No Source Type is enabled. <a href="/admin/source-types">Enable one</a> to add a Source.
        </p>
      ) : null}
      {props.forms.map((form) => (
        <>
          <h2>Add a {form.displayName}</h2>
          <form method="post" action="/admin/sources">
            <input type="hidden" name="sourceTypeId" value={form.sourceTypeId} />
            <SourceFields form={form} prefix={`new-${form.sourceTypeId}`} />
            <button type="submit">Add {form.displayName}</button>
          </form>
        </>
      ))}
    </AdminLayout>
  );
}

/** The fields a plugin declares; a secret is never shown, only whether one is stored. */
function SourceFields(props: { form: SourceForm; prefix: string; source?: SourceSummary }) {
  const { form, prefix, source } = props;
  const id = (key: string) => `${prefix}-${key}`;
  const plainValue = (key: string) => {
    const value = source?.plain[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  };
  return (
    <>
      {form.fields.map((field) => {
        const stored = field.secret && source?.storedSecrets.includes(field.key);
        return (
          <>
            <label for={id(field.key)}>
              {field.label}
              {field.required ? null : " (optional)"}
            </label>
            {field.description ? <small>{field.description}</small> : null}
            {field.secret ? (
              <input
                id={id(field.key)}
                name={`secret.${field.key}`}
                type="password"
                autocomplete="off"
                required={field.required && !stored}
                placeholder={stored ? "Stored; leave empty to keep it" : undefined}
              />
            ) : (
              <input id={id(field.key)} name={`plain.${field.key}`} required={field.required} value={plainValue(field.key)} />
            )}
          </>
        );
      })}
      {form.suggestedIntervalSeconds !== null ? (
        <>
          <label for={id("interval")}>Check every … minutes (empty for the suggested {form.suggestedIntervalSeconds / 60})</label>
          <input
            id={id("interval")}
            name="pollIntervalMinutes"
            type="number"
            min={pollIntervalRange.minSeconds / 60}
            max={pollIntervalRange.maxSeconds / 60}
            placeholder={String(form.suggestedIntervalSeconds / 60)}
            value={source?.pollIntervalSeconds != null ? String(source.pollIntervalSeconds / 60) : undefined}
          />
        </>
      ) : null}
    </>
  );
}

export function LlmEndpointPage(props: {
  admin: SignedInAdmin;
  endpoint: LlmEndpointSummary | null;
  /** What the Admin entered, shown again with a problem. */
  entered?: { baseUrl: string; model: string; vision: boolean };
  problem?: string;
}) {
  const { endpoint } = props;
  const shown = props.entered ?? endpoint;
  return (
    <AdminLayout title="LLM endpoint" admin={props.admin}>
      <p>
        Sources such as mailboxes bring in messages, not Events. A language model reads the Events from each
        message. Family Butler talks to any server with an OpenAI-compatible API: a local one such as Ollama,
        llama.cpp or LM Studio, or a cloud provider with an API key.
      </p>
      {endpoint ? (
        <p>
          Messages are read by <strong>{endpoint.model}</strong> at {endpoint.baseUrl},{" "}
          {endpoint.local ? "on your home network." : "outside your home network."}
        </p>
      ) : (
        <p>No LLM endpoint is configured yet. Messages wait until one is.</p>
      )}
      <Problem message={props.problem} />
      <form method="post" action="/admin/llm">
        <label for="baseUrl">Base URL of the OpenAI-compatible API</label>
        <small>Such as http://ollama:11434/v1 for Ollama in Compose, or https://api.openai.com/v1.</small>
        <input id="baseUrl" name="baseUrl" type="url" required value={shown?.baseUrl} />
        <label for="model">Model</label>
        <input id="model" name="model" required value={shown?.model} />
        <label for="apiKey">API key (optional)</label>
        <input
          id="apiKey"
          name="apiKey"
          type="password"
          autocomplete="off"
          placeholder={endpoint?.hasApiKey ? "Stored; leave empty to keep it" : undefined}
        />
        {endpoint?.hasApiKey ? (
          <label>
            <input type="checkbox" name="removeApiKey" value="yes" /> Remove the stored API key
          </label>
        ) : null}
        <label>
          <input type="checkbox" name="vision" value="yes" checked={shown?.vision} /> The model reads images.
          Scanned PDF letters are sent to it as images of their pages; otherwise Tesseract reads them on this
          Instance.
        </label>
        <label>
          <input type="checkbox" name="thirdPartiesAcknowledged" value="yes" /> If this server is outside my home
          network: I understand that the text of messages from third parties, such as teachers' mails, is sent to it.
        </label>
        <button type="submit">Save</button>
      </form>
    </AdminLayout>
  );
}

export function MessagePage(props: { admin: SignedInAdmin; message: MessageDetails; timeZone: string }) {
  const { message } = props;
  const sentAt = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: props.timeZone,
  }).format(message.sentAt);
  return (
    <AdminLayout title="Message" admin={props.admin}>
      <dl>
        <dt>Sent</dt>
        <dd>{sentAt}</dd>
        {Object.entries(message.attributes).map(([key, value]) => (
          <>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </>
        ))}
      </dl>
      {message.text === null ? <p>The text of this message has been deleted.</p> : <pre class="message">{message.text}</pre>}
      {message.attachments.length > 0 ? (
        <>
          <h2>Attachments</h2>
          <ul>
            {message.attachments.map((attachment) => (
              <li>
                {attachment.filename} ({attachment.contentType}, {Math.ceil(attachment.size / 1024)} KB)
                {attachment.conversionProblem !== null ? (
                  <p class="problem">Could not be read for extraction: {attachment.conversionProblem}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </AdminLayout>
  );
}
