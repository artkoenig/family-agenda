import {
  pollIntervalRange,
  type AdminSummary,
  type FamilyMemberSummary,
  type LanguageSettings,
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
  familyLanguages,
  horizonDaysRange,
  maximumNameLength,
  minimumPasswordLength,
  photoTypes,
  type FamilyLanguage,
  type OcrLanguage,
} from "@family-agenda/domain";
import type { Child } from "hono/jsx";
import { useTranslation, type Translation } from "./i18n/translation";
import type { Catalogue } from "./i18n/en";
import { Layout, Problem } from "./layout";
import { Avatar, viewUrl } from "./view-page";

/** The Family Languages to choose from, the given one selected. */
function FamilyLanguageOptions(props: { selected: FamilyLanguage }) {
  const { t } = useTranslation();
  return (
    <>
      {familyLanguages.map((language) => (
        <option value={language} selected={language === props.selected}>
          {t.familyLanguageOptions[language]}
        </option>
      ))}
    </>
  );
}

export function FirstAdminPage(props: { language: FamilyLanguage; email?: string; problem?: string }) {
  const { t } = useTranslation();
  return (
    <Layout title={t.setup.title} narrow>
      <h1 class="fam-title">{t.setup.title}</h1>
      <p>{t.setup.intro}</p>
      <Problem message={props.problem} />
      <form method="post" action="/setup">
        <label for="email">{t.common.email}</label>
        <input id="email" name="email" type="email" required autocomplete="username" value={props.email} />
        <label for="password">{t.setup.password}</label>
        <input id="password" name="password" type="password" required minlength={minimumPasswordLength} autocomplete="new-password" />
        <label for="language">{t.setup.familyLanguage}</label>
        <select id="language" name="language">
          <FamilyLanguageOptions selected={props.language} />
        </select>
        <small>{t.setup.familyLanguageHint}</small>
        <button type="submit">{t.setup.submit}</button>
      </form>
    </Layout>
  );
}

