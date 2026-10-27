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
} from "@family-agenda/application";
import {
  defaultHorizonDays,
  horizonDaysRange,
  maximumNameLength,
  minimumPasswordLength,
  photoTypes,
} from "@family-agenda/domain";
import type { Child } from "hono/jsx";
import { Layout, Problem } from "./layout";
import { Avatar, viewUrl } from "./view-page";

export function FirstAdminPage(props: { email?: string; problem?: string }) {
  return (
    <Layout title="Create the first Admin" narrow>
      <h1 class="fam-title">Create the first Admin</h1>
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
    <Layout title="Sign in" narrow>
      <h1 class="fam-title">Sign in</h1>
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

/** What the settings list says about each section, gathered for every Admin page. */
export type SettingsSummary = {
  members: string[];
  views: number;
  sources: number;
  enabledSourceTypes: number;
  llm: { model: string; local: boolean } | null;
  admins: number;
  kitSaved: boolean;
};

/** The Admin a page is shown to, whether the new-Source-Types banner shows, and the settings list. */
export type SignedInAdmin = AdminSummary & { newSourceTypes: boolean; settings: SettingsSummary };

type SectionId = "members" | "views" | "sources" | "source-types" | "llm" | "admins" | "recovery-kit";

type Summary = { text: string; tone?: "attention" };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The settings list: sections in groups, each with where it is and what it says about itself. */
const settingsGroups: { name: string; sections: { id: SectionId; href: string; label: string; summary: (s: SignedInAdmin) => Summary }[] }[] = [
  {
    name: "Family",
    sections: [
      {
        id: "members",
        href: "/admin/family-members",
        label: "Family Members",
        summary: ({ settings }) => ({ text: settings.members.length > 0 ? settings.members.join(", ") : "None yet" }),
      },
      {
        id: "views",
        href: "/admin/views",
        label: "Views",
        summary: ({ settings }) => ({ text: settings.views > 0 ? `${plural(settings.views, "View", "Views")} on the home network` : "None yet" }),
      },
    ],
  },
  {
    name: "Sources",
    sections: [
      {
        id: "sources",
        href: "/admin/sources",
        label: "Sources",
        summary: ({ settings }) => ({ text: settings.sources > 0 ? plural(settings.sources, "Source", "Sources") : "None yet" }),
      },
      {
        id: "source-types",
        href: "/admin/source-types",
        label: "Source Types",
        summary: (admin) =>
          admin.newSourceTypes
            ? { text: "New ones are available", tone: "attention" }
            : { text: `${admin.settings.enabledSourceTypes} enabled` },
      },
      {
        id: "llm",
        href: "/admin/llm",
        label: "LLM endpoint",
        summary: ({ settings }) =>
          settings.llm
            ? { text: `${settings.llm.model}, ${settings.llm.local ? "on the home network" : "outside the home network"}` }
            : { text: "Not set up" },
      },
    ],
  },
  {
    name: "Instance",
    sections: [
      {
        id: "admins",
        href: "/admin/admins",
        label: "Admins",
        summary: ({ settings }) => ({ text: plural(settings.admins, "Admin", "Admins") }),
      },
      {
        id: "recovery-kit",
        href: "/admin/recovery-kit",
        label: "Recovery Kit",
        summary: ({ settings }) => (settings.kitSaved ? { text: "Saved" } : { text: "Not saved yet", tone: "attention" }),
      },
    ],
  },
];

/** A section's line icon, drawn in the text colour. */
function SectionIcon(props: { id: SectionId }) {
  const paths: Record<SectionId, Child> = {
    members: (
      <>
        <circle cx="9" cy="8" r="3.5"></circle>
        <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"></path>
        <circle cx="17" cy="9" r="2.5"></circle>
        <path d="M17 14c2.4 0 4 1.5 4.5 4"></path>
      </>
    ),
    views: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2.5"></rect>
        <path d="M9 21h6M12 17v4"></path>
      </>
    ),
    sources: (
      <>
        <path d="M3 13l2.5-7h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
        <path d="M3 13h5l1.5 2.5h5L16 13h5"></path>
      </>
    ),
    "source-types": (
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="2"></rect>
        <rect x="13.5" y="3.5" width="7" height="7" rx="2"></rect>
        <rect x="3.5" y="13.5" width="7" height="7" rx="2"></rect>
        <path d="M17 14v6M14 17h6"></path>
      </>
    ),
    llm: (
      <>
        <path d="M4 5h16v11H9l-5 4z"></path>
        <path d="M8 9h8M8 12h5"></path>
      </>
    ),
    admins: (
      <>
        <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"></path>
        <path d="M9 12l2 2 4-4"></path>
      </>
    ),
    "recovery-kit": (
      <>
        <circle cx="8" cy="15" r="4"></circle>
        <path d="M11 12l9-9M16 7l3 3M14 9l2 2"></path>
      </>
    ),
  };
  return (
    <svg class="fam-navitem__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {paths[props.id]}
    </svg>
  );
}

/**
 * The Admin area: the settings list beside the current section's details, and a dialog over
 * them while something is being added.
 */
function AdminLayout(props: {
  title: string;
  admin: SignedInAdmin;
  current: SectionId | null;
  dialog?: Child;
  children: Child;
}) {
  const { admin, current } = props;
  return (
    <Layout title={props.title}>
      <header class="fam-settings__header">
        <div class="fam-settings__brand">
          <a href="/admin">Family Agenda</a>
          <span>Settings</span>
        </div>
        <div class="fam-settings__account">
          <span class="fam-nav__who">{admin.email}</span>
          <form method="post" action="/admin/sign-out">
            <button type="submit" class="fam-button fam-button--quiet">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div class="fam-settings">
        <nav class="fam-settings__nav" aria-label="Settings">
          {settingsGroups.map((group) => (
            <>
              <span class="fam-settings__group">{group.name}</span>
              {group.sections.map((section) => {
                const summary = section.summary(admin);
                return (
                  <a class="fam-navitem" href={section.href} aria-current={current === section.id ? "page" : undefined}>
                    <SectionIcon id={section.id} />
                    <span class="fam-navitem__text">
                      <span class="fam-navitem__label">{section.label}</span>
                      <span class={summary.tone ? `fam-navitem__summary fam-navitem__summary--${summary.tone}` : "fam-navitem__summary"}>
                        {summary.text}
                      </span>
                    </span>
                  </a>
                );
              })}
            </>
          ))}
        </nav>
        <main class="fam-settings__main">
          {admin.newSourceTypes && current !== "source-types" ? (
            <div class="fam-banner fam-banner--attention" role="status">
              <span class="fam-banner__glyph" aria-hidden="true">
                !
              </span>
              <span class="fam-banner__title">New Source Types are available</span>
              <div class="fam-banner__body">
                <a href="/admin/source-types">Look at them</a>
              </div>
            </div>
          ) : null}
          {props.children}
        </main>
      </div>
      {props.dialog}
    </Layout>
  );
}

/** A section's heading, what it is for, and its one action. */
function SectionHeader(props: { title: string; description?: Child; action?: Child }) {
  return (
    <header class="fam-section-header">
      <div class="fam-section-header__text">
        <h1 class="fam-section-header__title">{props.title}</h1>
        {props.description ? <p class="fam-section-header__description">{props.description}</p> : null}
      </div>
      {props.action}
    </header>
  );
}

/**
 * A modal dialog over the section, at its own address so that it works without JavaScript;
 * closing it goes back to the section.
 */
function Dialog(props: { id: string; eyebrow?: string; title: string; closeHref: string; children: Child }) {
  return (
    <dialog open class="fam-dialog" aria-labelledby={`${props.id}-title`} data-close={props.closeHref}>
      <div class="fam-dialog__header">
        <div class="fam-dialog__heading">
          {props.eyebrow ? <span class="fam-dialog__eyebrow">{props.eyebrow}</span> : null}
          <h2 id={`${props.id}-title`} class="fam-dialog__title">
            {props.title}
          </h2>
        </div>
        <a class="fam-button fam-button--quiet fam-dialog__close" href={props.closeHref} aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18"></path>
          </svg>
        </a>
      </div>
      {props.children}
    </dialog>
  );
}

/** A dialog's buttons: going back a step, cancelling, and its one action. */
function DialogFooter(props: { closeHref: string; submit: string; backHref?: string }) {
  return (
    <div class="fam-dialog__footer">
      {props.backHref ? (
        <a class="fam-button fam-button--quiet" href={props.backHref}>
          Back
        </a>
      ) : null}
      <span class="fam-dialog__spacer"></span>
      <a class="fam-button fam-button--quiet" href={props.closeHref}>
        Cancel
      </a>
      <button type="submit" class="fam-button fam-button--primary">
        {props.submit}
      </button>
    </div>
  );
}

/** An entry that opens in place for editing: its row as the summary, its form below. */
function EditableEntry(props: { lead?: Child; name: Child; meta?: Child; open?: boolean; children: Child }) {
  return (
    <details class="fam-edit" open={props.open}>
      <summary class="fam-edit__summary">
        {props.lead}
        <span class="fam-entry__main">
          <span class="fam-entry__name">{props.name}</span>
          {props.meta ? <span class="fam-entry__meta">{props.meta}</span> : null}
        </span>
        <span class="fam-button fam-button--quiet fam-edit__toggle" aria-hidden="true">
          <span class="fam-edit__when-closed">Edit</span>
          <span class="fam-edit__when-open">Close</span>
        </span>
      </summary>
      <div class="fam-edit__body">{props.children}</div>
    </details>
  );
}

const addButton = (href: string, label: string) => (
  <a class="fam-button fam-button--primary" href={href}>
    {label}
  </a>
);

export function AdminsPage(props: {
  admin: SignedInAdmin;
  admins: AdminSummary[];
  problem?: string;
  /** The add dialog, open with what was entered and why it was refused. */
  adding?: { email?: string; problem?: string };
}) {
  const { adding } = props;
  const dialog = adding ? (
    <Dialog id="add-admin" eyebrow="Instance" title="Add an Admin" closeHref="/admin/admins">
      <form method="post" action="/admin/admins" class="fam-dialog__form">
        <Problem message={adding.problem} />
        <div class="fam-field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required autofocus value={adding.email} />
        </div>
        <div class="fam-field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required minlength={minimumPasswordLength} autocomplete="new-password" />
          <small>At least {minimumPasswordLength} characters. Tell it to them in person.</small>
        </div>
        <DialogFooter closeHref="/admin/admins" submit="Add Admin" />
      </form>
    </Dialog>
  ) : undefined;
  return (
    <AdminLayout title="Admins" admin={props.admin} current="admins" dialog={dialog}>
      <SectionHeader
        title="Admins"
        description="Parents who sign in to manage settings and Sources. A forgotten password is reset by another Admin."
        action={addButton("/admin/admins/new", "Add Admin")}
      />
      <Problem message={props.problem} />
      <ul class="fam-panel fam-entries">
        {props.admins.map((other) =>
          other.id === props.admin.id ? (
            <li class="fam-entry">
              <span class="fam-entry__main">
                <span class="fam-entry__name">{other.email}</span>
                <span class="fam-entry__meta">You</span>
              </span>
            </li>
          ) : (
            <li>
              <EditableEntry name={other.email} meta="Admin">
                <form method="post" action={`/admin/admins/${other.id}/password`}>
                  <div class="fam-field">
                    <label for={`password-${other.id}`}>New password</label>
                    <input id={`password-${other.id}`} name="password" type="password" required minlength={minimumPasswordLength} autocomplete="new-password" />
                  </div>
                  <button type="submit" class="fam-button fam-button--secondary">
                    Reset password
                  </button>
                </form>
              </EditableEntry>
            </li>
          ),
        )}
      </ul>
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
  return ["Family Agenda Recovery Kit", "", "Master key:", kit.masterKey, "", ...recoveryKitPurpose, ""].join("\n");
}

export function RecoveryKitPage(props: {
  admin: SignedInAdmin;
  kit: RecoveryKit;
  confirmed: boolean;
  problem?: string | undefined;
}) {
  const actions = (
    <p class="fam-actions">
      <button
        type="button"
        class="fam-button fam-button--secondary"
        onclick="for (const kit of document.querySelectorAll('details.fam-reveal')) kit.open = true; window.print()"
      >
        Print
      </button>
      <a href="/admin/recovery-kit/download">Download as a text file</a>
    </p>
  );
  return (
    <AdminLayout title="Recovery Kit" admin={props.admin} current="recovery-kit">
      <SectionHeader
        title="Recovery Kit"
        description="Restoring a Backup needs it to read the Source credentials. Keep it offline, away from the Instance."
      />
      {props.confirmed ? (
        <>
          <div class="fam-banner fam-banner--success" role="status">
            <span class="fam-banner__glyph" aria-hidden="true">
              ✓
            </span>
            <span class="fam-banner__title">Saved</span>
            <div class="fam-banner__body">An Admin confirmed it was printed or saved.</div>
          </div>
          <div class="fam-panel fam-panel--padded">
            <details class="fam-reveal">
              <summary class="fam-button fam-button--secondary">
                <span class="fam-edit__when-closed">Show master key</span>
                <span class="fam-edit__when-open">Hide master key</span>
              </summary>
              <p class="fam-secret">{props.kit.masterKey}</p>
            </details>
            {recoveryKitPurpose.map((sentence) => (
              <p>{sentence}</p>
            ))}
            {actions}
          </div>
        </>
      ) : (
        <>
          <div class="fam-banner fam-banner--attention" role="status">
            <span class="fam-banner__glyph" aria-hidden="true">
              !
            </span>
            <span class="fam-banner__title">Save it before you continue</span>
            <div class="fam-banner__body">Print it or download it. Any Admin can show it again later.</div>
          </div>
          <div class="fam-panel fam-panel--padded">
            <h2>Master key</h2>
            <p class="fam-secret">{props.kit.masterKey}</p>
            {recoveryKitPurpose.map((sentence) => (
              <p>{sentence}</p>
            ))}
            {actions}
            <form method="post" action="/admin/recovery-kit/confirm">
              <Problem message={props.problem} />
              <label>
                <input type="checkbox" name="saved" value="yes" required /> I have printed or saved the Recovery Kit.
              </label>
              <button type="submit">Continue</button>
            </form>
          </div>
        </>
      )}
    </AdminLayout>
  );
}

export function FamilyMembersPage(props: {
  admin: SignedInAdmin;
  members: FamilyMemberSummary[];
  problem?: string;
  /** The add dialog, open with what was entered and why it was refused. */
  adding?: { name?: string; problem?: string };
}) {
  const { adding } = props;
  const dialog = adding ? (
    <Dialog id="add-member" eyebrow="Family" title="Add a Family Member" closeHref="/admin/family-members">
      <form method="post" action="/admin/family-members" enctype="multipart/form-data" class="fam-dialog__form">
        <Problem message={adding.problem} />
        <div class="fam-field">
          <label for="name">Name</label>
          <input id="name" name="name" required autofocus maxlength={maximumNameLength} value={adding.name} />
          <small>How the Views call them, up to {maximumNameLength} characters.</small>
        </div>
        <div class="fam-field">
          <label for="photo">Photo (optional)</label>
          <input id="photo" name="photo" type="file" accept={photoTypes.join(",")} />
          <small>Without one, the avatar shows the initial on a colour of its own.</small>
        </div>
        <DialogFooter closeHref="/admin/family-members" submit="Add Family Member" />
      </form>
    </Dialog>
  ) : undefined;
  return (
    <AdminLayout title="Family Members" admin={props.admin} current="members" dialog={dialog}>
      <SectionHeader
        title="Family Members"
        description="Whom Items can concern. Each keeps an avatar colour; a photo replaces the initial."
        action={addButton("/admin/family-members/new", "Add Family Member")}
      />
      <Problem message={props.problem} />
      {props.members.length === 0 ? (
        <p class="fam-empty">No Family Members yet.</p>
      ) : (
        <ul class="fam-panel fam-entries">
          {props.members.map((member) => (
            <li>
              <EditableEntry lead={<Avatar member={member} />} name={member.name} meta={member.hasPhoto ? "With a photo" : "Shows the initial"}>
                <form method="post" action={`/admin/family-members/${member.id}`} enctype="multipart/form-data">
                  <div class="fam-field">
                    <label for={`name-${member.id}`}>Name</label>
                    <input id={`name-${member.id}`} name="name" required maxlength={maximumNameLength} value={member.name} />
                  </div>
                  <div class="fam-field">
                    <label for={`photo-${member.id}`}>{member.hasPhoto ? "Replace photo" : "Photo (optional)"}</label>
                    <input id={`photo-${member.id}`} name="photo" type="file" accept={photoTypes.join(",")} />
                  </div>
                  {member.hasPhoto ? (
                    <label>
                      <input type="checkbox" name="removePhoto" value="yes" /> Remove photo
                    </label>
                  ) : null}
                  <button type="submit">Save</button>
                </form>
                <form method="post" action={`/admin/family-members/${member.id}/remove`}>
                  <button type="submit" class="fam-button fam-button--danger">
                    Remove {member.name}
                  </button>
                </form>
              </EditableEntry>
            </li>
          ))}
        </ul>
      )}
    </AdminLayout>
  );
}

export function ViewsPage(props: {
  admin: SignedInAdmin;
  views: ViewSummary[];
  members: FamilyMemberSummary[];
  problem?: string;
  /** The create dialog, open with why it was refused. */
  creating?: { problem?: string };
}) {
  const memberOf = (id: string) => props.members.find((member) => member.id === id);
  const { creating } = props;
  const dialog = creating ? (
    <Dialog id="create-view" eyebrow="Family" title="Create a View" closeHref="/admin/views">
      <form method="post" action="/admin/views" class="fam-dialog__form">
        <Problem message={creating.problem} />
        <ViewSettingsFields members={props.members} idSuffix="new" />
        <DialogFooter closeHref="/admin/views" submit="Create View" />
      </form>
    </Dialog>
  ) : undefined;
  return (
    <AdminLayout title="Views" admin={props.admin} current="views" dialog={dialog}>
      <SectionHeader
        title="Views"
        description="What the Family opens on the home network, without signing in. Anyone on your Wi-Fi can open them."
        action={addButton("/admin/views/new", "Create View")}
      />
      <Problem message={props.problem} />
      {props.views.length === 0 ? (
        <p class="fam-empty">No Views yet.</p>
      ) : (
        <ul class="fam-panel fam-entries">
          {props.views.map((view) => {
            const preselected = view.preselected.map(memberOf).filter((member) => member !== undefined);
            const who = preselected.length > 0 ? preselected.map((member) => member.name).join(", ") : "Everyone";
            return (
              <li>
                <EditableEntry
                  lead={
                    preselected.length > 0 ? (
                      <span class="fam-avatars">
                        {preselected.map((member) => (
                          <Avatar member={member} size="sm" />
                        ))}
                      </span>
                    ) : (
                      <span class="fam-avatar fam-avatar--all fam-avatar--sm" aria-hidden="true"></span>
                    )
                  }
                  name={`${who} · ${view.horizonDays} ${view.horizonDays === 1 ? "day" : "days"}`}
                  meta={`The quick filter starts with ${preselected.length > 0 ? who : "everyone"}`}
                >
                  <form method="post" action={`/admin/views/${view.id}`}>
                    <ViewSettingsFields members={props.members} view={view} idSuffix={view.id} />
                    <button type="submit">Save</button>
                  </form>
                  <form method="post" action={`/admin/views/${view.id}/remove`}>
                    <button type="submit" class="fam-button fam-button--danger">
                      Remove View
                    </button>
                  </form>
                </EditableEntry>
                <dl class="fam-entry__links">
                  <dt>Address</dt>
                  <dd>
                    <a href={viewUrl(view.id)}>{viewUrl(view.id)}</a>
                  </dd>
                  <dt>Calendar feed</dt>
                  <dd>
                    <a href={`${viewUrl(view.id)}/feed.ics`}>{`${viewUrl(view.id)}/feed.ics`}</a>
                  </dd>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </AdminLayout>
  );
}

function ViewSettingsFields(props: { members: FamilyMemberSummary[]; view?: ViewSummary; idSuffix: string }) {
  const id = (name: string) => `${name}-${props.idSuffix}`;
  return (
    <>
      <fieldset>
        <legend>Preselected Family Members</legend>
        <small>The quick filter starts with them; none means everyone.</small>
        {props.members.length === 0 ? <p>No Family Members yet.</p> : null}
        <div class="fam-choices">
          {props.members.map((member) => (
            <label class="fam-choice">
              <input
                type="checkbox"
                name="preselected"
                value={member.id}
                checked={props.view?.preselected.includes(member.id) ?? false}
              />{" "}
              <Avatar member={member} size="sm" /> {member.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div class="fam-field">
        <label for={id("horizon")}>Horizon in days</label>
        <input
          id={id("horizon")}
          name="horizonDays"
          type="number"
          required
          min={horizonDaysRange.min}
          max={horizonDaysRange.max}
          value={String(props.view?.horizonDays ?? defaultHorizonDays)}
          class="fam-input--short"
        />
        <small>
          How many days it shows at a time, today included: {horizonDaysRange.min} to {horizonDaysRange.max}.
        </small>
      </div>
    </>
  );
}

export function SourceTypesPage(props: {
  admin: SignedInAdmin;
  sourceTypes: SourceTypeSummary[];
  problem?: string;
}) {
  return (
    <AdminLayout title="Source Types" admin={props.admin} current="source-types">
      <SectionHeader
        title="Source Types"
        description="Each Source Type is provided by an installed plugin. Enable the ones your Family uses: only their code is loaded, and only they are offered when adding a Source. Nothing is enabled without an Admin."
      />
      <Problem message={props.problem} />
      {props.sourceTypes.length === 0 ? <p class="fam-empty">No Source Types are installed.</p> : null}
      <ul class="fam-panel fam-entries">
        {props.sourceTypes.map((type) => (
          <li class="fam-entry fam-entry--wrap">
            <div class="fam-entry__main">
              <h2 class="fam-entry__name">
                {type.displayName} {type.isNew ? <span class="fam-tag">New in {type.firstSeenIn}</span> : null}
              </h2>
              <p class="fam-entry__meta">{type.description}</p>
              <p class="fam-entry__meta">
                Version {type.version}
                {type.needsLlm ? ". Its Sources need the LLM endpoint." : null}
              </p>
              {type.notLoadable !== null ? <p class="fam-problem">Not loadable: {type.notLoadable}</p> : null}
            </div>
            {type.enabled ? (
              <form method="post" action={`/admin/source-types/${type.id}/disable`} class="fam-entry__form">
                <span class="fam-status fam-status--ok">Enabled</span>
                <button type="submit" class="fam-button fam-button--secondary">
                  Disable {type.displayName}
                </button>
                <small>It can be disabled once it has no Sources.</small>
              </form>
            ) : type.notLoadable !== null ? null : (
              <form method="post" action={`/admin/source-types/${type.id}/enable`} class="fam-entry__form">
                {type.riskNotice !== null ? (
                  <>
                    <p class="fam-problem">{type.riskNotice}</p>
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

/** What adding a Source shows in its dialog: the Source Types to choose from, or one's form. */
export type SourceAdding =
  | { step: "choose" }
  | { step: "form"; form: SourceForm; entered?: { plain: Record<string, string>; interval: string }; problem?: string };

export function SourcesPage(props: {
  admin: SignedInAdmin;
  sources: SourceSummary[];
  forms: SourceForm[];
  problem?: string;
  adding?: SourceAdding;
}) {
  const formOf = (id: string) => props.forms.find((form) => form.sourceTypeId === id);
  const { adding } = props;
  const dialog =
    adding?.step === "choose" ? (
      <Dialog id="add-source" eyebrow="Add a Source · 1 of 2" title="Choose a Source Type" closeHref="/admin/sources">
        <div class="fam-dialog__form">
          <p class="fam-section-header__description">Which kind of channel? Only enabled Source Types are offered.</p>
          <ul class="fam-options">
            {props.forms.map((form, index) => (
              <li>
                <a class="fam-option" href={`/admin/sources/new?type=${encodeURIComponent(form.sourceTypeId)}`} autofocus={index === 0}>
                  <span class="fam-option__label">{form.displayName}</span>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M9 6l6 6-6 6"></path>
                  </svg>
                </a>
              </li>
            ))}
          </ul>
          <small>
            Missing one? Enable it under <a href="/admin/source-types">Source Types</a>.
          </small>
          <div class="fam-dialog__footer">
            <span class="fam-dialog__spacer"></span>
            <a class="fam-button fam-button--quiet" href="/admin/sources">
              Cancel
            </a>
          </div>
        </div>
      </Dialog>
    ) : adding?.step === "form" ? (
      <Dialog
        id="add-source"
        eyebrow={props.forms.length > 1 ? "Add a Source · 2 of 2" : "Add a Source"}
        title={adding.form.displayName}
        closeHref="/admin/sources"
      >
        <form method="post" action="/admin/sources" class="fam-dialog__form">
          <Problem message={adding.problem} />
          <input type="hidden" name="sourceTypeId" value={adding.form.sourceTypeId} />
          <SourceFields form={adding.form} prefix={`new-${adding.form.sourceTypeId}`} {...(adding.entered ? { entered: adding.entered } : {})} autofocus />
          <DialogFooter
            closeHref="/admin/sources"
            submit={`Add ${adding.form.displayName}`}
            {...(props.forms.length > 1 ? { backHref: "/admin/sources/new" } : {})}
          />
        </form>
      </Dialog>
    ) : undefined;
  return (
    <AdminLayout title="Sources" admin={props.admin} current="sources" dialog={dialog}>
      <SectionHeader
        title="Sources"
        description="The channels information arrives through. Removing a Source stops reading it; what it has brought in stays on the timeline."
        action={props.forms.length > 0 ? addButton("/admin/sources/new", "Add Source") : undefined}
      />
      <Problem message={props.problem} />
      {props.forms.length === 0 ? (
        <p class="fam-empty">
          No Source Type is enabled. <a href="/admin/source-types">Enable one</a> to add a Source.
        </p>
      ) : null}
      {props.sources.length === 0 ? null : (
        <ul class="fam-panel fam-entries">
          {props.sources.map((source) => {
            const form = formOf(source.sourceTypeId);
            return (
              <li>
                <EditableEntry name={source.displayName} meta={sourceMeta(source, form)}>
                  {form ? (
                    <form method="post" action={`/admin/sources/${source.id}`}>
                      <SourceFields form={form} prefix={source.id} source={source} />
                      <button type="submit">Save</button>
                    </form>
                  ) : (
                    <p class="fam-problem">Its Source Type is not enabled or not installed, so it is not read.</p>
                  )}
                  <form method="post" action={`/admin/sources/${source.id}/remove`}>
                    <button type="submit" class="fam-button fam-button--danger">
                      Remove this {source.displayName}
                    </button>
                  </form>
                </EditableEntry>
              </li>
            );
          })}
        </ul>
      )}
    </AdminLayout>
  );
}

/** A Source's row: its plain settings, whether a secret is stored, and how often it is checked. */
function sourceMeta(source: SourceSummary, form: SourceForm | undefined): string {
  const plain = Object.values(source.plain)
    .filter((value) => (typeof value === "string" && value !== "") || typeof value === "number")
    .map(String);
  const secrets = source.storedSecrets.length > 0 ? ["secret stored"] : [];
  const seconds = source.pollIntervalSeconds ?? form?.suggestedIntervalSeconds ?? null;
  const interval = seconds !== null ? [`every ${plural(seconds / 60, "minute", "minutes")}`] : [];
  return [...plain, ...secrets, ...interval].join(" · ");
}

/** The fields a plugin declares; a secret is never shown, only whether one is stored. */
function SourceFields(props: {
  form: SourceForm;
  prefix: string;
  source?: SourceSummary;
  entered?: { plain: Record<string, string>; interval: string };
  autofocus?: boolean;
}) {
  const { form, prefix, source, entered } = props;
  const id = (key: string) => `${prefix}-${key}`;
  const plainValue = (key: string) => {
    if (entered) return entered.plain[key] || undefined;
    const value = source?.plain[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  };
  const interval = entered
    ? entered.interval || undefined
    : source?.pollIntervalSeconds != null
      ? String(source.pollIntervalSeconds / 60)
      : undefined;
  return (
    <>
      {form.fields.map((field, index) => {
        const stored = field.secret && source?.storedSecrets.includes(field.key);
        const focus = props.autofocus === true && index === 0;
        return (
          <div class="fam-field">
            <label for={id(field.key)}>
              {field.label}
              {field.required ? null : " (optional)"}
            </label>
            {field.secret ? (
              <input
                id={id(field.key)}
                name={`secret.${field.key}`}
                type="password"
                autocomplete="off"
                autofocus={focus}
                required={field.required && !stored}
                placeholder={stored ? "Stored; leave empty to keep it" : undefined}
              />
            ) : (
              <input id={id(field.key)} name={`plain.${field.key}`} autofocus={focus} required={field.required} value={plainValue(field.key)} />
            )}
            {field.description ? <small>{field.description}</small> : null}
          </div>
        );
      })}
      {form.suggestedIntervalSeconds !== null ? (
        <div class="fam-field">
          <label for={id("interval")}>Check every … minutes (optional)</label>
          <input
            id={id("interval")}
            name="pollIntervalMinutes"
            type="number"
            min={pollIntervalRange.minSeconds / 60}
            max={pollIntervalRange.maxSeconds / 60}
            placeholder={String(form.suggestedIntervalSeconds / 60)}
            value={interval}
            class="fam-input--short"
          />
          <small>Empty for the suggested {form.suggestedIntervalSeconds / 60}.</small>
        </div>
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
    <AdminLayout title="LLM endpoint" admin={props.admin} current="llm">
      <SectionHeader
        title="LLM endpoint"
        description="Sources such as mailboxes bring in messages, not Events. A language model reads the Events from each message. Family Agenda talks to any server with an OpenAI-compatible API: a local one such as Ollama, llama.cpp or LM Studio, or a cloud provider with an API key."
      />
      {endpoint ? (
        <p class={endpoint.local ? "fam-callout fam-callout--ok" : "fam-callout"}>
          Messages are read by <strong>{endpoint.model}</strong> at {endpoint.baseUrl},{" "}
          {endpoint.local ? "on your home network." : "outside your home network."}
        </p>
      ) : (
        <p class="fam-callout">No LLM endpoint is configured yet. Messages wait until one is.</p>
      )}
      <Problem message={props.problem} />
      <form method="post" action="/admin/llm" class="fam-form-wide">
        <div class="fam-field">
          <label for="baseUrl">Base URL of the OpenAI-compatible API</label>
          <input id="baseUrl" name="baseUrl" type="url" required value={shown?.baseUrl} />
          <small>Such as http://ollama:11434/v1 for Ollama in Compose, or https://api.openai.com/v1.</small>
        </div>
        <div class="fam-field">
          <label for="model">Model</label>
          <input id="model" name="model" required value={shown?.model} />
        </div>
        <div class="fam-field">
          <label for="apiKey">API key (optional)</label>
          <input
            id="apiKey"
            name="apiKey"
            type="password"
            autocomplete="off"
            placeholder={endpoint?.hasApiKey ? "Stored; leave empty to keep it" : undefined}
          />
        </div>
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
    <AdminLayout title="Message" admin={props.admin} current={null}>
      <SectionHeader title="Message" description="The original an Event was read from. Only Admins open it." />
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
      {message.text === null ? <p>The text of this message has been deleted.</p> : <pre class="fam-message">{message.text}</pre>}
      {message.attachments.length > 0 ? (
        <>
          <h2>Attachments</h2>
          <ul>
            {message.attachments.map((attachment) => (
              <li>
                {attachment.filename} ({attachment.contentType}, {Math.ceil(attachment.size / 1024)} KB)
                {attachment.conversionProblem !== null ? (
                  <p class="fam-problem">Could not be read for extraction: {attachment.conversionProblem}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </AdminLayout>
  );
}
