import {
  pollIntervalRange,
  type AdminSummary,
  type AttributionRuleSummary,
  type CatalogueSummary,
  type FamilyMemberSummary,
  type LanguageSettings,
  type LlmEndpointSummary,
  type MessageDetails,
  type PlainConfig,
  type RecoveryKit,
  type RuleForm,
  type RuleTarget,
  type SetupProgress,
  type SourceForm,
  type SourceHealth,
  type SourceSummary,
  type SourceTypeSummary,
  type ViewSummary,
} from "@family-agenda/application";
import {
  defaultHorizonDays,
  familyLanguages,
  horizonDaysRange,
  maximumAttributeValueLength,
  maximumNameLength,
  minimumPasswordLength,
  photoTypes,
  silentAfterMs,
  type FamilyLanguage,
  type MultilingualText,
  type OcrLanguage,
} from "@family-agenda/domain";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
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
  /** How many Sources are Failing, which the whole Admin area shows a banner for. */
  failingSources: number;
  rules: number;
  llm: { model: string; local: boolean } | null;
  admins: number;
  kitSaved: boolean;
  /** The Family Language, the OCR languages, and whether one of their models is missing. */
  language: { family: FamilyLanguage; ocr: OcrLanguage[]; missing: boolean };
};

/** The Admin a page is shown to, whether the new-Source-Types banner shows, and the settings list. */
export type SignedInAdmin = AdminSummary & { newSourceTypes: boolean; settings: SettingsSummary };