export function SignInPage(props: { email?: string; problem?: string }) {
  const { t } = useTranslation();
  return (
    <Layout title={t.signIn.title} narrow>
      <h1 class="fam-title">{t.signIn.title}</h1>
      <Problem message={props.problem} />
      <form method="post" action="/admin/sign-in">
        <label for="email">{t.common.email}</label>
        <input id="email" name="email" type="email" required autocomplete="username" value={props.email} />
        <label for="password">{t.common.password}</label>
        <input id="password" name="password" type="password" required autocomplete="current-password" />
        <button type="submit">{t.signIn.submit}</button>
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
  /** The Family Language, the OCR languages, and whether one of their models is missing. */
  language: { family: FamilyLanguage; ocr: OcrLanguage[]; missing: boolean };
};

/** The Admin a page is shown to, whether the new-Source-Types banner shows, and the settings list. */
export type SignedInAdmin = AdminSummary & { newSourceTypes: boolean; settings: SettingsSummary };

type SectionId = "members" | "views" | "language" | "sources" | "source-types" | "llm" | "admins" | "recovery-kit";

type Summary = { text: string; tone?: "attention" };

type SettingsGroup = {
  name: string;
  sections: { id: SectionId; href: string; label: string; summary: (s: SignedInAdmin) => Summary }[];
};

/** The settings list: sections in groups, each with where it is and what it says about itself. */
function settingsGroups(translation: Translation): SettingsGroup[] {
  const { t, list, ocrLanguageName } = translation;
  const s = t.settings;
  return [
    {
      name: s.groups.family,
      sections: [
        {
          id: "members",
          href: "/admin/family-members",
          label: t.members.title,
          summary: ({ settings }) => ({ text: settings.members.length > 0 ? settings.members.join(", ") : s.noneYet }),
        },
        {
          id: "views",
          href: "/admin/views",
          label: t.views.title,
          summary: ({ settings }) => ({ text: settings.views > 0 ? s.views(settings.views) : s.noneYet }),
        },
        {
          id: "language",
          href: "/admin/language",
          label: t.language.title,
          summary: ({ settings: { language } }) => ({
            text: s.language(t.familyLanguageNames[language.family], list(language.ocr.map(ocrLanguageName))),
            ...(language.missing ? { tone: "attention" as const } : {}),
          }),
        },
      ],
    },
    {
      name: s.groups.sources,
      sections: [
        {
          id: "sources",
          href: "/admin/sources",
          label: t.sources.title,
          summary: ({ settings }) => ({ text: settings.sources > 0 ? s.sources(settings.sources) : s.noneYet }),
        },
        {
          id: "source-types",
          href: "/admin/source-types",
          label: t.sourceTypes.title,
          summary: (admin) =>
            admin.newSourceTypes
              ? { text: s.newOnes, tone: "attention" }
              : { text: s.enabled(admin.settings.enabledSourceTypes) },
        },
        {
          id: "llm",
          href: "/admin/llm",
          label: t.llm.title,
          summary: ({ settings: { llm } }) =>
            llm ? { text: llm.local ? s.llmLocal(llm.model) : s.llmRemote(llm.model) } : { text: s.notSetUp },
        },
      ],
    },
    {
      name: s.groups.instance,
      sections: [
        {
          id: "admins",
          href: "/admin/admins",
          label: t.admins.title,
          summary: ({ settings }) => ({ text: s.admins(settings.admins) }),
        },
        {
          id: "recovery-kit",
          href: "/admin/recovery-kit",
          label: t.recoveryKit.title,
          summary: ({ settings }) => (settings.kitSaved ? { text: s.saved } : { text: s.notSavedYet, tone: "attention" }),
        },
      ],
    },
  ];
}

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
    language: (
      <>
        <circle cx="12" cy="12" r="9"></circle>
        <path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"></path>
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
  const translation = useTranslation();
  const { t } = translation;
  return (
    <Layout title={props.title}>
      <header class="fam-settings__header">
        <div class="fam-settings__brand">
          <a href="/admin">Family Agenda</a>
          <span>{t.settings.title}</span>
        </div>
        <div class="fam-settings__account">
          <span class="fam-nav__who">{admin.email}</span>
          <form method="post" action="/admin/sign-out">
            <button type="submit" class="fam-button fam-button--quiet">
              {t.settings.signOut}
            </button>
          </form>
        </div>
      </header>
      <div class="fam-settings">
        <nav class="fam-settings__nav" aria-label={t.settings.title}>
          {settingsGroups(translation).map((group) => (
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
              <span class="fam-banner__title">{t.settings.newSourceTypes}</span>
              <div class="fam-banner__body">
                <a href="/admin/source-types">{t.settings.lookAtThem}</a>
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
  const { t } = useTranslation();
  return (
    <dialog open class="fam-dialog" aria-labelledby={`${props.id}-title`} data-close={props.closeHref}>
      <div class="fam-dialog__header">
        <div class="fam-dialog__heading">
          {props.eyebrow ? <span class="fam-dialog__eyebrow">{props.eyebrow}</span> : null}
          <h2 id={`${props.id}-title`} class="fam-dialog__title">
            {props.title}
          </h2>
        </div>
        <a class="fam-button fam-button--quiet fam-dialog__close" href={props.closeHref} aria-label={t.common.close}>
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
  const { t } = useTranslation();
  return (
    <div class="fam-dialog__footer">
      {props.backHref ? (
        <a class="fam-button fam-button--quiet" href={props.backHref}>
          {t.common.back}
        </a>
      ) : null}
      <span class="fam-dialog__spacer"></span>
      <a class="fam-button fam-button--quiet" href={props.closeHref}>
        {t.common.cancel}
      </a>
      <button type="submit" class="fam-button fam-button--primary">
        {props.submit}
      </button>
    </div>
  );
}

/** An entry that opens in place for editing: its row as the summary, its form below. */
function EditableEntry(props: { lead?: Child; name: Child; meta?: Child; open?: boolean; children: Child }) {
  const { t } = useTranslation();
  return (
    <details class="fam-edit" open={props.open}>
      <summary class="fam-edit__summary">
        {props.lead}
        <span class="fam-entry__main">
          <span class="fam-entry__name">{props.name}</span>
          {props.meta ? <span class="fam-entry__meta">{props.meta}</span> : null}
        </span>
        <span class="fam-button fam-button--quiet fam-edit__toggle" aria-hidden="true">
          <span class="fam-edit__when-closed">{t.common.edit}</span>
          <span class="fam-edit__when-open">{t.common.close}</span>
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
  const { t } = useTranslation();
  const dialog = adding ? (
    <Dialog id="add-admin" eyebrow={t.admins.eyebrow} title={t.admins.dialogTitle} closeHref="/admin/admins">
      <form method="post" action="/admin/admins" class="fam-dialog__form">
        <Problem message={adding.problem} />
        <div class="fam-field">
          <label for="email">{t.common.email}</label>
          <input id="email" name="email" type="email" required autofocus value={adding.email} />
        </div>
        <div class="fam-field">
          <label for="password">{t.common.password}</label>
          <input id="password" name="password" type="password" required minlength={minimumPasswordLength} autocomplete="new-password" />
          <small>{t.admins.passwordHint}</small>
        </div>
        <DialogFooter closeHref="/admin/admins" submit={t.admins.add} />
      </form>
    </Dialog>
  ) : undefined;
  return (
    <AdminLayout title={t.admins.title} admin={props.admin} current="admins" dialog={dialog}>
      <SectionHeader
        title={t.admins.title}
        description={t.admins.description}
        action={addButton("/admin/admins/new", t.admins.add)}
      />
      <Problem message={props.problem} />
      <ul class="fam-panel fam-entries">
        {props.admins.map((other) =>
          other.id === props.admin.id ? (
            <li class="fam-entry">
              <span class="fam-entry__main">
                <span class="fam-entry__name">{other.email}</span>
                <span class="fam-entry__meta">{t.admins.you}</span>
              </span>
            </li>
          ) : (
            <li>
              <EditableEntry name={other.email} meta={t.admins.admin}>
                <form method="post" action={`/admin/admins/${other.id}/password`}>
                  <div class="fam-field">
                    <label for={`password-${other.id}`}>{t.admins.newPassword}</label>
                    <input id={`password-${other.id}`} name="password" type="password" required minlength={minimumPasswordLength} autocomplete="new-password" />
                  </div>
                  <button type="submit" class="fam-button fam-button--secondary">
                    {t.admins.resetPassword}
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

/** The kit as a text file to download. */
export function recoveryKitText(kit: RecoveryKit, t: Catalogue): string {
  const { fileTitle, masterKeyLine, purpose } = t.recoveryKit;
  return [fileTitle, "", masterKeyLine, kit.masterKey, "", ...purpose, ""].join("\n");
}

export function RecoveryKitPage(props: {
  admin: SignedInAdmin;
  kit: RecoveryKit;
  confirmed: boolean;
  problem?: string | undefined;
}) {
  const { t } = useTranslation();
  const k = t.recoveryKit;
  const actions = (
    <p class="fam-actions">
      <button
        type="button"
        class="fam-button fam-button--secondary"
        onclick="for (const kit of document.querySelectorAll('details.fam-reveal')) kit.open = true; window.print()"
      >
        {k.print}
      </button>
      <a href="/admin/recovery-kit/download">{k.download}</a>
    </p>
  );
  return (
    <AdminLayout title={k.title} admin={props.admin} current="recovery-kit">
      <SectionHeader title={k.title} description={k.description} />
      {props.confirmed ? (
        <>
          <div class="fam-banner fam-banner--success" role="status">
            <span class="fam-banner__glyph" aria-hidden="true">
              ✓
            </span>
            <span class="fam-banner__title">{k.saved}</span>
            <div class="fam-banner__body">{k.savedBody}</div>
          </div>
          <div class="fam-panel fam-panel--padded">
            <details class="fam-reveal">
              <summary class="fam-button fam-button--secondary">
                <span class="fam-edit__when-closed">{k.showMasterKey}</span>
                <span class="fam-edit__when-open">{k.hideMasterKey}</span>
              </summary>
              <p class="fam-secret">{props.kit.masterKey}</p>
            </details>
            {k.purpose.map((sentence) => (
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
            <span class="fam-banner__title">{k.saveFirst}</span>
            <div class="fam-banner__body">{k.saveFirstBody}</div>
          </div>
          <div class="fam-panel fam-panel--padded">
            <h2>{k.masterKey}</h2>
            <p class="fam-secret">{props.kit.masterKey}</p>
            {k.purpose.map((sentence) => (
              <p>{sentence}</p>
            ))}
            {actions}
            <form method="post" action="/admin/recovery-kit/confirm">
              <Problem message={props.problem} />
              <label>
                <input type="checkbox" name="saved" value="yes" required /> {k.confirm}
              </label>
              <button type="submit">{k.continue}</button>
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
  const { t } = useTranslation();
  const m = t.members;
  const dialog = adding ? (
    <Dialog id="add-member" eyebrow={m.eyebrow} title={m.dialogTitle} closeHref="/admin/family-members">
      <form method="post" action="/admin/family-members" enctype="multipart/form-data" class="fam-dialog__form">
        <Problem message={adding.problem} />
        <div class="fam-field">
          <label for="name">{m.name}</label>
          <input id="name" name="name" required autofocus maxlength={maximumNameLength} value={adding.name} />
          <small>{m.nameHint}</small>
        </div>
        <div class="fam-field">
          <label for="photo">{m.photo}</label>
          <input id="photo" name="photo" type="file" accept={photoTypes.join(",")} />
          <small>{m.photoHint}</small>
        </div>
        <DialogFooter closeHref="/admin/family-members" submit={m.add} />
      </form>
    </Dialog>
  ) : undefined;
  return (
    <AdminLayout title={m.title} admin={props.admin} current="members" dialog={dialog}>
      <SectionHeader
        title={m.title}
        description={m.description}
        action={addButton("/admin/family-members/new", m.add)}
      />
      <Problem message={props.problem} />
      {props.members.length === 0 ? (
        <p class="fam-empty">{m.none}</p>
      ) : (
        <ul class="fam-panel fam-entries">
          {props.members.map((member) => (
            <li>
              <EditableEntry lead={<Avatar member={member} />} name={member.name} meta={member.hasPhoto ? m.withPhoto : m.withInitial}>
                <form method="post" action={`/admin/family-members/${member.id}`} enctype="multipart/form-data">
                  <div class="fam-field">
                    <label for={`name-${member.id}`}>{m.name}</label>
                    <input id={`name-${member.id}`} name="name" required maxlength={maximumNameLength} value={member.name} />
                  </div>
                  <div class="fam-field">
                    <label for={`photo-${member.id}`}>{member.hasPhoto ? m.replacePhoto : m.photo}</label>
                    <input id={`photo-${member.id}`} name="photo" type="file" accept={photoTypes.join(",")} />
                  </div>
                  {member.hasPhoto ? (
                    <label>
                      <input type="checkbox" name="removePhoto" value="yes" /> {m.removePhoto}
                    </label>
                  ) : null}
                  <button type="submit">{t.common.save}</button>
                </form>
                <form method="post" action={`/admin/family-members/${member.id}/remove`}>
                  <button type="submit" class="fam-button fam-button--danger">
                    {m.remove(member.name)}
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
  const { t } = useTranslation();
  const v = t.views;
  const dialog = creating ? (
    <Dialog id="create-view" eyebrow={v.eyebrow} title={v.dialogTitle} closeHref="/admin/views">
      <form method="post" action="/admin/views" class="fam-dialog__form">
        <Problem message={creating.problem} />
        <ViewSettingsFields members={props.members} idSuffix="new" />
        <DialogFooter closeHref="/admin/views" submit={v.create} />
      </form>
    </Dialog>
  ) : undefined;
  return (
    <AdminLayout title={v.title} admin={props.admin} current="views" dialog={dialog}>
      <SectionHeader title={v.title} description={v.description} action={addButton("/admin/views/new", v.create)} />
      <Problem message={props.problem} />
      {props.views.length === 0 ? (
        <p class="fam-empty">{v.none}</p>
      ) : (
        <ul class="fam-panel fam-entries">
          {props.views.map((view) => {
            const preselected = view.preselected.map(memberOf).filter((member) => member !== undefined);
            const names = preselected.length > 0 ? preselected.map((member) => member.name).join(", ") : null;
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
                  name={v.entry(names ?? v.everyone, view.horizonDays)}
                  meta={v.startsWith(names)}
                >
                  <form method="post" action={`/admin/views/${view.id}`}>
                    <ViewSettingsFields members={props.members} view={view} idSuffix={view.id} />
                    <button type="submit">{t.common.save}</button>
                  </form>
                  <form method="post" action={`/admin/views/${view.id}/remove`}>
                    <button type="submit" class="fam-button fam-button--danger">
                      {v.remove}
                    </button>
                  </form>
                </EditableEntry>
                <dl class="fam-entry__links">
                  <dt>{v.address}</dt>
                  <dd>
                    <a href={viewUrl(view.id)}>{viewUrl(view.id)}</a>
                  </dd>
                  <dt>{v.feed}</dt>
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
  const { t } = useTranslation();
  return (
    <>
      <fieldset>
        <legend>{t.views.preselected}</legend>
        <small>{t.views.preselectedHint}</small>
        {props.members.length === 0 ? <p>{t.views.noMembers}</p> : null}
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
        <label for={id("horizon")}>{t.views.horizon}</label>
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
        <small>{t.views.horizonHint}</small>
      </div>
    </>
  );
}

export function SourceTypesPage(props: {
  admin: SignedInAdmin;
  sourceTypes: SourceTypeSummary[];
  problem?: string;
}) {
  const { t, text } = useTranslation();
  const s = t.sourceTypes;
  return (
    <AdminLayout title={s.title} admin={props.admin} current="source-types">
      <SectionHeader title={s.title} description={s.description} />
      <Problem message={props.problem} />
      {props.sourceTypes.length === 0 ? <p class="fam-empty">{s.none}</p> : null}
      <ul class="fam-panel fam-entries">
        {props.sourceTypes.map((type) => {
          const name = text(type.displayName);
          return (
            <li class="fam-entry fam-entry--wrap">
              <div class="fam-entry__main">
                <h2 class="fam-entry__name">
                  {name} {type.isNew ? <span class="fam-tag">{s.newIn(type.firstSeenIn)}</span> : null}
                </h2>
                <p class="fam-entry__meta">{text(type.description)}</p>
                <p class="fam-entry__meta">
                  {s.version(type.version)}
                  {type.needsLlm ? s.needsLlm : null}
                </p>
                {type.notLoadable !== null ? <p class="fam-problem">{s.notLoadable(type.notLoadable)}</p> : null}
              </div>
              {type.enabled ? (
                <form method="post" action={`/admin/source-types/${type.id}/disable`} class="fam-entry__form">
                  <span class="fam-status fam-status--ok">{s.enabled}</span>
                  <button type="submit" class="fam-button fam-button--secondary">
                    {s.disable(name)}
                  </button>
                  <small>{s.disableHint}</small>
                </form>
              ) : type.notLoadable !== null ? null : (
                <form method="post" action={`/admin/source-types/${type.id}/enable`} class="fam-entry__form">
                  {type.riskNotice !== null ? (
                    <>
                      <p class="fam-problem">{text(type.riskNotice)}</p>
                      <label>
                        <input type="checkbox" name="riskAcknowledged" value="yes" required /> {s.acknowledgeRisk}
                      </label>
                    </>
                  ) : null}
                  <button type="submit">{s.enable(name)}</button>
                </form>
              )}
            </li>
          );
        })}
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
  const { t, text } = useTranslation();
  const s = t.sources;
  const sourceTypesLink = (label: string) => <a href="/admin/source-types">{label}</a>;
  const dialog =
    adding?.step === "choose" ? (
      <Dialog id="add-source" eyebrow={s.chooseEyebrow} title={s.chooseTitle} closeHref="/admin/sources">
        <div class="fam-dialog__form">
          <p class="fam-section-header__description">{s.chooseIntro}</p>
          <ul class="fam-options">
            {props.forms.map((form, index) => (
              <li>
                <a class="fam-option" href={`/admin/sources/new?type=${encodeURIComponent(form.sourceTypeId)}`} autofocus={index === 0}>
                  <span class="fam-option__label">{text(form.displayName)}</span>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M9 6l6 6-6 6"></path>
                  </svg>
                </a>
              </li>
            ))}
          </ul>
          <small>{s.missingOne(sourceTypesLink)}</small>
          <div class="fam-dialog__footer">
            <span class="fam-dialog__spacer"></span>
            <a class="fam-button fam-button--quiet" href="/admin/sources">
              {t.common.cancel}
            </a>
          </div>
        </div>
      </Dialog>
    ) : adding?.step === "form" ? (
      <Dialog
        id="add-source"
        eyebrow={props.forms.length > 1 ? s.formEyebrow : s.onlyFormEyebrow}
        title={text(adding.form.displayName)}
        closeHref="/admin/sources"
      >
        <form method="post" action="/admin/sources" class="fam-dialog__form">
          <Problem message={adding.problem} />
          <input type="hidden" name="sourceTypeId" value={adding.form.sourceTypeId} />
          <SourceFields form={adding.form} prefix={`new-${adding.form.sourceTypeId}`} {...(adding.entered ? { entered: adding.entered } : {})} autofocus />
          <DialogFooter
            closeHref="/admin/sources"
            submit={s.addType(text(adding.form.displayName))}
            {...(props.forms.length > 1 ? { backHref: "/admin/sources/new" } : {})}
          />
        </form>
      </Dialog>
    ) : undefined;
  return (
    <AdminLayout title={s.title} admin={props.admin} current="sources" dialog={dialog}>
      <SectionHeader
        title={s.title}
        description={s.description}
        action={props.forms.length > 0 ? addButton("/admin/sources/new", s.add) : undefined}
      />
      <Problem message={props.problem} />
      {props.forms.length === 0 ? <p class="fam-empty">{s.noneEnabled(sourceTypesLink)}</p> : null}
      {props.sources.length === 0 ? null : (
        <ul class="fam-panel fam-entries">
          {props.sources.map((source) => {
            const form = formOf(source.sourceTypeId);
            const name = text(source.displayName);
            return (
              <li>
                <EditableEntry name={name} meta={sourceMeta(source, form, t)}>
                  {form ? (
                    <form method="post" action={`/admin/sources/${source.id}`}>
                      <SourceFields form={form} prefix={source.id} source={source} />
                      <button type="submit">{t.common.save}</button>
                    </form>
                  ) : (
                    <p class="fam-problem">{s.notRead}</p>
                  )}
                  <form method="post" action={`/admin/sources/${source.id}/shown`} class="fam-entry__form">
                    <input type="hidden" name="shown" value={source.shown ? "no" : "yes"} />
                    {source.shown ? (
                      <span class="fam-status fam-status--ok">{s.shown}</span>
                    ) : (
                      <span class="fam-status fam-status--waiting">{s.hidden}</span>
                    )}
                    <button type="submit" class="fam-button fam-button--secondary">
                      {source.shown ? s.hide : s.show}
                    </button>
                    <small>{s.hiddenHint}</small>
                  </form>
                  <form method="post" action={`/admin/sources/${source.id}/remove`}>
                    <button type="submit" class="fam-button fam-button--danger">
                      {s.remove(name)}
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

/** A Source's row: its plain settings, whether a secret is stored, how often it is checked, and whether it is hidden. */
function sourceMeta(source: SourceSummary, form: SourceForm | undefined, t: Catalogue): string {
  const plain = Object.values(source.plain)
    .filter((value) => (typeof value === "string" && value !== "") || typeof value === "number")
    .map(String);
  const secrets = source.storedSecrets.length > 0 ? [t.sources.secretStored] : [];
  const seconds = source.pollIntervalSeconds ?? form?.suggestedIntervalSeconds ?? null;
  const interval = seconds !== null ? [t.sources.every(seconds / 60)] : [];
  const hidden = source.shown ? [] : [t.sources.hiddenMeta];
  return [...plain, ...secrets, ...interval, ...hidden].join(" · ");
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
  const { t, text } = useTranslation();
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
            <label for={id(field.key)}>{field.required ? text(field.label) : t.common.optional(text(field.label))}</label>
            {field.secret ? (
              <input
                id={id(field.key)}
                name={`secret.${field.key}`}
                type="password"
                autocomplete="off"
                autofocus={focus}
                required={field.required && !stored}
                placeholder={stored ? t.common.storedSecret : undefined}
              />
            ) : (
              <input id={id(field.key)} name={`plain.${field.key}`} autofocus={focus} required={field.required} value={plainValue(field.key)} />
            )}
            {field.description ? <small>{text(field.description)}</small> : null}
          </div>
        );
      })}
      {form.suggestedIntervalSeconds !== null ? (
        <div class="fam-field">
          <label for={id("interval")}>{t.sources.interval}</label>
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
          <small>{t.sources.intervalHint(form.suggestedIntervalSeconds / 60)}</small>
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
  const { t } = useTranslation();
  const l = t.llm;
  return (
    <AdminLayout title={l.title} admin={props.admin} current="llm">
      <SectionHeader title={l.title} description={l.description} />
      {endpoint ? (
        <p class={endpoint.local ? "fam-callout fam-callout--ok" : "fam-callout"}>
          {l.readBy(<strong>{endpoint.model}</strong>, endpoint.baseUrl, endpoint.local)}
        </p>
      ) : (
        <p class="fam-callout">{l.none}</p>
      )}
      <Problem message={props.problem} />
      <form method="post" action="/admin/llm" class="fam-form-wide">
        <div class="fam-field">
          <label for="baseUrl">{l.baseUrl}</label>
          <input id="baseUrl" name="baseUrl" type="url" required value={shown?.baseUrl} />
          <small>{l.baseUrlHint}</small>
        </div>
        <div class="fam-field">
          <label for="model">{l.model}</label>
          <input id="model" name="model" required value={shown?.model} />
        </div>
        <div class="fam-field">
          <label for="apiKey">{l.apiKey}</label>
          <input
            id="apiKey"
            name="apiKey"
            type="password"
            autocomplete="off"
            placeholder={endpoint?.hasApiKey ? t.common.storedSecret : undefined}
          />
        </div>
        {endpoint?.hasApiKey ? (
          <label>
            <input type="checkbox" name="removeApiKey" value="yes" /> {l.removeApiKey}
          </label>
        ) : null}
        <label>
          <input type="checkbox" name="vision" value="yes" checked={shown?.vision} /> {l.vision}
        </label>
        <label>
          <input type="checkbox" name="thirdPartiesAcknowledged" value="yes" /> {l.thirdParties}
        </label>
        <button type="submit">{t.common.save}</button>
      </form>
    </AdminLayout>
  );
}

/** OCR languages in Tesseract's notation, as the forms post them: `deu+eng`. */
const ocrList = (languages: OcrLanguage[]) => languages.join("+");

/** A form that saves the OCR languages as they would be after its one button. */
function OcrLanguagesButton(props: { languages: OcrLanguage[]; label: string; quiet?: boolean }) {
  return (
    <form method="post" action="/admin/language/ocr" class="fam-entry__form">
      <input type="hidden" name="ocrLanguages" value={ocrList(props.languages)} />
      <button type="submit" class={`fam-button ${props.quiet ? "fam-button--quiet" : "fam-button--secondary"}`}>
        {props.label}
      </button>
    </form>
  );
}

/** Downloads one language's model. */
function DownloadButton(props: { language: OcrLanguage }) {
  const { t, ocrLanguageName } = useTranslation();
  return (
    <form method="post" action="/admin/language/models" class="fam-entry__form">
      <input type="hidden" name="language" value={props.language} />
      <button type="submit" class="fam-button fam-button--secondary">
        {t.language.downloadLanguage(ocrLanguageName(props.language))}
      </button>
    </form>
  );
}

export function LanguagePage(props: { admin: SignedInAdmin; languages: LanguageSettings; problem?: string }) {
  const { languages } = props;
  const { t, locale, ocrLanguageName } = useTranslation();
  const l = t.language;
  const byName = (a: OcrLanguage, b: OcrLanguage) => ocrLanguageName(a).localeCompare(ocrLanguageName(b), locale);
  const selected = languages.ocrLanguages.map((ocr) => ocr.language);
  const addable = languages.models.filter((model) => !model.selected).map((model) => model.language).sort(byName);
  const without = (language: OcrLanguage) => selected.filter((other) => other !== language);
  const movedUp = (index: number) => selected.toSpliced(index - 1, 2, ...selected.slice(index - 1, index + 1).reverse());
  return (
    <AdminLayout title={l.title} admin={props.admin} current="language">
      <SectionHeader title={l.title} description={l.description} />
      <Problem message={props.problem} />
      <h2>{l.familyLanguage}</h2>
      <form method="post" action="/admin/language" class="fam-form-wide">
        <div class="fam-field">
          <label for="language">{l.familyLanguage}</label>
          <select id="language" name="language">
            <FamilyLanguageOptions selected={languages.language} />
          </select>
          <small>{l.familyLanguageHint}</small>
        </div>
        <button type="submit">{t.common.save}</button>
      </form>

      <h2>{l.ocrLanguages}</h2>
      <p>{l.ocrIntro}</p>
      <ul class="fam-panel fam-entries">
        {languages.ocrLanguages.map((ocr, index) => (
          <li class="fam-entry fam-entry--wrap">
            <span class="fam-entry__main">
              <span class="fam-entry__name">{ocrLanguageName(ocr.language)}</span>
              {ocr.installed ? (
                <span class="fam-entry__meta">{l.tried(index + 1)}</span>
              ) : (
                <span class="fam-status fam-status--waiting">{l.notInstalled}</span>
              )}
            </span>
            {ocr.installed ? null : <DownloadButton language={ocr.language} />}
            {index > 0 ? <OcrLanguagesButton languages={movedUp(index)} label={l.moveUp} /> : null}
            {selected.length > 1 ? <OcrLanguagesButton languages={without(ocr.language)} label={l.remove} quiet /> : null}
          </li>
        ))}
      </ul>
      {languages.ocrLanguages.some((ocr) => !ocr.installed) ? (
        <p class="fam-problem">{l.missingModel}</p>
      ) : null}
      {addable.length > 0 ? (
        <form method="post" action="/admin/language/ocr" class="fam-form-wide">
          <div class="fam-field">
            <label for="add-ocr">{l.addOcrLanguage}</label>
            <select id="add-ocr" name="ocrLanguages">
              {addable.map((language) => (
                <option value={ocrList([...selected, language])}>{ocrLanguageName(language)}</option>
              ))}
            </select>
          </div>
          <button type="submit" class="fam-button fam-button--secondary">
            {l.add}
          </button>
        </form>
      ) : null}

      <h2>{l.models}</h2>
      <p>{l.modelsIntro((code) => <code>{code}</code>)}</p>
      <ul class="fam-panel fam-entries">
        {languages.models.map((model) => (
          <li class="fam-entry fam-entry--wrap">
            <span class="fam-entry__main">
              <span class="fam-entry__name">{ocrLanguageName(model.language)}</span>
              <span class="fam-entry__meta">
                {model.bundled ? l.bundled : l.downloaded}
                {model.selected ? l.usedForOcr : null}
              </span>
            </span>
            {model.bundled || model.selected ? null : (
              <form method="post" action={`/admin/language/models/${model.language}/remove`} class="fam-entry__form">
                <button type="submit" class="fam-button fam-button--danger">
                  {l.removeModel(ocrLanguageName(model.language))}
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {languages.downloadable.length > 0 ? (
        <form method="post" action="/admin/language/models" class="fam-form-wide">
          <div class="fam-field">
            <label for="download">{l.downloadModel}</label>
            <select id="download" name="language">
              {[...languages.downloadable].sort(byName).map((language) => (
                <option value={language}>{ocrLanguageName(language)}</option>
              ))}
            </select>
            <small>{l.downloadHint}</small>
          </div>
          <button type="submit" class="fam-button fam-button--secondary">
            {l.download}
          </button>
        </form>
      ) : null}
    </AdminLayout>
  );
}

export function MessagePage(props: { admin: SignedInAdmin; message: MessageDetails; timeZone: string }) {
  const { message } = props;
  const { t, locale } = useTranslation();
  const m = t.message;
  const sentAt = new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: props.timeZone,
  }).format(message.sentAt);
  return (
    <AdminLayout title={m.title} admin={props.admin} current={null}>
      <SectionHeader title={m.title} description={m.description} />
      <dl>
        <dt>{m.sent}</dt>
        <dd>{sentAt}</dd>
        {Object.entries(message.attributes).map(([key, value]) => (
          <>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </>
        ))}
      </dl>
      {message.text === null ? <p>{m.deleted}</p> : <pre class="fam-message">{message.text}</pre>}
      {message.attachments.length > 0 ? (
        <>
          <h2>{m.attachments}</h2>
          <ul>
            {message.attachments.map((attachment) => (
              <li>
                {attachment.filename} {m.attachment(attachment.contentType, Math.ceil(attachment.size / 1024))}
                {attachment.conversionProblem !== null ? (
                  <p class="fam-problem">{m.unreadable(attachment.conversionProblem)}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </AdminLayout>
  );
}