type SectionId =
  | "members"
  | "views"
  | "language"
  | "sources"
  | "attribution"
  | "llm"
  | "admins"
  | "recovery-kit";

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
          summary: ({ settings, newSourceTypes }) =>
            settings.failingSources > 0
              ? { text: s.failing(settings.failingSources), tone: "attention" }
              : newSourceTypes
                ? { text: s.newOnes, tone: "attention" }
                : { text: settings.sources > 0 ? s.sources(settings.sources) : s.noneYet },
        },
        {
          id: "attribution",
          href: "/admin/attribution-rules",
          label: t.attribution.title,
          summary: ({ settings }) => ({ text: settings.rules > 0 ? s.rules(settings.rules) : s.noRules }),
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
    attribution: (
      <>
        <circle cx="5.5" cy="12" r="2.5"></circle>
        <path d="M8 12h6M11.5 9l3 3-3 3"></path>
        <circle cx="19" cy="9" r="2.5"></circle>
        <path d="M15.5 18c.6-2.2 1.9-3.5 3.5-3.5s2.9 1.3 3.5 3.5"></path>
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
          {admin.newSourceTypes && current !== "sources" ? (
            <div class="fam-banner fam-banner--attention" role="status">
              <span class="fam-banner__glyph" aria-hidden="true">
                !
              </span>
              <span class="fam-banner__title">{t.settings.newSourceTypes}</span>
              <div class="fam-banner__body">
                <a href="/admin/sources">{t.settings.lookAtThem}</a>
              </div>
            </div>
          ) : null}
          {admin.settings.failingSources > 0 ? (
            <div class="fam-banner fam-banner--problem" role="status">
              <span class="fam-banner__glyph" aria-hidden="true">
                !
              </span>
              <span class="fam-banner__title">{t.settings.failingSource}</span>
              <div class="fam-banner__body">
                {t.settings.failingSourceBody}
                {current !== "sources" ? (
                  <>
                    {" "}
                    <a href="/admin/sources">{t.settings.lookAtSources}</a>
                  </>
                ) : null}
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

/** A section's heading with its status, what it is for, and its one action. */
function SectionHeader(props: { title: string; status?: Child; description?: Child; action?: Child }) {
  const title = <h1 class="fam-section-header__title">{props.title}</h1>;
  return (
    <header class="fam-section-header">
      <div class="fam-section-header__text">
        {props.status ? (
          <div class="fam-section-header__heading">
            {title}
            {props.status}
          </div>
        ) : (
          title
        )}
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
function EditableEntry(props: { lead?: Child; name: Child; meta?: Child; action?: Child; open?: boolean; children: Child }) {
  const { t } = useTranslation();
  return (
    <details class="fam-edit" open={props.open}>
      <summary class="fam-edit__summary">
        {props.lead}
        <span class="fam-entry__main">
          <span class="fam-entry__name">{props.name}</span>
          {props.meta ? <span class="fam-entry__meta">{props.meta}</span> : null}
        </span>
        {props.action}
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

/** Where a Source Type's page is: its Sources, its catalogue, and enabling or disabling it. */
export const sourceTypeHref = (id: string) => `/admin/source-types/${encodeURIComponent(id)}`;
export const sourceHref = (id: string) => `/admin/sources/${encodeURIComponent(id)}`;

/**
 * The Sources: a card for each installed Source Type, and for each one no longer installed that
 * still has Sources, each leading to its page.
 */
export function SourcesPage(props: { admin: SignedInAdmin; sourceTypes: SourceTypeSummary[]; sources: SourceSummary[] }) {
  const { t, text } = useTranslation();
  const s = t.sources;
  const sourcesOf = (id: string) => props.sources.filter((source) => source.sourceTypeId === id);
  const installed = new Set<string>(props.sourceTypes.map((type) => type.id));
  const leftBehind = [
    ...new Map(props.sources.filter((source) => !installed.has(source.sourceTypeId)).map((source) => [source.sourceTypeId, source])).values(),
  ];
  return (
    <AdminLayout title={s.title} admin={props.admin} current="sources">
      <SectionHeader title={s.title} description={s.description} />
      {props.sourceTypes.length === 0 && leftBehind.length === 0 ? <p class="fam-empty">{s.none}</p> : null}
      <ul class="fam-type-cards">
        {props.sourceTypes.map((type) => (
          <li>
            <a class={type.enabled ? "fam-type-card" : "fam-type-card fam-type-card--off"} href={sourceTypeHref(type.id)}>
              <span class="fam-type-card__name">
                {text(type.displayName)}
                {type.isNew ? <span class="fam-tag">{t.sourceTypes.newIn(type.firstSeenIn)}</span> : null}
              </span>
              <span class="fam-type-card__description">{text(type.description)}</span>
              {type.notLoadable !== null ? (
                <span class="fam-status fam-status--problem">{s.cannotLoad}</span>
              ) : type.enabled ? (
                <SourcesSummary sources={sourcesOf(type.id)} />
              ) : (
                <span class="fam-status fam-status--waiting">{s.notEnabled}</span>
              )}
            </a>
          </li>
        ))}
        {leftBehind.map((source) => (
          <li>
            <a class="fam-type-card" href={sourceTypeHref(source.sourceTypeId)}>
              <span class="fam-type-card__name">{text(source.displayName)}</span>
              <span class="fam-type-card__description">{s.notInstalled}</span>
              <SourcesSummary sources={sourcesOf(source.sourceTypeId)} />
            </a>
          </li>
        ))}
      </ul>
    </AdminLayout>
  );
}

/** How many Sources a Source Type has, and how many of them need an Admin. */
function SourcesSummary(props: { sources: SourceSummary[] }) {
  const { t } = useTranslation();
  const s = t.sources;
  const { length } = props.sources;
  const failing = props.sources.filter((source) => source.health.status === "failing").length;
  const silent = props.sources.filter((source) => source.health.status === "silent").length;
  return (
    <span class="fam-type-card__summary">
      <span>{length > 0 ? s.count(length) : s.noSources}</span>
      {failing > 0 ? (
        <span class="fam-status fam-status--problem">{s.failingCount(failing)}</span>
      ) : silent > 0 ? (
        <span class="fam-status fam-status--waiting">{s.silentCount(silent)}</span>
      ) : length > 0 ? (
        <span class="fam-status fam-status--ok">{s.allOk}</span>
      ) : null}
    </span>
  );
}

/** A Source being added: its Source Type's form, filled in again with what was entered when refused. */
export type SourceAdding = { form: SourceForm; entered?: { plain: Record<string, string>; interval: string }; problem?: string };

/** What a live setup step of a Source shows now, with its QR code drawn as SVG. */
export type LiveStep = { sourceId: string; stepId: string; progress: SetupProgress; qrSvg: string | null };

/**
 * A Source Type's page: its switch, its Sources, and the entries of its catalogue such as its
 * Messengers with their accounts. Adding and setting up a Source open in a
 * dialog over it; a Source opens on a page of its own.
 */
export function SourceTypePage(props: {
  admin: SignedInAdmin;
  sourceTypeId: string;
  /** Null once its plugin is no longer installed, for the Sources it left behind. */
  sourceType: SourceTypeSummary | null;
  displayName: MultilingualText;
  /** Its Sources. */
  sources: SourceSummary[];
  /** The form of its Sources, while it is enabled and can be loaded. */
  form: SourceForm | undefined;
  catalogue: CatalogueSummary | undefined;
  /** The IANA time zone the Family lives in, which times are shown in. */
  timeZone: string;
  problem?: string;
  adding?: SourceAdding;
  /** The Source just added, whose live setup steps an Admin goes through now. */
  settingUp?: SourceSummary;
  /** What the live setup steps of the Source being set up show. */
  liveSteps?: LiveStep[];
}) {
  const { sourceType, form, adding } = props;
  const { t, text } = useTranslation();
  const s = t.sources;
  const types = t.sourceTypes;
  const href = sourceTypeHref(props.sourceTypeId);
  const name = text(props.displayName);
  const added = adding ? addedEntry(adding) : undefined;
  const dialog = adding ? (
    <Dialog id="add-source" eyebrow={s.addEyebrow} title={text(added?.displayName ?? adding.form.displayName)} closeHref={href}>
      <form method="post" action="/admin/sources" class="fam-dialog__form">
        <Problem message={adding.problem} />
        <input type="hidden" name="sourceTypeId" value={adding.form.sourceTypeId} />
        <SetupSteps form={adding.form} />
        <SourceFields form={adding.form} prefix={`new-${adding.form.sourceTypeId}`} {...(adding.entered ? { entered: adding.entered } : {})} autofocus />
        <DialogFooter closeHref={href} submit={added ? s.addAccount : s.addType(text(adding.form.displayName))} />
      </form>
    </Dialog>
  ) : props.settingUp && form ? (
    <Dialog id="set-up-source" eyebrow={s.setupEyebrow} title={text(props.settingUp.displayName)} closeHref={href}>
      <div class="fam-dialog__form">
        <SetupSteps form={form} liveSteps={props.liveSteps ?? []} />
        <div class="fam-dialog__footer">
          <span class="fam-dialog__spacer"></span>
          <a class="fam-button fam-button--primary" href={href}>
            {s.finish}
          </a>
        </div>
      </div>
    </Dialog>
  ) : undefined;
  // A Source using a listed catalogue entry, such as a Messenger's account, is listed with that entry.
  const configKey = sourceType?.enabled ? form?.catalogue?.configKey : undefined;
  const catalogue = configKey !== undefined && props.catalogue && props.catalogue.entries.length > 0 ? props.catalogue : undefined;
  const entryIds = new Set(catalogue?.entries.map((entry) => entry.id));
  const listed = props.sources.filter((source) => configKey === undefined || !entryIds.has(String(source.plain[configKey])));
  const status = sourceType && sourceType.notLoadable !== null ? <span class="fam-chip fam-chip--problem">{s.cannotLoad}</span> : undefined;
  const switchable = sourceType && sourceType.notLoadable === null ? sourceType : undefined;
  return (
    <AdminLayout title={name} admin={props.admin} current="sources" dialog={dialog}>
      <nav class="fam-breadcrumb" aria-label={s.breadcrumb}>
        <a href="/admin/sources">{s.title}</a> <span aria-hidden="true">›</span> <span aria-current="page">{name}</span>
      </nav>
      <SectionHeader
        title={name}
        status={status}
        description={sourceType ? text(sourceType.description) : s.notInstalled}
      />
      {sourceType ? (
        <p class="fam-entry__meta">
          {types.version(sourceType.version)}
          {sourceType.needsLlm ? types.needsLlm : null}
        </p>
      ) : null}
      {sourceType && sourceType.notLoadable !== null ? <p class="fam-problem">{types.notLoadable(sourceType.notLoadable)}</p> : null}
      <Problem message={props.problem} />
      {switchable ? (
        <section class="fam-sheet">
          <SettingRow
            title={<span class="fam-row__label">{types.use(name)}</span>}
            hints={[switchable.enabled && props.sources.length > 0 ? types.lockedHint(name) : null]}
            control={
              <EnableSwitch
                id="enable-source-type"
                name={name}
                action={href}
                enabled={switchable.enabled}
                locked={switchable.enabled && props.sources.length > 0}
              />
            }
          />
          {!switchable.enabled && switchable.riskNotice !== null ? <RiskNotice form="enable-source-type" notice={switchable.riskNotice} /> : null}
        </section>
      ) : null}
      {catalogue && configKey !== undefined ? (
        <CatalogueEntries catalogue={catalogue} form={form} configKey={configKey} sources={props.sources} timeZone={props.timeZone} />
      ) : null}
      {(sourceType?.enabled && !catalogue) || listed.length > 0 ? (
        <section class="fam-sheet">
          <Group title={s.title} level={2} intro={s.sourcesIntro}>
            <SourceRows sources={listed} form={form} timeZone={props.timeZone} empty={s.noSources} />
            {sourceType?.enabled && form && !form.catalogue ? (
              <div class="fam-group__actions">
                <a class="fam-button fam-button--quiet fam-button--add" href={`/admin/sources/new?type=${encodeURIComponent(props.sourceTypeId)}`}>
                  {s.addType(name)}
                </a>
              </div>
            ) : null}
          </Group>
        </section>
      ) : null}
    </AdminLayout>
  );
}

/**
 * A Source's page: its name, settings and polling interval, whether it shows on the timeline, and
 * removing it. Fixing it opens in a dialog over it.
 */
export function SourcePage(props: {
  admin: SignedInAdmin;
  source: SourceSummary;
  /** The form of its Source Type, while that is enabled and can be loaded. */
  form: SourceForm | undefined;
  /** The IANA time zone the Family lives in, which times are shown in. */
  timeZone: string;
  problem?: string;
  /** Whether its Fix button was pressed: its form then opens in the dialog adding a Source uses. */
  fixing?: boolean;
  /** What the live setup steps of the Source being fixed show. */
  liveSteps?: LiveStep[];
}) {
  const { source, form } = props;
  const translation = useTranslation();
  const { t, text } = translation;
  const s = t.sources;
  const href = sourceHref(source.id);
  const { name, derived } = sourceLabel(source, form, translation);
  // A Source using a catalogue entry is polled at the entry's interval, set with the entry.
  const suggestedSeconds = form && !form.catalogue ? form.suggestedIntervalSeconds : null;
  const editable = form !== undefined && (form.fields.length > 0 || suggestedSeconds !== null);
  // The catalogue entry it uses, such as its Messenger, cannot change; it is named in the header.
  const entryKey = form?.catalogue?.configKey;
  const entry = entryKey !== undefined ? form?.catalogue?.entries.find((candidate) => candidate.id === source.plain[entryKey]) : undefined;
  const dialog =
    props.fixing && form ? <FixDialog source={source} form={form} closeHref={href} timeZone={props.timeZone} liveSteps={props.liveSteps ?? []} /> : undefined;
  return (
    <AdminLayout title={name} admin={props.admin} current="sources" dialog={dialog}>
      <nav class="fam-breadcrumb" aria-label={s.breadcrumb}>
        <a href="/admin/sources">{s.title}</a> <span aria-hidden="true">›</span>{" "}
        <a href={sourceTypeHref(source.sourceTypeId)}>{text(source.displayName)}</a> <span aria-hidden="true">›</span>{" "}
        <span aria-current="page">{name}</span>
      </nav>
      <SectionHeader
        title={name}
        status={<HealthStatus health={source.health} chip />}
        description={
          <span class="fam-health">
            {entry ? <span>{text(entry.displayName)} ·</span> : null}
            <HealthDetails health={source.health} timeZone={props.timeZone} />
          </span>
        }
        action={
          source.health.status === "failing" && form ? (
            <a class="fam-button fam-button--secondary" href={`${href}/fix`}>
              {s.fix}
            </a>
          ) : undefined
        }
      />
      <Problem message={props.problem} />
      <section class="fam-sheet">
        {!form ? <p class="fam-problem">{s.notRead}</p> : null}
        {/* One form for all it is set by; with nothing else editable, only its name. */}
        <form method="post" action={editable ? href : `${href}/name`} class="fam-sheet__form">
          <Group title={s.settings} level={2}>
            <div class="fam-group__fields">
              <div class="fam-field">
                <label for={`${source.id}-name`}>{s.name}</label>
                <input id={`${source.id}-name`} name="name" maxlength={maximumNameLength} placeholder={derived} value={source.name ?? undefined} />
                <small>{s.nameHint(derived)}</small>
              </div>
              {form && editable ? <SourceFields form={form} prefix={source.id} source={source} omitFixed /> : null}
            </div>
            <div class="fam-group__actions">
              <button type="submit" class="fam-button fam-button--primary">
                {t.common.save}
              </button>
            </div>
          </Group>
        </form>
        <Group title={s.timeline} level={2}>
          <ul class="fam-rows">
            <li class="fam-row">
              <span class="fam-row__main">
                <span class="fam-row__label" id={`${source.id}-shown`}>
                  {s.show}
                </span>
                <span class="fam-row__hint">{s.hiddenHint}</span>
              </span>
              <form method="post" action={`${href}/shown`} class="fam-row__form">
                <input type="hidden" name="shown" value={source.shown ? "no" : "yes"} />
                <button
                  type="submit"
                  role="switch"
                  aria-checked={source.shown ? "true" : "false"}
                  aria-labelledby={`${source.id}-shown`}
                  class="fam-switch"
                ></button>
              </form>
            </li>
          </ul>
        </Group>
        <Group title={s.management} level={2}>
          <ul class="fam-rows">
            <li class="fam-row">
              <span class="fam-row__main">
                <span class="fam-row__label">{s.remove}</span>
                <span class="fam-row__hint">{s.removeHint}</span>
              </span>
              <form method="post" action={`${href}/remove`} class="fam-row__form">
                <button type="submit" class="fam-button fam-button--danger" aria-label={s.remove}>
                  {s.removeButton}
                </button>
              </form>
            </li>
          </ul>
        </Group>
      </section>
    </AdminLayout>
  );
}

/** A titled group of rows in a sheet, such as a Messenger's accounts; its heading at `level`. */
function Group(props: { title: string; level: 2 | 3 | 4; intro?: Child; children: Child }) {
  const Heading = `h${props.level}` as const;
  return (
    <section class="fam-group">
      <Heading class="fam-group__title">{props.title}</Heading>
      {props.intro ? <p class="fam-group__intro">{props.intro}</p> : null}
      {props.children}
    </section>
  );
}

const Chevron = () => (
  <svg
    class="fam-row__chevron"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M9 6l6 6-6 6"></path>
  </svg>
);

/** Sources as rows, each leading to its page, with `empty` while there are none. */
function SourceRows(props: { sources: SourceSummary[]; form: SourceForm | undefined; timeZone: string; empty: string }) {
  if (props.sources.length === 0) return <p class="fam-group__empty">{props.empty}</p>;
  return (
    <ul class="fam-rows">
      {props.sources.map((source) => (
        <SourceRow source={source} form={props.form} timeZone={props.timeZone} />
      ))}
    </ul>
  );
}

/** A Source's row: what tells it apart, its status, and a Fix button while it is Failing. */
function SourceRow(props: { source: SourceSummary; form: SourceForm | undefined; timeZone: string }) {
  const { source, form } = props;
  const translation = useTranslation();
  const s = translation.t.sources;
  const { name, meta } = sourceLabel(source, form, translation);
  return (
    <li class="fam-row fam-row--link">
      <a class="fam-row__link" href={sourceHref(source.id)}>
        <span class="fam-row__main">
          <span class="fam-row__label">
            {name}
            {source.shown ? null : <span class="fam-chip fam-chip--small">{s.hidden}</span>}
          </span>
          {meta !== "" ? <span class="fam-row__hint">{meta}</span> : null}
          {/* Its page tells when it was last read; its row only once something went wrong. */}
          {source.health.status !== "ok" || source.health.problem !== null ? (
            <span class="fam-row__hint fam-health">
              <HealthDetails health={source.health} timeZone={props.timeZone} />
            </span>
          ) : null}
        </span>
        <HealthStatus health={source.health} />
        <Chevron />
      </a>
      {source.health.status === "failing" && form ? (
        <a class="fam-button fam-button--secondary" href={`${sourceHref(source.id)}/fix`}>
          {s.fix}
        </a>
      ) : null}
    </li>
  );
}

/**
 * A setting as a list row: its title, hints below it such as why it is locked, and its control,
 * such as a switch, at the end. Hints that are null are left out.
 */
function SettingRow(props: { title: Child; hints?: (Child | null)[]; control: Child }) {
  return (
    <div class="fam-setting">
      <div class="fam-setting__text">
        {props.title}
        {(props.hints ?? []).map((hint) => (hint !== null ? <p class="fam-setting__hint">{hint}</p> : null))}
      </div>
      {props.control}
    </div>
  );
}

/**
 * Whether something an Admin enables on its own, a Source Type or a catalogue entry, is enabled,
 * as a switch posting to `<action>/enable` or `<action>/disable`. While something uses it, it is
 * `locked` on. One with a risk notice is enabled only once the `RiskNotice` tied to the switch's
 * form by its `id` is acknowledged.
 */
function EnableSwitch(props: { id: string; name: string; action: string; enabled: boolean; locked: boolean }) {
  const { t } = useTranslation();
  return (
    <form method="post" action={`${props.action}/${props.enabled ? "disable" : "enable"}`} id={props.id} class="fam-row__form">
      <button
        type="submit"
        role="switch"
        aria-checked={props.enabled ? "true" : "false"}
        aria-label={t.sourceTypes.enable(props.name)}
        disabled={props.locked}
        class="fam-switch"
      >
        {props.locked ? (
          <svg
            class="fam-switch__lock"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="5" y="11" width="14" height="10" rx="2"></rect>
            <path d="M8 11V7a4 4 0 0 1 8 0v4"></path>
          </svg>
        ) : null}
      </button>
    </form>
  );
}

/** A risk notice to acknowledge before enabling, its checkbox belonging to the switch's `form`. */
function RiskNotice(props: { form: string; notice: MultilingualText }) {
  const { t, text } = useTranslation();
  const s = t.sourceTypes;
  return (
    <div class="fam-risk">
      <p class="fam-risk__text">
        <span class="fam-risk__glyph" aria-hidden="true">
          !
        </span>
        <span>
          <strong>{s.riskTitle}:</strong> {text(props.notice)}
        </span>
      </p>
      <label>
        <input type="checkbox" name="riskAcknowledged" value="yes" form={props.form} required /> {s.acknowledgeRisk}
      </label>
    </div>
  );
}

/** A row setting a polling interval in minutes, empty for the plugin's suggestion. */
function IntervalRow(props: { id: string; value: string | undefined; suggestedSeconds: number; hint: string; save?: boolean }) {
  const { t } = useTranslation();
  return (
    <li class="fam-row">
      <span class="fam-row__main">
        <label for={props.id} class="fam-row__label">
          {t.sources.interval}
        </label>
        <span class="fam-row__hint">{props.hint}</span>
      </span>
      <IntervalInput id={props.id} value={props.value} suggestedSeconds={props.suggestedSeconds} />
      {props.save ? (
        <button type="submit" class="fam-button fam-button--quiet">
          {t.common.save}
        </button>
      ) : null}
    </li>
  );
}

function IntervalInput(props: { id: string; value: string | undefined; suggestedSeconds: number }) {
  const { t } = useTranslation();
  return (
    <span class="fam-unit">
      <input
        id={props.id}
        name="pollIntervalMinutes"
        type="number"
        min={pollIntervalRange.minSeconds / 60}
        max={pollIntervalRange.maxSeconds / 60}
        placeholder={String(props.suggestedSeconds / 60)}
        value={props.value}
      />
      <span>{t.sources.intervalUnit}</span>
    </span>
  );
}

/**
 * Adding a Source at a catalogue entry, such as an account at its Messenger. With nothing else to
 * fill in before its setup, such as only chats to choose once linked, it starts the setup at once;
 * otherwise it opens the form with the entry given.
 */
function AddAtEntry(props: { form: SourceForm; entryId: string; name: string }) {
  const { form, entryId } = props;
  const { t } = useTranslation();
  const s = t.sources;
  const configKey = form.catalogue?.configKey;
  const nothingToFill = form.fields.every((field) => field.key === configKey || field.choice);
  if (!nothingToFill) {
    return (
      <a
        class="fam-button fam-button--quiet fam-button--add"
        href={`/admin/sources/new?type=${encodeURIComponent(form.sourceTypeId)}&entry=${encodeURIComponent(entryId)}`}
        aria-label={s.addAccountOf(props.name)}
      >
        {s.addAccount}
      </a>
    );
  }
  return (
    <form method="post" action="/admin/sources" class="fam-entry__form">
      <input type="hidden" name="sourceTypeId" value={form.sourceTypeId} />
      <input type="hidden" name={`plain.${configKey}`} value={entryId} />
      <button type="submit" class="fam-button fam-button--quiet fam-button--add" aria-label={s.addAccountOf(props.name)}>
        {s.addAccount}
      </button>
    </form>
  );
}

/** The catalogue entry a Source being added uses, such as its Messenger, once it is chosen. */
function addedEntry(adding: SourceAdding) {
  const { catalogue } = adding.form;
  const chosen = catalogue ? adding.entered?.plain[catalogue.configKey] : undefined;
  return catalogue?.entries.find((entry) => entry.id === chosen);
}

/** The dialog a Fix button opens: the form adding a Source uses, filled in with the Source's settings. */
function FixDialog(props: { source: SourceSummary; form: SourceForm; closeHref: string; timeZone: string; liveSteps: LiveStep[] }) {
  const { source, form } = props;
  const { t, text } = useTranslation();
  const s = t.sources;
  return (
    <Dialog id="fix-source" eyebrow={s.fixEyebrow} title={text(source.displayName)} closeHref={props.closeHref}>
      <form method="post" action={`/admin/sources/${source.id}`} class="fam-dialog__form">
        <HealthLine health={source.health} timeZone={props.timeZone} />
        <SetupSteps form={form} liveSteps={props.liveSteps} />
        <SourceFields form={form} prefix={`fix-${source.id}`} source={source} autofocus />
        <DialogFooter closeHref={props.closeHref} submit={s.saveAndRead} />
      </form>
    </Dialog>
  );
}

/**
 * The entries an Admin enables within a Source Type, such as its Messengers, a sheet each with its
 * switch: once one is enabled, its accounts and the interval they are polled at.
 */
function CatalogueEntries(props: {
  catalogue: CatalogueSummary;
  form: SourceForm | undefined;
  /** The field naming the entry a Source uses. */
  configKey: string;
  sources: SourceSummary[];
  timeZone: string;
}) {
  const { catalogue, form } = props;
  const usable = new Set(form?.catalogue?.entries.map((entry) => entry.id));
  const { t, text } = useTranslation();
  const s = t.sourceTypes;
  const base = `${sourceTypeHref(catalogue.sourceTypeId)}/catalogue`;
  return (
    <section class="fam-type-section" aria-labelledby="catalogue-title">
      <h2 id="catalogue-title" class="fam-group__title">
        {text(catalogue.title)}
      </h2>
      <p class="fam-group__intro">{s.catalogueIntro}</p>
      <ul class="fam-sheets">
        {catalogue.entries.map((entry) => {
          const name = text(entry.displayName);
          const accounts = props.sources.filter((source) => source.plain[props.configKey] === entry.id);
          const suggestedSeconds = form && usable.has(entry.id) ? form.suggestedIntervalSeconds : null;
          return (
            <li class="fam-sheet">
              <SettingRow
                title={<h3 class="fam-sheet__title">{name}</h3>}
                hints={[text(entry.description), entry.enabled && accounts.length > 0 ? s.entryLockedHint(name) : null]}
                control={
                  entry.installed ? (
                    <EnableSwitch
                      id={`enable-${entry.id}`}
                      name={name}
                      action={`${base}/${entry.id}`}
                      enabled={entry.enabled}
                      locked={entry.enabled && accounts.length > 0}
                    />
                  ) : (
                    <span class="fam-chip">{s.notInstalled}</span>
                  )
                }
              />
              {entry.installed && !entry.enabled && entry.riskNotice !== null ? <RiskNotice form={`enable-${entry.id}`} notice={entry.riskNotice} /> : null}
              {entry.enabled ? (
                <>
                  <Group title={s.accounts} level={4}>
                    <SourceRows sources={accounts} form={form} timeZone={props.timeZone} empty={s.noAccounts} />
                    {form && usable.has(entry.id) ? (
                      <div class="fam-group__actions">
                        <AddAtEntry form={form} entryId={entry.id} name={name} />
                      </div>
                    ) : null}
                  </Group>
                  {suggestedSeconds != null ? (
                    <Group title={t.sources.polling} level={4}>
                      <form method="post" action={`${base}/${entry.id}/interval`} class="fam-sheet__form">
                        <ul class="fam-rows">
                          <IntervalRow
                            id={`interval-${entry.id}`}
                            value={entry.pollIntervalSeconds !== null ? String(entry.pollIntervalSeconds / 60) : undefined}
                            suggestedSeconds={suggestedSeconds}
                            hint={s.entryIntervalHint(name, suggestedSeconds / 60)}
                            save
                          />
                        </ul>
                      </form>
                    </Group>
                  ) : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The interactive steps a plugin declares for its Sources, such as pairing an account. A live
 * step of an existing Source shows its progress too, such as the QR code to scan.
 */
function SetupSteps(props: { form: SourceForm; liveSteps?: LiveStep[] }) {
  const { text } = useTranslation();
  if (props.form.setupSteps.length === 0) return null;
  return (
    <ol class="fam-setup-steps">
      {props.form.setupSteps.map((step) => {
        const live = props.liveSteps?.find((candidate) => candidate.stepId === step.id);
        return (
          <li>
            <strong>{text(step.title)}</strong> <span>{text(step.description)}</span>
            {live ? <LiveStepProgress step={live} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** How often a live setup step asks its plugin again while it waits. */
const liveStepPollSeconds = 3;

/**
 * What a live setup step shows now. While it waits, it asks again every few seconds and replaces
 * itself, so that a QR code that expires is replaced by the next one.
 */
export function LiveStepProgress(props: { step: LiveStep }) {
  const { sourceId, stepId, progress, qrSvg } = props.step;
  const { t, text } = useTranslation();
  const s = t.sources;
  if (progress.status === "waiting") {
    return (
      <div
        class="fam-live-step"
        hx-get={`/admin/sources/${sourceId}/setup/${encodeURIComponent(stepId)}`}
        hx-trigger={`load delay:${liveStepPollSeconds}s`}
        hx-swap="outerHTML"
        aria-live="polite"
      >
        {qrSvg !== null ? (
          <figure class="fam-qr" role="img" aria-label={s.qrCode}>
            {raw(qrSvg)}
          </figure>
        ) : null}
        <small>{progress.message !== null ? text(progress.message) : s.setupWaiting}</small>
      </div>
    );
  }
  if (progress.status === "done") {
    return (
      <div class="fam-live-step" aria-live="polite">
        <span class="fam-status fam-status--ok">{progress.message !== null ? text(progress.message) : s.setupDone}</span>
      </div>
    );
  }
  return (
    <div class="fam-live-step" aria-live="polite">
      <p class="fam-problem">{text(progress.message)}</p>
    </div>
  );
}

/** A Source's status, when it was last read successfully, and its last error. */
function HealthLine(props: { health: SourceHealth; timeZone: string }) {
  return (
    <span class="fam-health">
      <HealthStatus health={props.health} />
      <HealthDetails health={props.health} timeZone={props.timeZone} />
    </span>
  );
}

/** A Source's status as a word with a dot, or as a chip beside a heading. */
function HealthStatus(props: { health: SourceHealth; chip?: boolean }) {
  const { t } = useTranslation();
  const tone = { ok: "ok", failing: "problem", silent: "waiting" }[props.health.status];
  const kind = props.chip ? "fam-chip" : "fam-status";
  return <span class={`${kind} ${kind}--${tone}`}>{t.sources.status[props.health.status]}</span>;
}

/** When a Source was last read successfully, and its last error. */
function HealthDetails(props: { health: SourceHealth; timeZone: string }) {
  const { health } = props;
  const { t, locale } = useTranslation();
  const s = t.sources;
  const when = (date: Date) =>
    new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: props.timeZone,
    }).format(date);
  const { problem } = health;
  const problemText =
    problem === null
      ? null
      : problem.kind === "not-installed"
        ? s.notInstalled
        : problem.kind === "not-loadable"
          ? problem.reason === null
            ? s.cannotLoad
            : s.notLoadable(problem.reason)
          : s.lastError(problem.message);
  return (
    <>
      {health.status === "silent" ? <span>{s.silentHint(silentAfterMs / (24 * 60 * 60 * 1000))}</span> : null}
      <span>{health.lastSuccessAt ? s.lastRead(when(health.lastSuccessAt)) : s.notReadYet}</span>
      {problemText !== null ? <span class="fam-problem">{problemText}</span> : null}
    </>
  );
}

/** A Source's plain settings that tell it apart from others of its Source Type, such as its address. */
function plainValues(plain: PlainConfig, except?: string): string[] {
  return Object.entries(plain)
    .filter(([key, value]) => key !== except && ((typeof value === "string" && value !== "") || typeof value === "number"))
    .map(([, value]) => String(value));
}

/**
 * A Source's name and what else tells it apart, from what an Admin set: the name they gave it, else
 * the one `derived` from its settings, its first plain setting such as its address, else its
 * catalogue entry's name such as its Messenger's, else its Source Type's; its plain settings not
 * already its name, what it is set to read among its choices, and how often it is
 * checked. Values the plugin sets, such as an account id, and secrets are left out. Without its
 * form, its Source Type no longer loading, it shows its plain settings as they are.
 */
function sourceLabel(
  source: SourceSummary,
  form: SourceForm | undefined,
  translation: Translation,
): { name: string; meta: string; derived: string } {
  const { t, text } = translation;
  const configKey = form?.catalogue?.configKey;
  const fields = form?.fields.filter((field) => !field.secret && field.key !== configKey);
  const shown = (value: unknown): value is string | number => (typeof value === "string" && value !== "") || typeof value === "number";
  const [first, ...rest] = (fields ? fields.filter((field) => !field.choice).map((field) => source.plain[field.key]) : Object.values(source.plain))
    .filter(shown)
    .map(String);
  const entry = configKey !== undefined ? form?.catalogue?.entries.find((candidate) => candidate.id === source.plain[configKey]) : undefined;
  const derived = first ?? text(entry?.displayName ?? source.displayName);
  // Named by an Admin, its first setting, such as its address, still tells it apart.
  const name = source.name ?? derived;
  const shownFirst = source.name !== null && first !== undefined ? [first] : [];
  const chosen = (fields ?? [])
    .filter((field) => field.choice)
    .map((field) => {
      const stored = source.plain[field.key];
      const values = Array.isArray(stored) ? stored.filter((value) => typeof value === "string") : [];
      const labels = values.map((value) => source.choices[field.key]?.find((choice) => choice.value === value)?.label ?? value);
      return `${text(field.label)}: ${labels.length > 0 ? labels.join(", ") : t.sources.noneChosen}`;
    });
  // A Source using a catalogue entry is polled at the entry's interval, shown with the entry.
  const seconds = form?.catalogue ? null : (source.pollIntervalSeconds ?? form?.suggestedIntervalSeconds ?? null);
  const interval = seconds !== null ? [t.sources.every(seconds / 60)] : [];
  return { name, meta: [...shownFirst, ...rest, ...chosen, ...interval].join(" · "), derived };
}

/** The fields a plugin declares; a secret is never shown, only whether one is stored. */
function SourceFields(props: {
  form: SourceForm;
  prefix: string;
  source?: SourceSummary;
  entered?: { plain: Record<string, string>; interval: string };
  autofocus?: boolean;
  /** Leaves out the catalogue entry of an existing Source, which cannot change, such as its Messenger. */
  omitFixed?: boolean;
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
        if (form.catalogue?.configKey === field.key) {
          if (props.omitFixed && source) return null;
          return <CatalogueField field={field} form={form} id={id(field.key)} chosen={plainValue(field.key)} existing={source !== undefined} autofocus={focus} />;
        }
        if (field.choice) return <ChoiceField field={field} id={id(field.key)} source={source} />;
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
      {form.suggestedIntervalSeconds !== null && !form.catalogue ? (
        <div class="fam-field">
          <label for={id("interval")}>{t.sources.interval}</label>
          <IntervalInput id={id("interval")} value={interval} suggestedSeconds={form.suggestedIntervalSeconds} />
          <small>{t.sources.intervalHint(form.suggestedIntervalSeconds / 60)}</small>
        </div>
      ) : null}
    </>
  );
}

/**
 * The field naming the catalogue entry a Source uses, such as its Messenger: fixed once it exists,
 * given when it is added at its entry, and a choice among the enabled entries otherwise.
 */
function CatalogueField(props: {
  field: SourceForm["fields"][number];
  form: SourceForm;
  id: string;
  chosen: string | undefined;
  existing: boolean;
  autofocus: boolean;
}) {
  const { field, form, id, chosen } = props;
  const { t, text } = useTranslation();
  const entries = form.catalogue?.entries ?? [];
  const label = <label for={id}>{text(field.label)}</label>;
  const entry = entries.find((candidate) => candidate.id === chosen);
  // Added at its entry, the dialog is titled after it, so the field needs no showing.
  if (entry && !props.existing) return <input type="hidden" name={`plain.${field.key}`} value={entry.id} />;
  if (props.existing) {
    return (
      <div class="fam-field">
        {label}
        <input id={id} value={entry ? text(entry.displayName) : chosen} disabled />
      </div>
    );
  }
  return (
    <div class="fam-field">
      {label}
      {entries.length === 0 ? (
        <p class="fam-problem">{t.sources.noEntries((label) => <a href={sourceTypeHref(form.sourceTypeId)}>{label}</a>)}</p>
      ) : (
        <select id={id} name={`plain.${field.key}`} required autofocus={props.autofocus}>
          {entries.map((entry) => (
            <option value={entry.id} selected={entry.id === chosen}>
              {text(entry.displayName)}
            </option>
          ))}
        </select>
      )}
      {field.description ? <small>{text(field.description)}</small> : null}
    </div>
  );
}

/**
 * A choice among what the plugin offers for an existing Source, such as the chats to read: one
 * checkbox each, the chosen ones ticked, also those it no longer offers. A Source being added has
 * none to offer yet.
 */
function ChoiceField(props: { field: SourceForm["fields"][number]; id: string; source: SourceSummary | undefined }) {
  const { field, source } = props;
  const { t, text } = useTranslation();
  const label = field.required ? text(field.label) : t.common.optional(text(field.label));
  if (!source) {
    return (
      <div class="fam-field">
        <span class="fam-field__label">{label}</span>
        <small>{t.sources.choicesAfterSetup}</small>
      </div>
    );
  }
  const stored = source.plain[field.key];
  const chosen = Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : [];
  const offered = source.choices[field.key] ?? [];
  const options = [
    ...offered,
    ...chosen.filter((value) => !offered.some((choice) => choice.value === value)).map((value) => ({ value, label: value })),
  ];
  return (
    <fieldset class="fam-field" id={props.id}>
      <legend>{label}</legend>
      {/* Sent with nothing ticked too, so that unticking every box clears the choice. */}
      <input type="hidden" name={`choice.${field.key}`} value="" />
      {options.length === 0 ? <small>{t.sources.noChoices}</small> : null}
      {options.map((option) => (
        <label>
          <input type="checkbox" name={`choice.${field.key}`} value={option.value} checked={chosen.includes(option.value)} /> {option.label}
        </label>
      ))}
      {field.description ? <small>{text(field.description)}</small> : null}
    </fieldset>
  );
}

/**
 * What the rules page shows in its dialog: what a new rule can match on, or the form of a new rule
 * or of an existing one, with what was entered and why it was refused.
 */
export type RuleDialog =
  | { step: "choose" }
  | {
      step: "form";
      form: RuleForm;
      /** The rule being edited; none for a new one. */
      rule?: AttributionRuleSummary;
      entered?: { value: string; concerns: string[] };
      problem?: string;
    };

export function AttributionRulesPage(props: {
  admin: SignedInAdmin;
  rules: AttributionRuleSummary[];
  targets: RuleTarget[];
  members: FamilyMemberSummary[];
  dialog?: RuleDialog;
}) {
  const { dialog: shown } = props;
  const { t, text } = useTranslation();
  const a = t.attribution;
  const close = "/admin/attribution-rules";
  const sourceOf = (target: RuleTarget) =>
    [text(target.sourceName), ...(target.sourceTitle !== null ? [target.sourceTitle] : plainValues(target.sourcePlain))].join(" · ");
  const newHref = (target: RuleTarget) =>
    `/admin/attribution-rules/new?source=${encodeURIComponent(target.sourceId)}&attribute=${encodeURIComponent(target.attribute)}`;
  const dialog =
    shown?.step === "choose" ? (
      <Dialog id="add-rule" eyebrow={a.chooseEyebrow} title={a.chooseTitle} closeHref={close}>
        <div class="fam-dialog__form">
          <p class="fam-section-header__description">{a.chooseIntro}</p>
          <ul class="fam-options">
            {props.targets.map((target, index) => (
              <li>
                <a class="fam-option" href={newHref(target)} autofocus={index === 0}>
                  <span class="fam-option__label">
                    {text(target.attributeLabel)}
                    <small class="fam-entry__meta"> · {sourceOf(target)}</small>
                  </span>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M9 6l6 6-6 6"></path>
                  </svg>
                </a>
              </li>
            ))}
          </ul>
          <div class="fam-dialog__footer">
            <span class="fam-dialog__spacer"></span>
            <a class="fam-button fam-button--quiet" href={close}>
              {t.common.cancel}
            </a>
          </div>
        </div>
      </Dialog>
    ) : shown?.step === "form" ? (
      <Dialog
        id="rule"
        eyebrow={shown.rule ? a.editEyebrow : props.targets.length > 1 ? a.formEyebrow : a.onlyFormEyebrow}
        title={sourceOf(shown.form)}
        closeHref={close}
      >
        <form method="post" action={shown.rule ? `${close}/${shown.rule.id}` : close} class="fam-dialog__form">
          <Problem message={shown.problem} />
          {shown.rule ? null : (
            <>
              <input type="hidden" name="sourceId" value={shown.form.sourceId} />
              <input type="hidden" name="attribute" value={shown.form.attribute} />
            </>
          )}
          <RuleFields
            form={shown.form}
            members={props.members}
            value={shown.entered?.value ?? shown.rule?.value ?? ""}
            concerns={shown.entered?.concerns ?? concernsOf(shown.rule)}
          />
          <DialogFooter
            closeHref={close}
            submit={shown.rule ? t.common.save : a.add}
            {...(!shown.rule && props.targets.length > 1 ? { backHref: `${close}/new` } : {})}
          />
        </form>
        {shown.rule ? (
          <form method="post" action={`${close}/${shown.rule.id}/remove`} class="fam-dialog__form">
            <button type="submit" class="fam-button fam-button--danger">
              {a.remove}
            </button>
          </form>
        ) : null}
      </Dialog>
    ) : undefined;
  return (
    <AdminLayout title={a.title} admin={props.admin} current="attribution" dialog={dialog}>
      <SectionHeader
        title={a.title}
        description={a.description}
        action={props.targets.length > 0 ? addButton(`${close}/new`, a.add) : undefined}
      />
      {props.targets.length === 0 ? <p class="fam-empty">{a.noTargets((label) => <a href="/admin/sources">{label}</a>)}</p> : null}
      {props.rules.length === 0 ? (
        <p class="fam-empty">{a.none}</p>
      ) : (
        <ul class="fam-panel fam-entries">
          {props.rules.map((rule) => {
            const concerned = rule.concerns === "whole-family" ? [] : props.members.filter((member) => rule.concerns.includes(member.id));
            const who =
              rule.concerns === "whole-family" ? a.wholeFamily : concerned.length > 0 ? concerned.map((member) => member.name).join(", ") : a.noOne;
            return (
              <li class="fam-entry">
                {concerned.length > 0 ? (
                  <span class="fam-avatars">
                    {concerned.map((member) => (
                      <Avatar member={member} size="sm" />
                    ))}
                  </span>
                ) : (
                  <span class="fam-avatar fam-avatar--all fam-avatar--sm" aria-hidden="true"></span>
                )}
                <span class="fam-entry__main">
                  <span class="fam-entry__name">{a.entry(text(rule.attributeLabel), rule.value)}</span>
                  <span class="fam-entry__meta">{`${who} · ${sourceOf(rule)}`}</span>
                </span>
                <a class="fam-button fam-button--quiet" href={`${close}/${rule.id}`}>
                  {t.common.edit}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </AdminLayout>
  );
}

/** The concerns a rule's form starts with: its Family Members, or the whole Family. */
function concernsOf(rule: AttributionRuleSummary | undefined): string[] {
  if (!rule) return [];
  return rule.concerns === "whole-family" ? ["whole-family"] : rule.concerns;
}

/** The value a rule matches, offering the known ones, and whom it concerns. */
function RuleFields(props: { form: RuleForm; members: FamilyMemberSummary[]; value: string; concerns: string[] }) {
  const { form } = props;
  const { t, text } = useTranslation();
  const a = t.attribution;
  return (
    <>
      <div class="fam-field">
        <label for="rule-value">{text(form.attributeLabel)}</label>
        <input
          id="rule-value"
          name="value"
          required
          autofocus
          maxlength={maximumAttributeValueLength}
          list="rule-known-values"
          autocomplete="off"
          value={props.value}
        />
        <datalist id="rule-known-values">
          {form.knownValues.map((known) => (
            <option value={known.value}>{known.label}</option>
          ))}
        </datalist>
        <small>{a.valueHint}</small>
      </div>
      <fieldset>
        <legend>{a.concerns}</legend>
        <small>{a.concernsHint}</small>
        <div class="fam-choices">
          <label class="fam-choice">
            <input type="checkbox" name="concerns" value="whole-family" checked={props.concerns.includes("whole-family")} />{" "}
            <span class="fam-avatar fam-avatar--all fam-avatar--sm" aria-hidden="true"></span> {a.wholeFamily}
          </label>
          {props.members.map((member) => (
            <label class="fam-choice">
              <input type="checkbox" name="concerns" value={member.id} checked={props.concerns.includes(member.id)} />{" "}
              <Avatar member={member} size="sm" /> {member.name}
            </label>
          ))}
        </div>
      </fieldset>
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
