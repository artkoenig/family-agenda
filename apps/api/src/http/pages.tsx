import {
  pollIntervalRange,
  type AdminSummary,
  type CatalogueSummary,
  type FamilyMemberSummary,
  type LanguageSettings,
  defaultRequiredGroup,
  singleSignOnCallbackPath,
  type SingleSignOnSummary,
  type EndpointCheck,
  type LlmEndpointSummary,
  type MessageDetails,
  type MessageItemRows,
  type RecoveryKit,
  type SetupProgress,
  type SourceForm,
  type SourceHealth,
  type SourceSummary,
  type SourceTypeSummary,
  type AgendaSummary,
} from "@family-agenda/application";
import {
  defaultHorizonDays,
  familyLanguages,
  horizonDaysRange,
  maximumNameLength,
  minimumPasswordLength,
  photoTypes,
  silentAfterMs,
  agendaLayouts,
  type AdminId,
  type FamilyLanguage,
  type FamilyMemberId,
  type MultilingualText,
  type OcrLanguage,
  type AgendaId,
} from "@family-agenda/domain";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { useTranslation, type Translation } from "./i18n/translation";
import type { Catalogue } from "./i18n/en";
import { Layout, Problem } from "./layout";
import {
  FragmentError,
  LazyFragment,
  notReadyYet,
  type FragmentPoll,
} from "./lazy-fragment";
import { Avatar, MessageItems, agendaUrl } from "./agenda-page";

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

/**
 * A page before the settings, such as signing in: the product's name above one sheet with its
 * title, what it is for, and its form.
 */
function EntrancePage(props: {
  title: string;
  intro?: string;
  problem?: string | undefined;
  children: Child;
}) {
  return (
    <Layout title={props.title} narrow>
      <p class="fam-brand">Family Agenda</p>
      <section class="fam-sheet">
        <h1 class="fam-title">{props.title}</h1>
        {props.intro ? (
          <p class="fam-section-header__description">{props.intro}</p>
        ) : null}
        <Problem message={props.problem} />
        {props.children}
      </section>
    </Layout>
  );
}

export function FirstAdminPage(props: {
  language: FamilyLanguage;
  email?: string;
  problem?: string;
}) {
  const { t } = useTranslation();
  return (
    <EntrancePage
      title={t.setup.title}
      intro={t.setup.intro}
      problem={props.problem}
    >
      <form method="post" action="/setup" class="fam-sheet__form">
        <div class="fam-group__fields">
          <div class="fam-field">
            <label for="email">{t.common.email}</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autofocus
              autocomplete="username"
              value={props.email}
            />
          </div>
          <div class="fam-field">
            <label for="password">{t.setup.password}</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minlength={minimumPasswordLength}
              autocomplete="new-password"
            />
          </div>
          <div class="fam-field">
            <label for="language">{t.setup.familyLanguage}</label>
            <select id="language" name="language">
              <FamilyLanguageOptions selected={props.language} />
            </select>
            <small>{t.setup.familyLanguageHint}</small>
          </div>
        </div>
        <div class="fam-group__actions">
          <button type="submit" class="fam-button fam-button--primary">
            {t.setup.submit}
          </button>
        </div>
      </form>
    </EntrancePage>
  );
}

export function SignInPage(props: {
  email?: string;
  problem?: string;
  singleSignOn?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <EntrancePage title={t.signIn.title} problem={props.problem}>
      <form method="post" action="/admin/sign-in" class="fam-sheet__form">
        <div class="fam-group__fields">
          <div class="fam-field">
            <label for="email">{t.common.email}</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autofocus
              autocomplete="username"
              value={props.email}
            />
          </div>
          <div class="fam-field">
            <label for="password">{t.common.password}</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autocomplete="current-password"
            />
          </div>
        </div>
        <div class="fam-group__actions">
          <button type="submit" class="fam-button fam-button--primary">
            {t.signIn.submit}
          </button>
          {props.singleSignOn ? (
            <a href="/sso/start" class="fam-button">
              {t.signIn.singleSignOn}
            </a>
          ) : null}
        </div>
      </form>
    </EntrancePage>
  );
}

/** What the settings list says about each section, gathered for every Admin page. */
export type SettingsSummary = {
  members: string[];
  agendas: number;
  sources: number;
  /** How many Sources are Failing, which the whole Admin area shows a banner for. */
  failingSources: number;
  llm: { model: string; local: boolean } | null;
  admins: number;
  /** Whether Admins can sign in through an Identity Provider. */
  singleSignOn: boolean;
  kitSaved: boolean;
  /** The release this Instance runs, such as `0.3.1`, `main-1a2b3c4` or `dev`. */
  version: string;
  /** The Family Language. */
  family: FamilyLanguage;
  /** Whether OCR is on, its languages, and whether one of their models is missing. */
  ocr: { enabled: boolean; languages: OcrLanguage[]; missing: boolean };
};

/** The Admin a page is shown to, and the settings list. */
export type SignedInAdmin = AdminSummary & { settings: SettingsSummary };

type SectionId =
  | "members"
  | "agendas"
  | "display"
  | "sources"
  | "llm"
  | "admins"
  | "sso"
  | "recovery-kit";

/** `fragment` loads a fresher summary right after the page, which does not wait for it. */
type Summary = { text: string; tone?: "attention"; fragment?: string };

type SettingsGroup = {
  name: string;
  sections: {
    id: SectionId;
    href: string;
    label: string;
    summary: (s: SignedInAdmin) => Summary;
  }[];
};

/** The settings list: sections in groups, each with where it is and what it says about itself. */
function settingsGroups(translation: Translation): SettingsGroup[] {
  const { t } = translation;
  const s = t.settings;
  return [
    {
      name: s.groups.family,
      sections: [
        {
          id: "members",
          href: "/admin/family-members",
          label: t.members.title,
          summary: ({ settings }) => ({
            text:
              settings.members.length > 0
                ? settings.members.join(", ")
                : s.noneYet,
          }),
        },
        {
          id: "agendas",
          href: "/admin/agendas",
          label: t.agendas.title,
          summary: ({ settings }) => ({
            text:
              settings.agendas > 0 ? s.agendas(settings.agendas) : s.noneYet,
          }),
        },
        {
          id: "display",
          href: "/admin/display",
          label: t.display.title,
          summary: ({ settings }) => ({
            text: s.display(t.familyLanguageNames[settings.family]),
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
          summary: ({ settings }) =>
            settings.failingSources > 0
              ? { text: s.failing(settings.failingSources), tone: "attention" }
              : {
                  text:
                    settings.sources > 0
                      ? s.sources(settings.sources)
                      : s.noneYet,
                },
        },
        {
          id: "llm",
          href: "/admin/llm",
          label: t.llm.title,
          summary: ({ settings }) => llmSummary(translation, settings, null),
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
          id: "sso",
          href: "/admin/sso",
          label: t.sso.title,
          summary: ({ settings }) => ({
            text: settings.singleSignOn ? s.on : t.sso.off,
          }),
        },
        {
          id: "recovery-kit",
          href: "/admin/recovery-kit",
          label: t.recoveryKit.title,
          summary: ({ settings }) =>
            settings.kitSaved
              ? { text: s.saved }
              : { text: s.notSavedYet, tone: "attention" },
        },
      ],
    },
  ];
}

/**
 * What the settings list says about the AI: whether its endpoint answers, as `health` says, and the
 * OCR languages. Without `health`, which the page does not wait for, it loads as a fragment.
 */
function llmSummary(
  translation: Translation,
  settings: SettingsSummary,
  health: "ok" | "failing" | null,
): Summary {
  const failing = health === "failing";
  const text = [
    llmTextOf(translation, settings.llm, failing),
    ocrTextOf(translation, settings.ocr),
  ].join("; ");
  const tone =
    failing || settings.ocr.missing ? { tone: "attention" as const } : {};
  const fragment =
    settings.llm && health === null
      ? { fragment: "/admin/llm/nav-status" }
      : {};
  return { text, ...tone, ...fragment };
}

function llmTextOf(
  translation: Translation,
  llm: SettingsSummary["llm"],
  failing: boolean,
): string {
  const s = translation.t.settings;
  if (!llm) return s.notSetUp;
  return failing ? s.llmFailing : llm.model;
}

function ocrTextOf(
  translation: Translation,
  ocr: SettingsSummary["ocr"],
): string {
  const { t, list, ocrLanguageName } = translation;
  return ocr.enabled
    ? t.settings.ocr(list(ocr.languages.map(ocrLanguageName)))
    : t.settings.ocrOff;
}

/** The AI's summary in the settings list once its endpoint answered, as `/admin/llm/nav-status` loads it. */
export function LlmNavSummary(props: {
  admin: SignedInAdmin;
  health: "ok" | "failing";
}) {
  return (
    <NavSummary
      summary={llmSummary(useTranslation(), props.admin.settings, props.health)}
    />
  );
}

function NavSummary(props: { summary: Summary }) {
  const { summary } = props;
  const text = (
    <span
      class={
        summary.tone
          ? `fam-navitem__summary fam-navitem__summary--${summary.tone}`
          : "fam-navitem__summary"
      }
    >
      {summary.text}
    </span>
  );
  return summary.fragment ? (
    <LazyFragment href={summary.fragment}>{text}</LazyFragment>
  ) : (
    text
  );
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
    agendas: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2.5"></rect>
        <path d="M9 21h6M12 17v4"></path>
      </>
    ),
    display: (
      <>
        <circle cx="12" cy="12" r="9"></circle>
        <path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"></path>
      </>
    ),
    sources: (
      <>
        <path d="M3 13l2.5-7h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
        <path d="M3 13h5l1.5 2.5h5L16 13h5"></path>
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
    sso: (
      <>
        <circle cx="8" cy="12" r="3.5"></circle>
        <path d="M11.5 12H21M18 12v3M15 12v2"></path>
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
    <svg
      class="fam-navitem__icon"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
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
          <span class="fam-settings__who">{admin.email}</span>
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
                  <a
                    class="fam-navitem"
                    href={section.href}
                    aria-current={current === section.id ? "page" : undefined}
                  >
                    <SectionIcon id={section.id} />
                    <span class="fam-navitem__text">
                      <span class="fam-navitem__label">{section.label}</span>
                      <NavSummary summary={summary} />
                    </span>
                  </a>
                );
              })}
            </>
          ))}
          <span class="fam-settings__version">
            {t.settings.version(admin.settings.version)}
          </span>
        </nav>
        <main class="fam-settings__main">
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
      {/* Where a dialog opens, also one loaded on its own into the open page (`DialogLink`). */}
      <div id="fam-dialog-slot">{props.dialog}</div>
    </Layout>
  );
}

/** A section's heading with its status, what it is for, and its one action. */
function SectionHeader(props: {
  title: string;
  status?: Child;
  description?: Child;
  action?: Child;
}) {
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
        {props.description ? (
          <p class="fam-section-header__description">{props.description}</p>
        ) : null}
      </div>
      {props.action}
    </header>
  );
}

/**
 * A modal dialog over the section, at its own address so that it works without JavaScript;
 * closing it goes back to the section.
 */
function Dialog(props: {
  id: string;
  eyebrow?: string;
  title: string;
  closeHref: string;
  children: Child;
}) {
  const { t } = useTranslation();
  return (
    <dialog
      open
      class="fam-dialog"
      aria-labelledby={`${props.id}-title`}
      data-close={props.closeHref}
    >
      <div class="fam-dialog__header">
        <div class="fam-dialog__heading">
          {props.eyebrow ? (
            <span class="fam-dialog__eyebrow">{props.eyebrow}</span>
          ) : null}
          <h2 id={`${props.id}-title`} class="fam-dialog__title">
            {props.title}
          </h2>
        </div>
        <a
          class="fam-button fam-button--quiet fam-dialog__close"
          href={props.closeHref}
          aria-label={t.common.close}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18"></path>
          </svg>
        </a>
      </div>
      {props.children}
    </dialog>
  );
}

/**
 * A link opening a dialog, such as Add or Fix. With htmx, it loads the dialog alone into the open
 * page, which shows a loading dialog at once meanwhile (`modalDialogs`); its address is the page
 * with the dialog open, for a direct link and without JavaScript.
 */
function DialogLink(props: {
  href: string;
  class: string;
  "aria-label"?: string;
  children: Child;
}) {
  const { t } = useTranslation();
  return (
    <a
      class={props.class}
      href={props.href}
      aria-label={props["aria-label"]}
      hx-get={props.href}
      hx-target="#fam-dialog-slot"
      hx-push-url="true"
      data-opens-dialog={t.loading.default}
    >
      {props.children}
    </a>
  );
}

/** What a form in a dialog loaded on its own needs, so that a refused submit answers the dialog alone. */
function dialogForm(action: string) {
  return {
    method: "post" as const,
    action,
    "hx-post": action,
    "hx-target": "#fam-dialog-slot",
  };
}

/**
 * A dialog's buttons: going back a step or removing what it edits, cancelling, and its one action.
 * Removing submits the `RemoveForm` of the id given, outside the dialog's own form.
 */
function DialogFooter(props: {
  closeHref: string;
  submit: string;
  backHref?: string;
  remove?: { form: string; label: string };
}) {
  const { t } = useTranslation();
  return (
    <div class="fam-dialog__footer">
      {props.remove ? (
        <button
          type="submit"
          form={props.remove.form}
          class="fam-button fam-button--danger"
        >
          {props.remove.label}
        </button>
      ) : null}
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

/**
 * A row of a settings list that opens what it shows, such as a Family Member in its dialog: an
 * optional lead such as an avatar, its name and what tells it apart, and a chevron. Without an
 * `href` it is a plain row, such as the signed-in Admin's own.
 */
function ListRow(props: {
  href?: string;
  lead?: Child;
  name: Child;
  meta?: Child;
  trailing?: Child;
  autofocus?: boolean;
}) {
  const body = (
    <>
      {props.lead}
      <span class="fam-row__main">
        <span class="fam-row__label">{props.name}</span>
        {props.meta ? <span class="fam-row__hint">{props.meta}</span> : null}
      </span>
      {props.trailing}
    </>
  );
  return props.href ? (
    <li class="fam-row fam-row--link">
      <a class="fam-row__link" href={props.href} autofocus={props.autofocus}>
        {body}
        <Chevron />
      </a>
    </li>
  ) : (
    <li class="fam-row">{body}</li>
  );
}

/** The form a dialog's Remove button submits, outside the dialog's own form. */
function RemoveForm(props: { id: string; action: string }) {
  return (
    <form
      method="post"
      action={props.action}
      id={props.id}
      class="fam-dialog__remove"
    ></form>
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
  /** The dialog of another Admin, open with why a new password was refused. */
  editing?: { id: AdminId; problem?: string };
}) {
  const { adding, editing } = props;
  const { t } = useTranslation();
  const edited = editing
    ? props.admins.find(
        (other) => other.id === editing.id && other.id !== props.admin.id,
      )
    : undefined;
  const dialog = edited ? (
    <Dialog
      id="edit-admin"
      eyebrow={t.admins.eyebrow}
      title={edited.email}
      closeHref="/admin/admins"
    >
      <form
        method="post"
        action={`/admin/admins/${edited.id}/password`}
        class="fam-dialog__form"
      >
        <Problem message={editing?.problem} />
        <div class="fam-field">
          <label for="password">{t.admins.newPassword}</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autofocus
            minlength={minimumPasswordLength}
            autocomplete="new-password"
          />
          <small>{t.admins.passwordHint}</small>
        </div>
        <DialogFooter
          closeHref="/admin/admins"
          submit={t.admins.resetPassword}
        />
      </form>
    </Dialog>
  ) : adding ? (
    <Dialog
      id="add-admin"
      eyebrow={t.admins.eyebrow}
      title={t.admins.dialogTitle}
      closeHref="/admin/admins"
    >
      <form method="post" action="/admin/admins" class="fam-dialog__form">
        <Problem message={adding.problem} />
        <div class="fam-field">
          <label for="email">{t.common.email}</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autofocus
            value={adding.email}
          />
        </div>
        <div class="fam-field">
          <label for="password">{t.common.password}</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minlength={minimumPasswordLength}
            autocomplete="new-password"
          />
          <small>{t.admins.passwordHint}</small>
        </div>
        <DialogFooter closeHref="/admin/admins" submit={t.admins.add} />
      </form>
    </Dialog>
  ) : undefined;
  return (
    <AdminLayout
      title={t.admins.title}
      admin={props.admin}
      current="admins"
      dialog={dialog}
    >
      <SectionHeader
        title={t.admins.title}
        description={t.admins.description}
        action={addButton("/admin/admins/new", t.admins.add)}
      />
      <Problem message={props.problem} />
      <section class="fam-sheet">
        <ul class="fam-rows">
          {props.admins.map((other) =>
            other.id === props.admin.id ? (
              <ListRow name={other.email} meta={t.admins.you} />
            ) : (
              <ListRow
                href={`/admin/admins/${other.id}`}
                name={other.email}
                meta={t.admins.admin}
              />
            ),
          )}
        </ul>
      </section>
    </AdminLayout>
  );
}

/** The kit as a text file to download. */
export function recoveryKitText(kit: RecoveryKit, t: Catalogue): string {
  const { fileTitle, masterKeyLine, purpose } = t.recoveryKit;
  return [fileTitle, "", masterKeyLine, kit.masterKey, "", ...purpose, ""].join(
    "\n",
  );
}

export function RecoveryKitPage(props: {
  admin: SignedInAdmin;
  kit: RecoveryKit;
  confirmed: boolean;
  problem?: string | undefined;
}) {
  const { t } = useTranslation();
  const k = t.recoveryKit;
  return (
    <AdminLayout title={k.title} admin={props.admin} current="recovery-kit">
      <SectionHeader title={k.title} description={k.description} />
      {props.confirmed ? (
        <div class="fam-banner fam-banner--success" role="status">
          <span class="fam-banner__glyph" aria-hidden="true">
            ✓
          </span>
          <span class="fam-banner__title">{k.saved}</span>
          <div class="fam-banner__body">{k.savedBody}</div>
        </div>
      ) : (
        <div class="fam-banner fam-banner--attention" role="status">
          <span class="fam-banner__glyph" aria-hidden="true">
            !
          </span>
          <span class="fam-banner__title">{k.saveFirst}</span>
          <div class="fam-banner__body">{k.saveFirstBody}</div>
        </div>
      )}
      <section class="fam-sheet">
        <Group title={k.masterKey} level={2}>
          <div class="fam-group__fields">
            {/* Once saved, it shows only on request, as anyone near the screen could copy it. */}
            {props.confirmed ? (
              <details class="fam-reveal">
                <summary class="fam-button fam-button--secondary">
                  <span class="fam-reveal__when-closed">{k.showMasterKey}</span>
                  <span class="fam-reveal__when-open">{k.hideMasterKey}</span>
                </summary>
                <p class="fam-secret">{props.kit.masterKey}</p>
              </details>
            ) : (
              <p class="fam-secret">{props.kit.masterKey}</p>
            )}
            <div class="fam-prose">
              {k.purpose.map((sentence) => (
                <p>{sentence}</p>
              ))}
            </div>
          </div>
          <div class="fam-group__actions">
            <button
              type="button"
              class="fam-button fam-button--secondary"
              onclick="for (const kit of document.querySelectorAll('details.fam-reveal')) kit.open = true; window.print()"
            >
              {k.print}
            </button>
            <a
              class="fam-button fam-button--quiet"
              href="/admin/recovery-kit/download"
            >
              {k.download}
            </a>
          </div>
        </Group>
        {props.confirmed ? null : (
          <form
            method="post"
            action="/admin/recovery-kit/confirm"
            class="fam-sheet__form"
          >
            <Group title={k.confirmTitle} level={2}>
              <Problem message={props.problem} />
              <div class="fam-group__fields">
                <label>
                  <input type="checkbox" name="saved" value="yes" required />{" "}
                  {k.confirm}
                </label>
              </div>
              <div class="fam-group__actions">
                <button type="submit" class="fam-button fam-button--primary">
                  {k.continue}
                </button>
              </div>
            </Group>
          </form>
        )}
      </section>
    </AdminLayout>
  );
}

function MemberDialog(props: {
  edited?: FamilyMemberSummary | undefined;
  adding?: { name?: string; problem?: string } | undefined;
  editing?: { id: FamilyMemberId; problem?: string } | undefined;
  m: Catalogue["members"];
  commonSave: string;
}) {
  const { edited, adding, editing, m, commonSave } = props;
  if (edited) {
    return (
      <Dialog
        id="edit-member"
        eyebrow={m.eyebrow}
        title={edited.name}
        closeHref="/admin/family-members"
      >
        <form
          method="post"
          action={`/admin/family-members/${edited.id}`}
          enctype="multipart/form-data"
          class="fam-dialog__form"
        >
          <Problem message={editing?.problem} />
          <div class="fam-field">
            <label for="name">{m.name}</label>
            <input
              id="name"
              name="name"
              required
              autofocus
              maxlength={maximumNameLength}
              value={edited.name}
            />
            <small>{m.nameHint}</small>
          </div>
          <div class="fam-field">
            <label for="photo">
              {edited.hasPhoto ? m.replacePhoto : m.photo}
            </label>
            <input
              id="photo"
              name="photo"
              type="file"
              accept={photoTypes.join(",")}
            />
            {edited.hasPhoto ? (
              <label>
                <input type="checkbox" name="removePhoto" value="yes" />{" "}
                {m.removePhoto}
              </label>
            ) : (
              <small>{m.photoHint}</small>
            )}
          </div>
          <DialogFooter
            closeHref="/admin/family-members"
            submit={commonSave}
            remove={{ form: "remove-member", label: m.remove(edited.name) }}
          />
        </form>
        <RemoveForm
          id="remove-member"
          action={`/admin/family-members/${edited.id}/remove`}
        />
      </Dialog>
    );
  }
  if (adding) {
    return (
      <Dialog
        id="add-member"
        eyebrow={m.eyebrow}
        title={m.dialogTitle}
        closeHref="/admin/family-members"
      >
        <form
          method="post"
          action="/admin/family-members"
          enctype="multipart/form-data"
          class="fam-dialog__form"
        >
          <Problem message={adding.problem} />
          <div class="fam-field">
            <label for="name">{m.name}</label>
            <input
              id="name"
              name="name"
              required
              autofocus
              maxlength={maximumNameLength}
              value={adding.name}
            />
            <small>{m.nameHint}</small>
          </div>
          <div class="fam-field">
            <label for="photo">{m.photo}</label>
            <input
              id="photo"
              name="photo"
              type="file"
              accept={photoTypes.join(",")}
            />
            <small>{m.photoHint}</small>
          </div>
          <DialogFooter closeHref="/admin/family-members" submit={m.add} />
        </form>
      </Dialog>
    );
  }
  return null;
}

export function FamilyMembersPage(props: {
  admin: SignedInAdmin;
  members: FamilyMemberSummary[];
  problem?: string;
  /** The add dialog, open with what was entered and why it was refused. */
  adding?: { name?: string; problem?: string } | undefined;
  /** A Family Member's dialog, open with why a change was refused. */
  editing?: { id: FamilyMemberId; problem?: string } | undefined;
}) {
  const { adding, editing } = props;
  const { t } = useTranslation();
  const m = t.members;
  const edited = editing
    ? props.members.find((member) => member.id === editing.id)
    : undefined;
  const dialog =
    edited || adding ? (
      <MemberDialog
        edited={edited}
        adding={adding}
        editing={editing}
        m={m}
        commonSave={t.common.save}
      />
    ) : undefined;
  return (
    <AdminLayout
      title={m.title}
      admin={props.admin}
      current="members"
      dialog={dialog}
    >
      <SectionHeader
        title={m.title}
        description={m.description}
        action={addButton("/admin/family-members/new", m.add)}
      />
      <Problem message={props.problem} />
      {props.members.length === 0 ? (
        <p class="fam-empty">{m.none}</p>
      ) : (
        <section class="fam-sheet">
          <ul class="fam-rows">
            {props.members.map((member) => (
              <ListRow
                href={`/admin/family-members/${member.id}`}
                lead={<Avatar member={member} size="sm" />}
                name={member.name}
                meta={member.hasPhoto ? m.withPhoto : m.withInitial}
              />
            ))}
          </ul>
        </section>
      )}
    </AdminLayout>
  );
}

/** Copies `text` to the clipboard; the script in the layout wires it up. */
function CopyButton(props: { text: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      class="fam-button fam-button--quiet fam-copy"
      data-copy={props.text}
      data-copied={t.agendas.copied}
      aria-label={t.agendas.copy}
      title={t.agendas.copy}
    >
      <svg
        class="fam-copy__copy"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="11" height="11" rx="2"></rect>
        <path d="M5 15V6a2 2 0 0 1 2-2h9"></path>
      </svg>
      <svg
        class="fam-copy__done"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12.5l4.5 4.5L19 7.5"></path>
      </svg>
    </button>
  );
}

export function AgendasPage(props: {
  admin: SignedInAdmin;
  agendas: AgendaSummary[];
  members: FamilyMemberSummary[];
  /** Scheme and host the Admin reached the Instance by, so that an Agenda's address can be copied as it is. */
  origin: string;
  problem?: string;
  /** The create dialog, open with why it was refused. */
  creating?: { problem?: string };
  /** An Agenda's dialog, open with why a change was refused. */
  editing?: { id: AgendaId; problem?: string };
}) {
  const memberOf = (id: string) =>
    props.members.find((member) => member.id === id);
  const { creating, editing } = props;
  const { t } = useTranslation();
  const v = t.agendas;
  const namesOf = (agenda: AgendaSummary) => {
    const names = agenda.memberIds.flatMap((id) => memberOf(id)?.name ?? []);
    return names.length > 0 ? names.join(", ") : null;
  };
  /** A timeline by whom it shows and its horizon, a Task List by whom it shows. */
  const entryOf = (agenda: AgendaSummary) => {
    const who = namesOf(agenda) ?? v.everyone;
    return agenda.layout === "task_list"
      ? v.taskListEntry(who)
      : v.entry(who, agenda.horizonDays);
  };
  const edited = editing
    ? props.agendas.find((agenda) => agenda.id === editing.id)
    : undefined;
  const address = edited ? `${props.origin}${agendaUrl(edited.id)}` : "";
  const dialog = edited ? (
    <Dialog
      id="edit-agenda"
      eyebrow={v.eyebrow}
      title={entryOf(edited)}
      closeHref="/admin/agendas"
    >
      <form
        method="post"
        action={`/admin/agendas/${edited.id}`}
        class="fam-dialog__form"
      >
        <Problem message={editing?.problem} />
        <dl class="fam-addresses">
          <dt>{v.address}</dt>
          <dd>
            <a href={address}>{address}</a>
            <CopyButton text={address} />
          </dd>
          <dt>{v.feed}</dt>
          <dd>
            <a href={`${address}/feed.ics`}>{`${address}/feed.ics`}</a>
            <CopyButton text={`${address}/feed.ics`} />
          </dd>
        </dl>
        <AgendaSettingsFields
          members={props.members}
          agenda={edited}
          idSuffix={edited.id}
        />
        <DialogFooter
          closeHref="/admin/agendas"
          submit={t.common.save}
          remove={{ form: "remove-agenda", label: v.remove }}
        />
      </form>
      <RemoveForm
        id="remove-agenda"
        action={`/admin/agendas/${edited.id}/remove`}
      />
    </Dialog>
  ) : creating ? (
    <Dialog
      id="create-agenda"
      eyebrow={v.eyebrow}
      title={v.dialogTitle}
      closeHref="/admin/agendas"
    >
      <form method="post" action="/admin/agendas" class="fam-dialog__form">
        <Problem message={creating.problem} />
        <AgendaSettingsFields members={props.members} idSuffix="new" />
        <DialogFooter closeHref="/admin/agendas" submit={v.create} />
      </form>
    </Dialog>
  ) : undefined;
  return (
    <AdminLayout
      title={v.title}
      admin={props.admin}
      current="agendas"
      dialog={dialog}
    >
      <SectionHeader
        title={v.title}
        description={v.description}
        action={addButton("/admin/agendas/new", v.create)}
      />
      <Problem message={props.problem} />
      {props.agendas.length === 0 ? (
        <p class="fam-empty">{v.none}</p>
      ) : (
        <section class="fam-sheet">
          <ul class="fam-rows">
            {props.agendas.map((agenda) => {
              const shown = agenda.memberIds
                .map(memberOf)
                .filter((member) => member !== undefined);
              const names = namesOf(agenda);
              return (
                <ListRow
                  href={`/admin/agendas/${agenda.id}`}
                  lead={
                    shown.length > 0 ? (
                      <span class="fam-avatars">
                        {shown.map((member) => (
                          <Avatar member={member} size="sm" />
                        ))}
                      </span>
                    ) : (
                      <span
                        class="fam-avatar fam-avatar--all fam-avatar--sm"
                        aria-hidden="true"
                      ></span>
                    )
                  }
                  name={entryOf(agenda)}
                  meta={v.shows(names)}
                />
              );
            })}
          </ul>
        </section>
      )}
    </AdminLayout>
  );
}

function AgendaSettingsFields(props: {
  members: FamilyMemberSummary[];
  agenda?: AgendaSummary;
  idSuffix: string;
}) {
  const id = (name: string) => `${name}-${props.idSuffix}`;
  const { t } = useTranslation();
  const layout = props.agenda?.layout ?? "timeline";
  return (
    <>
      <fieldset>
        <legend>{t.agendas.layout}</legend>
        <div class="fam-choices">
          {agendaLayouts.map((value) => (
            <label class="fam-choice fam-choice--layout">
              <input
                type="radio"
                name="layout"
                value={value}
                checked={layout === value}
              />
              <span class="fam-choice__text">
                <span class="fam-choice__label">
                  {t.agendas.layouts[value].label}
                </span>
                <span class="fam-choice__hint">
                  {t.agendas.layouts[value].hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{t.agendas.memberIds}</legend>
        <small>{t.agendas.memberIdsHint}</small>
        {props.members.length === 0 ? <p>{t.agendas.noMembers}</p> : null}
        <div class="fam-choices fam-choices--members">
          {props.members.map((member) => (
            <label class="fam-pillswitch" title={member.name}>
              <input
                type="checkbox"
                name="memberIds"
                value={member.id}
                checked={props.agenda?.memberIds.includes(member.id) ?? false}
              />
              <Avatar member={member} size="sm" />
              <span class="fam-pillswitch__name">{member.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div class="fam-field fam-agenda-horizon">
        <label for={id("horizon")}>{t.agendas.horizon}</label>
        <input
          id={id("horizon")}
          name="horizonDays"
          type="number"
          required
          min={horizonDaysRange.min}
          max={horizonDaysRange.max}
          autofocus
          value={String(props.agenda?.horizonDays ?? defaultHorizonDays)}
          class="fam-input--short"
        />
        <small>{t.agendas.horizonHint}</small>
      </div>
    </>
  );
}

/** Where a Source Type's page is: its Sources, its catalogue, and enabling or disabling it. */
export const sourceTypeHref = (id: string) =>
  `/admin/source-types/${encodeURIComponent(id)}`;
export const sourceHref = (id: string) =>
  `/admin/sources/${encodeURIComponent(id)}`;

/**
 * The Sources: a card for each installed Source Type, and for each one no longer installed that
 * still has Sources, each leading to its page.
 */
export function SourcesPage(props: {
  admin: SignedInAdmin;
  sourceTypes: SourceTypeSummary[];
  sources: SourceSummary[];
}) {
  const { t, text } = useTranslation();
  const s = t.sources;
  const sourcesOf = (id: string) =>
    props.sources.filter((source) => source.sourceTypeId === id);
  const installed = new Set<string>(props.sourceTypes.map((type) => type.id));
  const leftBehind = [
    ...new Map(
      props.sources
        .filter((source) => !installed.has(source.sourceTypeId))
        .map((source) => [source.sourceTypeId, source]),
    ).values(),
  ];
  return (
    <AdminLayout title={s.title} admin={props.admin} current="sources">
      <SectionHeader title={s.title} description={s.description} />
      {props.sourceTypes.length === 0 && leftBehind.length === 0 ? (
        <p class="fam-empty">{s.none}</p>
      ) : null}
      <ul class="fam-type-cards">
        {props.sourceTypes.map((type) => (
          <li>
            <a
              class={
                type.enabled
                  ? "fam-type-card"
                  : "fam-type-card fam-type-card--off"
              }
              href={sourceTypeHref(type.id)}
            >
              <span class="fam-type-card__name">{text(type.displayName)}</span>
              <span class="fam-type-card__description">
                {text(type.description)}
              </span>
              {loadabilityProblem(type, s) !== null ? (
                <span class="fam-status fam-status--problem">
                  {loadabilityProblem(type, s)}
                </span>
              ) : type.enabled ? (
                <SourcesSummary sources={sourcesOf(type.id)} />
              ) : (
                <span class="fam-status fam-status--waiting">
                  {s.notEnabled}
                </span>
              )}
            </a>
          </li>
        ))}
        {leftBehind.map((source) => (
          <li>
            <a class="fam-type-card" href={sourceTypeHref(source.sourceTypeId)}>
              <span class="fam-type-card__name">
                {text(source.displayName)}
              </span>
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
  const failing = props.sources.filter(
    (source) => source.health.status === "failing",
  ).length;
  const silent = props.sources.filter(
    (source) => source.health.status === "silent",
  ).length;
  return (
    <span class="fam-type-card__summary">
      <span>{length > 0 ? s.count(length) : s.noSources}</span>
      {failing > 0 ? (
        <span class="fam-status fam-status--problem">
          {s.failingCount(failing)}
        </span>
      ) : silent > 0 ? (
        <span class="fam-status fam-status--waiting">
          {s.silentCount(silent)}
        </span>
      ) : length > 0 ? (
        <span class="fam-status fam-status--ok">{s.allOk}</span>
      ) : null}
    </span>
  );
}

/** A Source being added: its Source Type's form, filled in again with what was entered when refused. */
export type SourceAdding = {
  form: SourceForm;
  entered?: { plain: Record<string, string>; interval: string };
  problem?: string;
};

/** What a live setup step of a Source shows now, with its QR code drawn as SVG. */
export type LiveStep = {
  sourceId: string;
  stepId: string;
  progress: SetupProgress;
  qrSvg: string | null;
};

/**
 * A Source Type's page: its switch, its Sources, and the entries of its catalogue such as its
 * Messengers with their accounts. Adding and setting up a Source open in a
 * dialog over it; a Source opens on a page of its own.
 */
function sourceTypeDialog(
  props: {
    adding?: SourceAdding;
    settingUp?: SourceSummary;
    form: SourceForm | undefined;
    members: FamilyMemberSummary[];
  },
  s: Translation["t"]["sources"],
  text: Translation["text"],
  href: string,
) {
  const { adding, settingUp, form } = props;
  if (adding) return addingDialog(adding, s, text, href);
  if (settingUp && form) return settingUpDialog(settingUp, form, s, text, href);
  return undefined;
}

/** The dialog adding a Source, as it loads on its own into its Source Type's page. */
export function AddSourceDialog(props: { adding: SourceAdding }) {
  const { t, text } = useTranslation();
  return addingDialog(
    props.adding,
    t.sources,
    text,
    sourceTypeHref(props.adding.form.sourceTypeId),
  );
}

function addingDialog(
  adding: SourceAdding,
  s: Translation["t"]["sources"],
  text: Translation["text"],
  href: string,
) {
  const added = addedEntry(adding);
  return (
    <Dialog
      id="add-source"
      eyebrow={s.addEyebrow}
      title={text(added?.displayName ?? adding.form.displayName)}
      closeHref={href}
    >
      <form {...dialogForm("/admin/sources")} class="fam-dialog__form">
        <Problem message={adding.problem} />
        <input
          type="hidden"
          name="sourceTypeId"
          value={adding.form.sourceTypeId}
        />
        <SetupSteps form={adding.form} />
        <SourceFields
          form={adding.form}
          prefix={`new-${adding.form.sourceTypeId}`}
          {...(adding.entered ? { entered: adding.entered } : {})}
          autofocus
        />
        <DialogFooter
          closeHref={href}
          submit={
            added ? s.addAccount : s.addType(text(adding.form.displayName))
          }
        />
      </form>
    </Dialog>
  );
}

function settingUpDialog(
  settingUp: SourceSummary,
  form: SourceForm,
  s: Translation["t"]["sources"],
  text: Translation["text"],
  href: string,
) {
  return (
    <Dialog
      id="set-up-source"
      eyebrow={s.setupEyebrow}
      title={text(settingUp.displayName)}
      closeHref={href}
    >
      <div class="fam-dialog__form">
        <SetupSteps form={form} sourceId={settingUp.id} />
        <div class="fam-dialog__footer">
          <span class="fam-dialog__spacer"></span>
          <a class="fam-button fam-button--primary" href={href}>
            {s.finish}
          </a>
        </div>
      </div>
    </Dialog>
  );
}

function sourceTypeListed(
  sources: SourceSummary[],
  configKey: string | undefined,
  entryIds: Set<string>,
) {
  return sources.filter(
    (source) =>
      configKey === undefined || !entryIds.has(String(source.plain[configKey])),
  );
}

/** What keeps a Source Type from working, as its chip says; null if nothing does. */
function loadabilityProblem(
  sourceType: SourceTypeSummary | null,
  s: Translation["t"]["sources"],
): string | null {
  if (sourceType?.notReachable != null) return s.notReachable;
  return sourceType?.notLoadable != null ? s.cannotLoad : null;
}

function sourceTypeLoadability(
  sourceType: SourceTypeSummary | null,
  s: Translation["t"]["sources"],
) {
  const problem = loadabilityProblem(sourceType, s);
  const status =
    problem === null ? undefined : (
      <span class="fam-chip fam-chip--problem">{problem}</span>
    );
  const switchable =
    sourceType && sourceType.notLoadable === null ? sourceType : undefined;
  return { status, switchable };
}

function configKeyOf(
  sourceType: SourceTypeSummary | null,
  form: SourceForm | undefined,
) {
  return sourceType?.enabled ? form?.catalogue?.configKey : undefined;
}

function catalogueOf(
  configKey: string | undefined,
  catalogue: CatalogueSummary | undefined,
) {
  return configKey !== undefined &&
    catalogue &&
    (catalogue.entries.length > 0 || catalogue.problem !== null)
    ? catalogue
    : undefined;
}

function SourceSwitchSection(props: {
  switchable: SourceTypeSummary;
  name: string;
  sources: SourceSummary[];
  href: string;
  types: Translation["t"]["sourceTypes"];
}) {
  const { switchable, name, sources, href, types } = props;
  const locked = switchable.enabled && sources.length > 0;
  return (
    <section class="fam-sheet">
      <SettingRow
        title={<span class="fam-row__label">{types.use(name)}</span>}
        hints={[
          `${types.version(switchable.version)}${switchable.needsLlm ? types.needsLlm : ""}`,
          locked ? types.lockedHint(name) : null,
        ]}
        control={
          <EnableSwitch
            id="enable-source-type"
            name={name}
            action={href}
            enabled={switchable.enabled}
            locked={locked}
          />
        }
      />
      {!switchable.enabled && switchable.riskNotice !== null ? (
        <RiskNotice form="enable-source-type" notice={switchable.riskNotice} />
      ) : null}
    </section>
  );
}

function SourceListSection(props: {
  sourceType: SourceTypeSummary | null;
  /** Whether its Sources are listed at the entries of a catalogue, so that none is left here. */
  hasCatalogue: boolean;
  listed: SourceSummary[];
  addings: Adding[];
  form: SourceForm | undefined;
  name: string;
  sourceTypeId: string;
  members: FamilyMemberSummary[];
  timeZone: string;
  s: Translation["t"]["sources"];
}) {
  const {
    sourceType,
    hasCatalogue,
    listed,
    addings,
    form,
    name,
    sourceTypeId,
    members,
    timeZone,
    s,
  } = props;
  if (
    !(sourceType?.enabled && !hasCatalogue) &&
    listed.length === 0 &&
    addings.length === 0
  )
    return null;
  return (
    <section class="fam-sheet">
      <Group title={s.title} level={2} intro={s.sourcesIntro}>
        <SourceRows
          sources={listed}
          form={form}
          members={members}
          timeZone={timeZone}
          empty={addings.length > 0 ? null : s.noSources}
        >
          {addings.map((adding) => (
            <AddingRow adding={adding} form={form} />
          ))}
        </SourceRows>
        <AddSourceButton
          sourceType={sourceType}
          form={form}
          name={name}
          sourceTypeId={sourceTypeId}
          s={s}
        />
      </Group>
    </section>
  );
}

function AddSourceButton(props: {
  sourceType: SourceTypeSummary | null;
  form: SourceForm | undefined;
  name: string;
  sourceTypeId: string;
  s: Translation["t"]["sources"];
}) {
  const { sourceType, form, name, sourceTypeId, s } = props;
  if (!(sourceType?.enabled && form && !form.catalogue)) return null;
  return (
    <div class="fam-group__actions">
      <DialogLink
        class="fam-button fam-button--quiet fam-button--add"
        href={`/admin/sources/new?type=${encodeURIComponent(sourceTypeId)}`}
      >
        {s.addType(name)}
      </DialogLink>
    </div>
  );
}

/** Why the core cannot reach a Source Type's plugin, and why it cannot load it. */
function LoadabilityProblems({
  sourceType,
  types,
}: {
  sourceType: SourceTypeSummary;
  types: Translation["t"]["sourceTypes"];
}) {
  return (
    <>
      {sourceType.notReachable !== null ? (
        <p class="fam-problem">{types.notReachable(sourceType.notReachable)}</p>
      ) : null}
      {sourceType.notLoadable !== null ? (
        <p class="fam-problem">{types.notLoadable(sourceType.notLoadable)}</p>
      ) : null}
    </>
  );
}

/**
 * The catalogue of a Source Type, such as its Messengers with their accounts, as the fragment its
 * page loads once the plugin listed the entries; with the Sources at entries it did not list, such as
 * while it fails to, which the page leaves to the catalogue.
 */
export function SourceTypeCatalogue(props: {
  sourceTypeId: string;
  sourceType: SourceTypeSummary | null;
  displayName: MultilingualText;
  sources: SourceSummary[];
  /** The entries recorded for the catalogue, at which the page does not show Sources. */
  recordedEntryIds: Set<string>;
  form: SourceForm | undefined;
  catalogue: CatalogueSummary;
  members: FamilyMemberSummary[];
  timeZone: string;
}) {
  const translation = useTranslation();
  const s = translation.t.sources;
  const configKey = configKeyOf(props.sourceType, props.form);
  if (configKey === undefined) return null;
  const catalogue = catalogueOf(configKey, props.catalogue);
  const listedIds = new Set(catalogue?.entries.map((entry) => entry.id));
  const unlisted = props.sources.filter(
    (source) =>
      props.recordedEntryIds.has(String(source.plain[configKey])) &&
      !listedIds.has(String(source.plain[configKey])),
  );
  return (
    <>
      {catalogue ? (
        <CatalogueEntries
          catalogue={catalogue}
          form={props.form}
          configKey={configKey}
          sources={props.sources}
          members={props.members}
          timeZone={props.timeZone}
        />
      ) : null}
      <SourceListSection
        sourceType={props.sourceType}
        hasCatalogue
        listed={unlisted}
        addings={[]}
        form={props.form}
        name={translation.text(props.displayName)}
        sourceTypeId={props.sourceTypeId}
        members={props.members}
        timeZone={props.timeZone}
        s={s}
      />
    </>
  );
}

/** The catalogue's place on its Source Type's page while its plugin lists the entries, which load after the page. */
function CatalogueLoading(props: { href: string; title: MultilingualText }) {
  const { t, text } = useTranslation();
  return (
    <LazyFragment href={props.href} block>
      <p class="fam-group__empty">
        <span class="fam-spinner" aria-hidden="true"></span>{" "}
        {t.loading.catalogue(text(props.title))}
      </p>
    </LazyFragment>
  );
}

/**
 * What a Source Type's page shows of its Sources at once: those at no catalogue entry and those
 * being added, with a placeholder for the catalogue, which loads after the page.
 */
function SourceTypeSources(props: {
  sourceType: SourceTypeSummary | null;
  sourceTypeId: string;
  displayName: MultilingualText;
  sources: SourceSummary[];
  form: SourceForm | undefined;
  recordedEntryIds: Set<string>;
  members: FamilyMemberSummary[];
  timeZone: string;
  addings?: Adding[];
  name: string;
  href: string;
}) {
  const s = useTranslation().t.sources;
  const configKey = configKeyOf(props.sourceType, props.form);
  const listed = sourceTypeListed(
    props.sources,
    configKey,
    props.recordedEntryIds,
  );
  return (
    <>
      {configKey !== undefined ? (
        <CatalogueLoading
          href={`${props.href}/catalogue`}
          title={props.form?.catalogue?.title ?? props.displayName}
        />
      ) : null}
      <SourceListSection
        sourceType={props.sourceType}
        hasCatalogue={
          configKey !== undefined && props.recordedEntryIds.size > 0
        }
        listed={listed}
        addings={props.addings ?? []}
        form={props.form}
        name={props.name}
        sourceTypeId={props.sourceTypeId}
        members={props.members}
        timeZone={props.timeZone}
        s={s}
      />
    </>
  );
}

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
  /** The entries recorded for its catalogue: the Sources at them load with the catalogue. */
  recordedEntryIds: Set<string>;
  /** The Family's Members, named on the rows of the Sources assigned to them. */
  members: FamilyMemberSummary[];
  /** The IANA time zone the Family lives in, which times are shown in. */
  timeZone: string;
  problem?: string;
  adding?: SourceAdding;
  /** The Source just added, whose live setup steps an Admin goes through now. */
  settingUp?: SourceSummary;
  /** What the live setup steps of the Source being set up show. */
  /** Its Sources still being added in the background, or whose adding failed. */
  addings?: Adding[];
}) {
  const { sourceType } = props;
  const { t, text } = useTranslation();
  const s = t.sources;
  const types = t.sourceTypes;
  const href = sourceTypeHref(props.sourceTypeId);
  const name = text(props.displayName);
  const dialog = sourceTypeDialog(props, s, text, href);
  const { status, switchable } = sourceTypeLoadability(sourceType, s);
  return (
    <AdminLayout
      title={name}
      admin={props.admin}
      current="sources"
      dialog={dialog}
    >
      <nav class="fam-breadcrumb" aria-label={s.breadcrumb}>
        <a href="/admin/sources">{s.title}</a> <span aria-hidden="true">›</span>{" "}
        <span aria-current="page">{name}</span>
      </nav>
      <SectionHeader
        title={name}
        status={status}
        description={sourceType ? text(sourceType.description) : s.notInstalled}
      />
      {sourceType ? (
        <LoadabilityProblems sourceType={sourceType} types={types} />
      ) : null}
      <Problem message={props.problem} />
      {switchable ? (
        <SourceSwitchSection
          switchable={switchable}
          name={name}
          sources={props.sources}
          href={href}
          types={types}
        />
      ) : null}
      <SourceTypeSources {...props} name={name} href={href} />
    </AdminLayout>
  );
}

/**
 * A Source's page: its name, settings and polling interval, whether it shows on the timeline, and
 * removing it. Fixing it opens in a dialog over it.
 */
function SourceAttributesForm(props: {
  source: SourceSummary;
  members: FamilyMemberSummary[];
  href: string;
  t: Translation["t"];
  s: Translation["t"]["sources"];
  /** Whether its plugin was just asked for them, rather than a run reporting them; with why that failed. */
  asked?: { problem: string | null };
}) {
  const { source, members, href, t, s, asked } = props;
  if (members.length === 0) return null;
  if (source.attributes.length === 0 && !asked)
    return <AttributesPending source={source} s={s} />;
  const problem = asked?.problem ? (
    <p class="fam-problem">{s.attributesFailed(asked.problem)}</p>
  ) : null;
  if (source.attributes.length === 0) {
    return (
      <div class="fam-sheet__form" id="source-attributes">
        <Group title={s.attributes} level={2}>
          {problem}
          <p class="fam-group__empty">{s.attributesNone}</p>
        </Group>
      </div>
    );
  }
  return (
    <form
      method="post"
      action={`${href}/attributes`}
      class="fam-sheet__form"
      id="source-attributes"
    >
      <Group title={s.attributes} level={2} intro={s.attributesHint}>
        {problem}
        <div class="fam-attributes">
          {source.attributes.map((attribute) => (
            <div class="fam-attribute">
              <p class="fam-attribute__name">
                {attribute.name}
                {attribute.archived ? (
                  <span class="fam-chip fam-chip--small">
                    {s.attributeArchived}
                  </span>
                ) : null}
              </p>
              <div
                class="fam-attribute__members"
                role="group"
                aria-label={s.attributeMembers(attribute.name)}
              >
                {members.map((member) => (
                  <label class="fam-pillswitch" title={member.name}>
                    <input
                      type="checkbox"
                      name={`member.${attribute.id}`}
                      value={member.id}
                      checked={attribute.concerns.includes(member.id)}
                    />
                    <Avatar member={member} size="sm" />
                    <span class="fam-pillswitch__name">{member.name}</span>
                  </label>
                ))}
              </div>
              <p class="fam-attribute__all">{s.attributeWholeFamily}</p>
            </div>
          ))}
        </div>
        <div class="fam-group__actions">
          <button type="submit" class="fam-button fam-button--primary">
            {t.common.save}
          </button>
        </div>
      </Group>
    </form>
  );
}

/**
 * The Source Attributes of a Source whose plugin is asked for them as its page opens: the page
 * shows a spinner in their place and fetches them right after, so that the rest of it does not wait.
 */
function AttributesLoading(props: {
  href: string;
  s: Translation["t"]["sources"];
}) {
  const { href, s } = props;
  return (
    <div
      id="source-attributes"
      class="fam-sheet__form"
      hx-get={`${href}/attributes`}
      hx-trigger="load"
      hx-target="this"
      hx-swap="outerHTML"
      aria-busy="true"
    >
      <Group title={s.attributes} level={2}>
        <p class="fam-group__empty fam-attributes__loading">
          <span
            class="fam-spinner"
            role="status"
            aria-label={s.attributesLoading}
          ></span>{" "}
          {s.attributesLoading}
        </p>
      </Group>
    </div>
  );
}

/** The Source Attributes its plugin has just named, replacing the spinner on its page. */
export function SourceAttributesSection(props: {
  source: SourceSummary;
  members: FamilyMemberSummary[];
  problem: string | null;
}) {
  const { t } = useTranslation();
  return (
    <SourceAttributesForm
      source={props.source}
      members={props.members}
      href={sourceHref(props.source.id)}
      t={t}
      s={t.sources}
      asked={{ problem: props.problem }}
    />
  );
}

/**
 * Whether a Source's Source Attributes will come with its next read, as its parts were chosen, such
 * as its folders or groups, and none are known yet. One with nothing chosen declares none, and once
 * read it has declared what it will.
 */
function attributesPendingOf(source: SourceSummary): boolean {
  if (!source.health.awaitingRead || source.attributes.length > 0) return false;
  return Object.values(source.plain).some(
    (value) => Array.isArray(value) && value.length > 0,
  );
}

/**
 * Where the Source Attributes will be once the Source has been read after its parts were chosen:
 * `SourceReadPoller` brings them in as soon as they are declared, so that the Admin can assign them.
 */
function AttributesPending(props: {
  source: SourceSummary;
  s: Translation["t"]["sources"];
}) {
  const { source, s } = props;
  if (!attributesPendingOf(source)) return null;
  return (
    <div id="source-attributes" class="fam-sheet__form" aria-live="polite">
      <Group title={s.attributes} level={2}>
        <p class="fam-group__empty">{s.attributesPending}</p>
      </Group>
    </div>
  );
}

/** How a Source's page asks for its health line while it waits for a read: soon, then less often, for a few minutes. */
const sourceReadPoll: FragmentPoll = {
  every: 2,
  backoff: 1.5,
  maxSeconds: 300,
};

/**
 * Asks for a Source's health line again after a while, with backoff and a cap, while it awaits a
 * read; invisible, as the line itself says it was not read yet. `attributes=pending` asks for the
 * Source Attributes too, which come with that read.
 */
function SourceReadPoller(props: {
  source: SourceSummary;
  waitedSeconds: number;
  attributesPending?: boolean;
}) {
  const { source } = props;
  // Also while a failure is stored: after a Fix, the next read tells whether it worked.
  if (!source.health.awaitingRead) return null;
  const pending = props.attributesPending ?? attributesPendingOf(source);
  const href = `${sourceHref(source.id)}/health${pending ? "?attributes=pending" : ""}`;
  return notReadyYet({
    href,
    poll: sourceReadPoll,
    waitedSeconds: props.waitedSeconds,
    silent: true,
  });
}

/**
 * What `/admin/sources/:id/health` answers: the Source's health line out of band, its Source
 * Attributes too while they were pending, and the next poll while it still awaits a read.
 */
export function SourceHealthFragment(props: {
  source: SourceSummary;
  form: SourceForm | undefined;
  members: FamilyMemberSummary[];
  timeZone: string;
  waitedSeconds: number;
  attributesPending: boolean;
}) {
  const { source, form } = props;
  const translation = useTranslation();
  const { t, text } = translation;
  const href = sourceHref(source.id);
  const { name } = sourceLabel(source, form, translation);
  return (
    <>
      <div id="source-health" hx-swap-oob="true">
        <SourcePageHeader
          name={name}
          health={source.health}
          entry={entryOf(form, source)}
          form={form}
          href={href}
          timeZone={props.timeZone}
          s={t.sources}
          text={text}
        />
      </div>
      {props.attributesPending && !attributesPendingOf(source) ? (
        <div id="source-attributes-slot" hx-swap-oob="true">
          <SourceAttributesForm
            source={source}
            members={props.members}
            href={href}
            t={t}
            s={t.sources}
          />
        </div>
      ) : null}
      <SourceReadPoller
        source={source}
        waitedSeconds={props.waitedSeconds}
        attributesPending={props.attributesPending}
      />
    </>
  );
}

function SourceTimelineSection(props: {
  source: SourceSummary;
  href: string;
  s: Translation["t"]["sources"];
  waiting: number | undefined;
}) {
  const { source, href, s, waiting } = props;
  return (
    <>
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
              <input
                type="hidden"
                name="shown"
                value={source.shown ? "no" : "yes"}
              />
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
      {waiting !== undefined ? (
        <WaitingGroup label={s.waitingTitle} waiting={waiting} />
      ) : null}
    </>
  );
}

function SourceManagementSection(props: {
  href: string;
  s: Translation["t"]["sources"];
}) {
  const { href, s } = props;
  return (
    <Group title={s.management} level={2}>
      <ul class="fam-rows">
        <li class="fam-row">
          <span class="fam-row__main">
            <span class="fam-row__label">{s.remove}</span>
            <span class="fam-row__hint">{s.removeHint}</span>
          </span>
          <form method="post" action={`${href}/remove`} class="fam-row__form">
            <button
              type="submit"
              class="fam-button fam-button--danger"
              aria-label={s.remove}
            >
              {s.removeButton}
            </button>
          </form>
        </li>
      </ul>
    </Group>
  );
}

/** A Source using a catalogue entry is polled at the entry's interval, set with the entry. */
function suggestedSecondsOf(form: SourceForm | undefined): number | null {
  return form && !form.catalogue ? form.suggestedIntervalSeconds : null;
}

/** Whether its fields or interval are settable, so the form posts to the Source itself. */
function editableOf(
  form: SourceForm | undefined,
  suggestedSeconds: number | null,
): boolean {
  return (
    form !== undefined && (form.fields.length > 0 || suggestedSeconds !== null)
  );
}

/**
 * The usable catalogue entry with an id, to name a Source by. A form whose entries were not asked for
 * (`entries: null`) names none: only the Source Type page has one, and it shows there only the
 * Sources at no entry, the others loading with the catalogue.
 */
function entryIn(
  form: SourceForm | undefined,
  id: unknown,
): { id: string; displayName: MultilingualText } | undefined {
  const entries = form?.catalogue?.entries;
  if (!entries) return undefined;
  return entries.find((candidate) => candidate.id === id);
}

/** The catalogue entry it uses, such as its Messenger, which cannot change. */
function entryOf(form: SourceForm | undefined, source: SourceSummary) {
  const entryKey = form?.catalogue?.configKey;
  return entryKey !== undefined
    ? entryIn(form, source.plain[entryKey])
    : undefined;
}

function SourcePageHeader(props: {
  name: string;
  health: SourceHealth;
  entry: { id: string; displayName: MultilingualText } | undefined;
  form: SourceForm | undefined;
  href: string;
  timeZone: string;
  s: Translation["t"]["sources"];
  text: (text: MultilingualText) => string;
}) {
  const { name, health, entry, form, href, s, text } = props;
  return (
    <SectionHeader
      title={name}
      status={<HealthStatus health={health} chip />}
      description={
        <span class="fam-health">
          {entry ? <span>{text(entry.displayName)} ·</span> : null}
          <HealthDetails health={health} timeZone={props.timeZone} />
        </span>
      }
      action={
        health.status === "failing" && form ? (
          <DialogLink
            class="fam-button fam-button--secondary"
            href={`${href}/fix`}
          >
            {s.fix}
          </DialogLink>
        ) : undefined
      }
    />
  );
}

function SourcePageForm(props: {
  source: SourceSummary;
  form: SourceForm | undefined;
  members: FamilyMemberSummary[];
  editable: boolean;
  href: string;
  derived: string;
  t: Translation["t"];
  s: Translation["t"]["sources"];
}) {
  const { source, form, editable, href, derived, t, s } = props;
  return (
    <form
      method="post"
      action={editable ? href : `${href}/name`}
      class="fam-sheet__form"
    >
      <Group title={s.settings} level={2}>
        <div class="fam-group__fields">
          <div class="fam-field">
            <label for={`${source.id}-name`}>{s.name}</label>
            <input
              id={`${source.id}-name`}
              name="name"
              maxlength={maximumNameLength}
              placeholder={derived}
              value={source.name ?? undefined}
            />
            <small>{s.nameHint(derived)}</small>
          </div>
          {form && editable ? (
            <SourceFields
              form={form}
              prefix={source.id}
              source={source}
              omitFixed
            />
          ) : null}
        </div>
        <div class="fam-group__actions">
          <button type="submit" class="fam-button fam-button--primary">
            {t.common.save}
          </button>
        </div>
      </Group>
    </form>
  );
}

export function SourcePage(props: {
  admin: SignedInAdmin;
  source: SourceSummary;
  /** The form of its Source Type, while that is enabled and can be loaded. */
  form: SourceForm | undefined;
  /** The Family's Members, whom it can be assigned to. */
  members: FamilyMemberSummary[];
  /** The IANA time zone the Family lives in, which times are shown in. */
  timeZone: string;
  problem?: string;
  /** Whether its Fix button was pressed: its form then opens in the dialog adding a Source uses. */
  fixing?: boolean;
  /** What the live setup steps of the Source being fixed show. */
  /** For a Source whose messages the LLM endpoint reads: how many wait to be read. */
  waiting?: number;
  /** Whether its plugin is asked for its Source Attributes once the page is shown, with a spinner meanwhile. */
  attributesOnDemand?: boolean;
}) {
  const { source, form } = props;
  const translation = useTranslation();
  const { t, text } = translation;
  const s = t.sources;
  const href = sourceHref(source.id);
  const { name, derived } = sourceLabel(source, form, translation);
  const suggestedSeconds = suggestedSecondsOf(form);
  const editable = editableOf(form, suggestedSeconds);
  const entry = entryOf(form, source);
  const dialog =
    props.fixing && form ? (
      <FixDialog
        source={source}
        form={form}
        closeHref={href}
        timeZone={props.timeZone}
        members={props.members}
      />
    ) : undefined;
  return (
    <AdminLayout
      title={name}
      admin={props.admin}
      current="sources"
      dialog={dialog}
    >
      <nav class="fam-breadcrumb" aria-label={s.breadcrumb}>
        <a href="/admin/sources">{s.title}</a> <span aria-hidden="true">›</span>{" "}
        <a href={sourceTypeHref(source.sourceTypeId)}>
          {text(source.displayName)}
        </a>{" "}
        <span aria-hidden="true">›</span>{" "}
        <span aria-current="page">{name}</span>
      </nav>
      <div id="source-health">
        <SourcePageHeader
          name={name}
          health={source.health}
          entry={entry}
          form={form}
          href={href}
          timeZone={props.timeZone}
          s={s}
          text={text}
        />
      </div>
      <SourceReadPoller source={source} waitedSeconds={0} />
      <Problem message={props.problem} />
      <section class="fam-sheet">
        {!form ? <p class="fam-problem">{s.notRead}</p> : null}
        <SourcePageForm
          source={source}
          form={form}
          members={props.members}
          editable={editable}
          href={href}
          derived={derived}
          t={t}
          s={s}
        />
        <div id="source-attributes-slot" data-edit-guard="">
          {props.attributesOnDemand && props.members.length > 0 ? (
            <AttributesLoading href={href} s={s} />
          ) : (
            <SourceAttributesForm
              source={source}
              members={props.members}
              href={href}
              t={t}
              s={s}
            />
          )}
        </div>
        <SourceTimelineSection
          source={source}
          href={href}
          s={s}
          waiting={props.waiting}
        />
        <SourceManagementSection href={href} s={s} />
      </section>
    </AdminLayout>
  );
}

/** A titled group of rows in a sheet, such as a Messenger's accounts; its heading at `level`. */
function Group(props: {
  title: string;
  level: 2 | 3 | 4;
  status?: Child;
  intro?: Child;
  children: Child;
}) {
  const Heading = `h${props.level}` as const;
  return (
    <section class="fam-group">
      {props.status ? (
        <div class="fam-group__heading">
          <Heading class="fam-group__title">{props.title}</Heading>
          {props.status}
        </div>
      ) : (
        <Heading class="fam-group__title">{props.title}</Heading>
      )}
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
function SourceRows(props: {
  sources: SourceSummary[];
  form: SourceForm | undefined;
  members: FamilyMemberSummary[];
  timeZone: string;
  /** Shown while there are none; null when `children` stand in for them. */
  empty: string | null;
  /** Rows after the Sources', such as those of Sources still being added. */
  children?: Child;
}) {
  if (props.sources.length === 0 && props.empty !== null)
    return <p class="fam-group__empty">{props.empty}</p>;
  return (
    <ul class="fam-rows">
      {props.sources.map((source) => (
        <SourceRow
          source={source}
          form={props.form}
          members={props.members}
          timeZone={props.timeZone}
        />
      ))}
      {props.children}
    </ul>
  );
}

/** The values of a Source's row its plugin offers, such as its chats' names, loaded right after the page. */
function PendingValues(props: {
  source: SourceSummary;
  form: SourceForm | undefined;
}) {
  const { t, text } = useTranslation();
  const pending = pendingChoiceFields(props.source, rowFields(props.form));
  if (pending.length === 0) return null;
  return (
    <LazyFragment href={`${sourceHref(props.source.id)}/values`}>
      <span class="fam-row__hint">
        {t.loading.choices(
          pending.map((field) => text(field.label)).join(", "),
        )}
      </span>
    </LazyFragment>
  );
}

/** A Source's row: what tells it apart, whom it concerns, its status, and a Fix button while it is Failing. */
function SourceRow(props: {
  source: SourceSummary;
  form: SourceForm | undefined;
  members: FamilyMemberSummary[];
  timeZone: string;
}) {
  const { source, form } = props;
  const translation = useTranslation();
  const s = translation.t.sources;
  const { name, meta } = sourceLabel(source, form, translation);
  const assigned = new Set(
    source.attributes.flatMap((attribute) => attribute.concerns),
  );
  const concerns = props.members
    .filter((member) => assigned.has(member.id))
    .map((member) => member.name);
  return (
    <li class="fam-row fam-row--link">
      <a class="fam-row__link" href={sourceHref(source.id)}>
        <span class="fam-row__main">
          <span class="fam-row__label">
            {name}
            {source.shown ? null : (
              <span class="fam-chip fam-chip--small">{s.hidden}</span>
            )}
          </span>
          {meta !== "" ? <span class="fam-row__hint">{meta}</span> : null}
          <PendingValues source={source} form={form} />
          {concerns.length > 0 ? (
            <span class="fam-row__hint">
              {s.concernsList(concerns.join(", "))}
            </span>
          ) : null}
          {/* Its page tells when it was last read; its row only once something went wrong. */}
          {hasHealthDetails(source.health) ? (
            <span class="fam-row__hint fam-health">
              <HealthDetails health={source.health} timeZone={props.timeZone} />
            </span>
          ) : null}
        </span>
        <HealthStatus health={source.health} />
        <Chevron />
      </a>
      {source.health.status === "failing" && form ? (
        <DialogLink
          class="fam-button fam-button--secondary"
          href={`${sourceHref(source.id)}/fix`}
        >
          {s.fix}
        </DialogLink>
      ) : null}
    </li>
  );
}

/**
 * A setting as a list row: its title, hints below it such as why it is locked, and its control,
 * such as a switch, at the end. Hints that are null are left out.
 */
function SettingRow(props: {
  title: Child;
  hints?: (Child | null)[];
  control: Child;
}) {
  return (
    <div class="fam-setting">
      <div class="fam-setting__text">
        {props.title}
        {(props.hints ?? []).map((hint) =>
          hint !== null ? <p class="fam-setting__hint">{hint}</p> : null,
        )}
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
function EnableSwitch(props: {
  id: string;
  name: string;
  action: string;
  enabled: boolean;
  locked: boolean;
}) {
  const { t } = useTranslation();
  return (
    <form
      method="post"
      action={`${props.action}/${props.enabled ? "disable" : "enable"}`}
      id={props.id}
      class="fam-row__form"
    >
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
        <input
          type="checkbox"
          name="riskAcknowledged"
          value="yes"
          form={props.form}
          required
        />{" "}
        {s.acknowledgeRisk}
      </label>
    </div>
  );
}

/** A row setting a polling interval in minutes, empty for the plugin's suggestion. */
function IntervalRow(props: {
  id: string;
  value: string | undefined;
  suggestedSeconds: number;
  hint: string;
  save?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li class="fam-row">
      <span class="fam-row__main">
        <label for={props.id} class="fam-row__label">
          {t.sources.interval}
        </label>
        <span class="fam-row__hint">{props.hint}</span>
      </span>
      <IntervalInput
        id={props.id}
        value={props.value}
        suggestedSeconds={props.suggestedSeconds}
      />
      {props.save ? (
        <button type="submit" class="fam-button fam-button--quiet">
          {t.common.save}
        </button>
      ) : null}
    </li>
  );
}

function IntervalInput(props: {
  id: string;
  value: string | undefined;
  suggestedSeconds: number;
}) {
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
function AddAtEntry(props: {
  form: SourceForm;
  entryId: string;
  name: string;
}) {
  const { form, entryId } = props;
  const { t } = useTranslation();
  const s = t.sources;
  const configKey = form.catalogue?.configKey;
  const nothingToFill = form.fields.every(
    (field) => field.key === configKey || field.choice,
  );
  if (!nothingToFill) {
    return (
      <DialogLink
        class="fam-button fam-button--quiet fam-button--add"
        href={`/admin/sources/new?type=${encodeURIComponent(form.sourceTypeId)}&entry=${encodeURIComponent(entryId)}`}
        aria-label={s.addAccountOf(props.name)}
      >
        {s.addAccount}
      </DialogLink>
    );
  }
  return (
    <form method="post" action="/admin/sources" class="fam-row__form">
      <input type="hidden" name="sourceTypeId" value={form.sourceTypeId} />
      <input type="hidden" name={`plain.${configKey}`} value={entryId} />
      <button
        type="submit"
        class="fam-button fam-button--quiet fam-button--add"
        aria-label={s.addAccountOf(props.name)}
      >
        {s.addAccount}
      </button>
    </form>
  );
}

/** The catalogue entry a Source being added uses, such as its Messenger, once it is chosen. */
function addedEntry(adding: SourceAdding) {
  const { catalogue } = adding.form;
  const chosen = catalogue
    ? adding.entered?.plain[catalogue.configKey]
    : undefined;
  return entryIn(adding.form, chosen);
}

/** The dialog a Fix button opens: the form adding a Source uses, filled in with the Source's settings. */
export function FixDialog(props: {
  source: SourceSummary;
  /** Why what was entered was refused, shown in the dialog loaded on its own. */
  problem?: string | undefined;
  /** What was entered then, shown again as it was entered. */
  entered?: { plain: Record<string, string>; interval: string } | undefined;
  form: SourceForm;
  closeHref: string;
  timeZone: string;
  members: FamilyMemberSummary[];
}) {
  const { source, form } = props;
  const { t, text } = useTranslation();
  const s = t.sources;
  return (
    <Dialog
      id="fix-source"
      eyebrow={s.fixEyebrow}
      title={text(source.displayName)}
      closeHref={props.closeHref}
    >
      <form
        {...dialogForm(`/admin/sources/${source.id}`)}
        class="fam-dialog__form"
      >
        <Problem message={props.problem} />
        <HealthLine health={source.health} timeZone={props.timeZone} />
        <SetupSteps form={form} sourceId={source.id} />
        <SourceFields
          form={form}
          prefix={`fix-${source.id}`}
          source={source}
          {...(props.entered ? { entered: props.entered } : {})}
          autofocus
        />
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
  members: FamilyMemberSummary[];
  timeZone: string;
}) {
  const { catalogue, form } = props;
  const usable = new Set(form?.catalogue?.entries?.map((entry) => entry.id));
  const { t, text } = useTranslation();
  const s = t.sourceTypes;
  const base = `${sourceTypeHref(catalogue.sourceTypeId)}/catalogue`;
  return (
    <section class="fam-type-section" aria-labelledby="catalogue-title">
      <h2 id="catalogue-title" class="fam-group__title">
        {text(catalogue.title)}
      </h2>
      <p class="fam-group__intro">{s.catalogueIntro}</p>
      <ProblemBanner title={s.catalogueFailed} message={catalogue.problem} />
      <ul class="fam-sheets">
        {catalogue.entries.map((entry) => (
          <CatalogueEntrySheet
            key={entry.id}
            entry={entry}
            base={base}
            form={form}
            usable={usable.has(entry.id)}
            accounts={props.sources.filter(
              (source) => source.plain[props.configKey] === entry.id,
            )}
            members={props.members}
            timeZone={props.timeZone}
          />
        ))}
      </ul>
    </section>
  );
}

/** One entry of a catalogue: its switch, and once enabled its accounts and polling interval. */
function CatalogueEntrySheet(props: {
  entry: CatalogueSummary["entries"][number];
  base: string;
  form: SourceForm | undefined;
  /** Whether a Source can be added at the entry. */
  usable: boolean;
  accounts: SourceSummary[];
  members: FamilyMemberSummary[];
  timeZone: string;
}) {
  const { entry, base, form, usable, accounts } = props;
  const { t, text } = useTranslation();
  const name = text(entry.displayName);
  const locked = entry.enabled && accounts.length > 0;
  return (
    <li class="fam-sheet">
      <SettingRow
        title={<h3 class="fam-sheet__title">{name}</h3>}
        hints={[
          text(entry.description),
          locked ? t.sourceTypes.entryLockedHint(name) : null,
        ]}
        control={
          <EntrySwitch entry={entry} base={base} name={name} locked={locked} />
        }
      />
      <EntryRisk entry={entry} />
      {entry.enabled ? (
        <>
          <EntryAccounts
            entry={entry}
            name={name}
            form={form}
            usable={usable}
            accounts={accounts}
            members={props.members}
            timeZone={props.timeZone}
          />
          <EntryInterval
            entry={entry}
            base={base}
            name={name}
            suggestedSeconds={
              form && usable ? form.suggestedIntervalSeconds : null
            }
          />
        </>
      ) : null}
    </li>
  );
}

/** What an Admin is warned of before enabling an entry that carries a risk. */
function EntryRisk(props: { entry: CatalogueSummary["entries"][number] }) {
  const { entry } = props;
  if (!entry.installed || entry.enabled || entry.riskNotice === null)
    return null;
  return <RiskNotice form={`enable-${entry.id}`} notice={entry.riskNotice} />;
}

/** The accounts of an enabled catalogue entry, with the means to add one. */
function EntryAccounts(props: {
  entry: CatalogueSummary["entries"][number];
  name: string;
  form: SourceForm | undefined;
  usable: boolean;
  accounts: SourceSummary[];
  members: FamilyMemberSummary[];
  timeZone: string;
}) {
  const { entry, name, form, usable, accounts } = props;
  const { t } = useTranslation();
  return (
    <Group title={t.sourceTypes.accounts} level={4}>
      <SourceRows
        sources={accounts}
        form={form}
        members={props.members}
        timeZone={props.timeZone}
        empty={t.sourceTypes.noAccounts}
      />
      {form && usable ? (
        <div class="fam-group__actions">
          <AddAtEntry form={form} entryId={entry.id} name={name} />
        </div>
      ) : null}
    </Group>
  );
}

/** The switch that enables a catalogue entry; one whose program is not installed cannot be. */
function EntrySwitch(props: {
  entry: CatalogueSummary["entries"][number];
  base: string;
  name: string;
  locked: boolean;
}) {
  const { entry, base, name, locked } = props;
  const { t } = useTranslation();
  if (!entry.installed)
    return <span class="fam-chip">{t.sourceTypes.notInstalled}</span>;
  return (
    <EnableSwitch
      id={`enable-${entry.id}`}
      name={name}
      action={`${base}/${entry.id}`}
      enabled={entry.enabled}
      locked={locked}
    />
  );
}

/** The interval the accounts of a catalogue entry are polled at; none where no account can be added. */
function EntryInterval(props: {
  entry: CatalogueSummary["entries"][number];
  base: string;
  name: string;
  suggestedSeconds: number | null;
}) {
  const { entry, base, name, suggestedSeconds } = props;
  const { t } = useTranslation();
  if (suggestedSeconds == null) return null;
  return (
    <Group title={t.sources.polling} level={4}>
      <form
        method="post"
        action={`${base}/${entry.id}/interval`}
        class="fam-sheet__form"
      >
        <ul class="fam-rows">
          <IntervalRow
            id={`interval-${entry.id}`}
            value={
              entry.pollIntervalSeconds !== null
                ? String(entry.pollIntervalSeconds / 60)
                : undefined
            }
            suggestedSeconds={suggestedSeconds}
            hint={t.sourceTypes.entryIntervalHint(name, suggestedSeconds / 60)}
            save
          />
        </ul>
      </form>
    </Group>
  );
}

/**
 * The interactive steps a plugin declares for its Sources, such as pairing an account. A live
 * step of an existing Source shows its progress too, such as the QR code to scan, each as its own
 * fragment loaded at once, so that the dialog does not wait for any of them.
 */
function SetupSteps(props: { form: SourceForm; sourceId?: string }) {
  const { text } = useTranslation();
  if (props.form.setupSteps.length === 0) return null;
  return (
    <ol class="fam-setup-steps">
      {props.form.setupSteps.map((step) => {
        const { sourceId } = props;
        return (
          <li>
            <strong>{text(step.title)}</strong>{" "}
            <span>{text(step.description)}</span>
            {sourceId !== undefined && step.live ? (
              <LazyFragment href={liveStepHref(sourceId, step.id)} block />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function liveStepHref(sourceId: string, stepId: string): string {
  return `/admin/sources/${sourceId}/setup/${encodeURIComponent(stepId)}`;
}

/** How often a live setup step asks its plugin again while it waits. */
const liveStepPollSeconds = 3;

/** How often the row of a Source being added asks again; most plugins answer within it. */
const addingPollSeconds = 1;

function stepMessage(
  message: MultilingualText | null,
  fallback: string,
  text: (t: MultilingualText) => string,
): string {
  return message !== null ? text(message) : fallback;
}

/** A Source being added in the background, whose adding failed, or added with setup steps to go on to. */
export type Adding = {
  id: string;
  progress:
    | { status: "running" | "added"; plain: Record<string, unknown> }
    | { status: "failed"; plain: Record<string, unknown>; message: string };
};

/** When the row of a Source being added asks again: one already added goes on at once. */
const addingTrigger = (status: "running" | "added") =>
  status === "added" ? "load" : `load delay:${addingPollSeconds}s`;

/**
 * The row of a Source being added: a spinner while its plugin prepares it, asking again every few
 * seconds until the page goes on; once that failed, why, with a button to fix what was entered.
 */
export function AddingRow(props: {
  adding: Adding;
  form: SourceForm | undefined;
}) {
  const { t, text } = useTranslation();
  const { id, progress } = props.adding;
  const href = `/admin/sources/adding/${encodeURIComponent(id)}`;
  const configKey = props.form?.catalogue?.configKey;
  const [name] = plainValues(
    props.form?.fields.filter(
      (field) => !field.secret && field.key !== configKey,
    ),
    progress.plain,
  );
  const label = name ?? (props.form ? text(props.form.displayName) : "");
  if (progress.status === "failed") {
    return (
      <li class="fam-row">
        <span class="fam-row__main">
          <span class="fam-row__label">{label}</span>
          <span class="fam-row__hint">{progress.message}</span>
        </span>
        <span class="fam-status fam-status--problem">
          {t.sources.status.failing}
        </span>
        <a class="fam-button fam-button--secondary" href={href}>
          {t.sources.fix}
        </a>
      </li>
    );
  }
  return (
    <li
      class="fam-row"
      hx-get={`${href}/row`}
      hx-trigger={addingTrigger(progress.status)}
      hx-swap="outerHTML"
      aria-live="polite"
    >
      <span class="fam-row__main">
        <span class="fam-row__label">{label}</span>
        <span class="fam-row__hint">{t.sources.settingUp}</span>
      </span>
      <span
        class="fam-spinner"
        role="status"
        aria-label={t.sources.settingUp}
      ></span>
    </li>
  );
}

/**
 * What a live setup step shows now. While it waits, it asks again every few seconds and replaces
 * itself, so that a QR code that expires is replaced by the next one; a poll that fails says so.
 */
export function LiveStepProgress(props: { step: LiveStep }) {
  const { sourceId, stepId, progress, qrSvg } = props.step;
  const { t, text } = useTranslation();
  const s = t.sources;
  if (progress.status === "waiting") {
    return (
      <LazyFragment
        href={liveStepHref(sourceId, stepId)}
        delaySeconds={liveStepPollSeconds}
        block
      >
        <div class="fam-live-step">
          {qrSvg !== null ? (
            <figure class="fam-qr" role="img" aria-label={s.qrCode}>
              {raw(qrSvg)}
            </figure>
          ) : null}
          <small>{stepMessage(progress.message, s.setupWaiting, text)}</small>
        </div>
      </LazyFragment>
    );
  }
  if (progress.status === "done") {
    return (
      <div class="fam-live-step" aria-live="polite">
        <span class="fam-status fam-status--ok">
          {stepMessage(progress.message, s.setupDone, text)}
        </span>
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
  const tone = { ok: "ok", failing: "problem", silent: "waiting" }[
    props.health.status
  ];
  const kind = props.chip ? "fam-chip" : "fam-status";
  return (
    <span class={`${kind} ${kind}--${tone}`}>
      {t.sources.status[props.health.status]}
    </span>
  );
}

/** Whether there is more to say of how a Source is doing than that it is OK. */
function hasHealthDetails(health: SourceHealth): boolean {
  return (
    health.status !== "ok" ||
    health.problem !== null ||
    health.invalidRecords.length > 0 ||
    health.unknownAttributes.length > 0
  );
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
  const problemText = problemTextOf(health.problem, s);
  return (
    <>
      {health.status === "silent" ? (
        <span>{s.silentHint(silentAfterMs / (24 * 60 * 60 * 1000))}</span>
      ) : null}
      <span>
        {health.lastSuccessAt
          ? s.lastRead(when(health.lastSuccessAt))
          : s.notReadYet}
      </span>
      {problemText !== null ? (
        <span class="fam-problem">{problemText}</span>
      ) : null}
      {health.invalidRecords.length > 0 ? (
        <span class="fam-problem">
          {s.invalidRecords(health.invalidRecords.length)}
        </span>
      ) : null}
      {health.unknownAttributes.length > 0 ? (
        <span class="fam-problem">
          {s.unknownAttributes(health.unknownAttributes.join(", "))}
        </span>
      ) : null}
    </>
  );
}

/**
 * A Source's name and what else tells it apart, from what an Admin set: the name they gave it, else
 * the one `derived` from its settings, its first plain setting such as its address, else its
 * catalogue entry's name such as its Messenger's, else its Source Type's; its plain settings not
 * already its name, what it is set to read among its choices, and how often it is
 * checked. Values the plugin sets, such as an account id, and secrets are left out. Without its
 * form, its Source Type no longer loading, it shows its plain settings as they are.
 */

function problemTextOf(
  problem: SourceHealth["problem"],
  s: Translation["t"]["sources"],
): string | null {
  if (problem === null) return null;
  if (problem.kind === "not-installed") return s.notInstalled;
  if (problem.kind === "not-loadable")
    return problem.reason === null
      ? s.cannotLoad
      : s.notLoadable(problem.reason);
  return s.lastError(problem.message);
}

function sourceLabel(
  source: SourceSummary,
  form: SourceForm | undefined,
  translation: Translation,
): { name: string; meta: string; derived: string } {
  const { t, text } = translation;
  const configKey = form?.catalogue?.configKey;
  const fields = rowFields(form);
  const [first, rest] = plainValues(fields, source.plain);
  const derived = derivedName(source, configKey, form, first, text);
  // Named by an Admin, its first setting, such as its address, still tells it apart.
  const name = source.name ?? derived;
  const shownFirst = source.name !== null && first !== undefined ? [first] : [];
  const chosen = chosenLabels(
    source,
    knownChoiceFields(source, fields),
    t,
    text,
  );
  const interval = sourceInterval(form, source, t);
  return {
    name,
    meta: [...shownFirst, ...rest, ...chosen, ...interval].join(" · "),
    derived,
  };
}

/** The Source's plain settings as strings, skipping choices and empty values: the first and the rest. */
function plainValues(
  fields: SourceForm["fields"] | undefined,
  plain: Record<string, unknown>,
): [string | undefined, string[]] {
  const shown = (value: unknown): value is string | number =>
    (typeof value === "string" && value !== "") || typeof value === "number";
  const values = (
    fields
      ? fields.filter((field) => !field.choice).map((field) => plain[field.key])
      : Object.values(plain)
  )
    .filter(shown)
    .map(String);
  return [values[0], values.slice(1)];
}

/** The name a Source derives from its settings: its first plain value, or its catalogue entry's name, or its display name. */
function derivedName(
  source: SourceSummary,
  configKey: string | undefined,
  form: SourceForm | undefined,
  first: string | undefined,
  text: Translation["text"],
): string {
  const entry =
    configKey !== undefined
      ? entryIn(form, source.plain[configKey])
      : undefined;
  return first ?? text(entry?.displayName ?? source.displayName);
}

/** How often a Source is polled, for its meta: not shown for catalogue entries, which poll at the entry's interval. */
function sourceInterval(
  form: SourceForm | undefined,
  source: SourceSummary,
  t: Translation["t"],
): string[] {
  const seconds = form?.catalogue
    ? null
    : (source.pollIntervalSeconds ?? form?.suggestedIntervalSeconds ?? null);
  return seconds !== null ? [t.sources.every(seconds / 60)] : [];
}

/**
 * The choice fields whose labels need what the plugin offers, such as the chats chosen by id, while
 * those values were not asked for: a Source's row loads them as a fragment instead.
 */
function pendingChoiceFields(
  source: SourceSummary,
  fields: SourceForm["fields"] | undefined,
): SourceForm["fields"] {
  return source.choices !== undefined
    ? []
    : choiceFieldsWithValues(source, fields);
}

/** The choice fields with values chosen, whose labels need what the plugin offers. */
function choiceFieldsWithValues(
  source: SourceSummary,
  fields: SourceForm["fields"] | undefined,
): SourceForm["fields"] {
  return (fields ?? []).filter(
    (field) => field.choice && chosenOf(source, field.key).length > 0,
  );
}

/** The fields whose labels can be told now, without the values a plugin offers. */
function knownChoiceFields(
  source: SourceSummary,
  fields: SourceForm["fields"] | undefined,
): SourceForm["fields"] {
  const pending = pendingChoiceFields(source, fields);
  return (fields ?? []).filter((field) => !pending.includes(field));
}

/** The fields of a Source's form that show in its row, as `sourceLabel` takes them. */
function rowFields(
  form: SourceForm | undefined,
): SourceForm["fields"] | undefined {
  const configKey = form?.catalogue?.configKey;
  return form?.fields.filter(
    (field) => !field.secret && field.key !== configKey,
  );
}

/**
 * What a Source's row tells of its choices once its plugin offered their values, such as the chats
 * it reads by name, as the fragment its row loads; why the plugin could not offer them otherwise.
 */
export function SourceValues(props: {
  source: SourceSummary;
  form: SourceForm | undefined;
}) {
  const { source } = props;
  const { t, text } = useTranslation();
  const fields = choiceFieldsWithValues(source, rowFields(props.form));
  const offered = fields.filter(
    (field) => choiceProblemOf(source, field.key) === null,
  );
  const labels = chosenLabels(source, offered, t, text);
  return (
    <>
      {labels.length > 0 ? (
        <span class="fam-row__hint">{labels.join(" · ")}</span>
      ) : null}
      {fields.map((field) => {
        const problem = choiceProblemOf(source, field.key);
        return problem !== null ? (
          <FragmentError
            title={`${text(field.label)}: ${t.sources.choicesFailed}`}
            message={problem}
          />
        ) : null;
      })}
    </>
  );
}

function chosenLabels(
  source: SourceSummary,
  fields: SourceForm["fields"] | undefined,
  t: Translation["t"],
  text: Translation["text"],
): string[] {
  return (fields ?? [])
    .filter((field) => field.choice)
    .map((field) => {
      const stored = source.plain[field.key];
      const values = Array.isArray(stored)
        ? stored.filter((value) => typeof value === "string")
        : [];
      const labels = values.map(
        (value) =>
          offeredOf(source, field.key).find((choice) => choice.value === value)
            ?.label ?? value,
      );
      return `${text(field.label)}: ${labels.length > 0 ? labels.join(", ") : t.sources.noneChosen}`;
    });
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
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : undefined;
  };
  const interval = entered
    ? entered.interval || undefined
    : source?.pollIntervalSeconds != null
      ? String(source.pollIntervalSeconds / 60)
      : undefined;
  return (
    <>
      {form.fields.map((field, index) => {
        const stored =
          field.secret && source?.storedSecrets.includes(field.key);
        const focus = props.autofocus === true && index === 0;
        if (form.catalogue?.configKey === field.key) {
          if (props.omitFixed && source) return null;
          return (
            <CatalogueField
              field={field}
              form={form}
              id={id(field.key)}
              chosen={plainValue(field.key)}
              existing={source !== undefined}
              autofocus={focus}
            />
          );
        }
        if (field.choice)
          return (
            <ChoiceField field={field} id={id(field.key)} source={source} />
          );
        return (
          <div class="fam-field">
            <label for={id(field.key)}>
              {field.required
                ? text(field.label)
                : t.common.optional(text(field.label))}
            </label>
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
              <input
                id={id(field.key)}
                name={`plain.${field.key}`}
                autofocus={focus}
                required={field.required}
                value={plainValue(field.key)}
              />
            )}
            {field.description ? (
              <small>{text(field.description)}</small>
            ) : null}
          </div>
        );
      })}
      {form.suggestedIntervalSeconds !== null && !form.catalogue ? (
        <div class="fam-field">
          <label for={id("interval")}>{t.sources.interval}</label>
          <IntervalInput
            id={id("interval")}
            value={interval}
            suggestedSeconds={form.suggestedIntervalSeconds}
          />
          <small>
            {t.sources.intervalHint(form.suggestedIntervalSeconds / 60)}
          </small>
        </div>
      ) : null}
    </>
  );
}

function catalogueEntries(
  form: SourceForm,
): { id: string; displayName: MultilingualText }[] {
  return form.catalogue?.entries ?? [];
}

function CatalogueSelect(props: {
  entries: { id: string; displayName: MultilingualText }[];
  id: string;
  fieldKey: string;
  chosen: string | undefined;
  autofocus: boolean;
  description: MultilingualText | null;
  sourceTypeId: string;
}) {
  const {
    entries,
    id,
    fieldKey,
    chosen,
    autofocus,
    description,
    sourceTypeId,
  } = props;
  const { t, text } = useTranslation();
  return (
    <>
      {entries.length === 0 ? (
        <p class="fam-problem">
          {t.sources.noEntries((label) => (
            <a href={sourceTypeHref(sourceTypeId)}>{label}</a>
          ))}
        </p>
      ) : (
        <select
          id={id}
          name={`plain.${fieldKey}`}
          required
          autofocus={autofocus}
        >
          {entries.map((entry) => (
            <option value={entry.id} selected={entry.id === chosen}>
              {text(entry.displayName)}
            </option>
          ))}
        </select>
      )}
      {description ? <small>{text(description)}</small> : null}
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
  const { field, form, id, chosen, existing, autofocus } = props;
  const { text } = useTranslation();
  const entries = catalogueEntries(form);
  const label = <label for={id}>{text(field.label)}</label>;
  const entry = entries.find((candidate) => candidate.id === chosen);
  // Added at its entry, the dialog is titled after it, so the field needs no showing.
  if (entry && !existing)
    return <input type="hidden" name={`plain.${field.key}`} value={entry.id} />;
  if (existing) {
    return (
      <div class="fam-field">
        {label}
        <input
          id={id}
          value={entry ? text(entry.displayName) : chosen}
          disabled
        />
      </div>
    );
  }
  return (
    <div class="fam-field">
      {label}
      <CatalogueSelect
        entries={entries}
        id={id}
        fieldKey={field.key}
        chosen={chosen}
        autofocus={autofocus}
        description={field.description}
        sourceTypeId={form.sourceTypeId}
      />
    </div>
  );
}

function fieldLabel(
  field: SourceForm["fields"][number],
  t: Translation["t"],
  text: (t: MultilingualText) => string,
): string {
  return field.required
    ? text(field.label)
    : t.common.optional(text(field.label));
}

function chosenOf(source: ChoiceSource, key: string): string[] {
  const stored = source.plain[key];
  return Array.isArray(stored)
    ? stored.filter((value): value is string => typeof value === "string")
    : [];
}

/** What the plugin offers for a choice field; none where asking it failed. */
function offeredOf(
  source: ChoiceSource,
  key: string,
): { value: string; label: string }[] {
  const answer = source.choices?.[key];
  return answer?.ok ? answer.value : [];
}

/** Why the plugin offers nothing for a choice field; null if it answered. Kept apart from ChoiceField for its CRAP score. */
function choiceProblemOf(source: ChoiceSource, key: string): string | null {
  const answer = source.choices?.[key];
  return answer?.ok === false ? answer.message : null;
}

function optionsOf(
  source: ChoiceSource,
  key: string,
  chosen: string[],
): { value: string; label: string }[] {
  const offered = offeredOf(source, key);
  return [
    ...offered,
    ...chosen
      .filter((value) => !offered.some((choice) => choice.value === value))
      .map((value) => ({ value, label: value })),
  ];
}

type ChoiceFieldSpec = SourceForm["fields"][number];

/** What a choice field shows of a Source: the values chosen, and those its plugin offered, if asked. */
type ChoiceSource = Pick<SourceSummary, "id" | "plain" | "choices">;

/** Where a choice field that loads on its own keeps its stored selection meanwhile. */
const keptId = (id: string) => `${id}-kept`;

/**
 * A choice field while its plugin is asked for its values: disabled, with a spinner. Its stored
 * selection is sent as it is if the form is saved meanwhile, from hidden inputs beside the fragment,
 * so that they stay if it fails to load; the loaded field removes them (`LoadedChoiceField`).
 */
function ChoiceLoading(props: {
  field: ChoiceFieldSpec;
  id: string;
  source: ChoiceSource;
  chosen: string[];
  label: string;
}) {
  const { field, chosen } = props;
  const { t, text } = useTranslation();
  return (
    <>
      <div id={keptId(props.id)} hidden>
        <input type="hidden" name={`choice.${field.key}`} value="" />
        {chosen.map((value) => (
          <input type="hidden" name={`choice.${field.key}`} value={value} />
        ))}
      </div>
      <LazyFragment
        href={`${sourceHref(props.source.id)}/choices/${encodeURIComponent(field.key)}?id=${encodeURIComponent(props.id)}`}
        block
      >
        <fieldset class="fam-field" disabled aria-busy="true">
          <legend>{props.label}</legend>
          <small>
            <span class="fam-spinner" aria-hidden="true"></span>{" "}
            {t.loading.choices(text(field.label))}
          </small>
        </fieldset>
      </LazyFragment>
    </>
  );
}

/**
 * One choice field of a Source with the values its plugin offered, as the fragment its form loads:
 * its checkboxes take over from the hidden inputs that kept its selection, which it removes.
 */
export function LoadedChoiceField(props: {
  field: ChoiceFieldSpec;
  id: string;
  source: ChoiceSource;
}) {
  return (
    <>
      <ChoiceField {...props} />
      <div id={keptId(props.id)} hx-swap-oob="delete"></div>
    </>
  );
}

/**
 * A choice among what the plugin offers for an existing Source, such as the chats to read: one
 * checkbox each, the chosen ones ticked, also those it no longer offers. A Source being added has
 * none to offer yet.
 */
function ChoiceField(props: {
  field: ChoiceFieldSpec;
  id: string;
  source: ChoiceSource | undefined;
}) {
  const { field, source } = props;
  const { t, text } = useTranslation();
  const label = fieldLabel(field, t, text);
  if (!source) {
    return (
      <div class="fam-field">
        <span class="fam-field__label">{label}</span>
        <small>{t.sources.choicesAfterSetup}</small>
      </div>
    );
  }
  const chosen = chosenOf(source, field.key);
  // Its values were not asked for with the page: they load on their own, its selection kept meanwhile.
  if (source.choices?.[field.key] === undefined)
    return (
      <ChoiceLoading
        field={field}
        id={props.id}
        source={source}
        chosen={chosen}
        label={label}
      />
    );
  const options = optionsOf(source, field.key, chosen);
  const problem = choiceProblemOf(source, field.key);
  return (
    <fieldset class="fam-field" id={props.id}>
      <legend>{label}</legend>
      {/* Sent with nothing ticked too, so that unticking every box clears the choice. */}
      <input type="hidden" name={`choice.${field.key}`} value="" />
      <ProblemBanner title={t.sources.choicesFailed} message={problem} />
      {options.length === 0 && problem === null ? (
        <small>{t.sources.noChoices}</small>
      ) : null}
      {options.map((option) => (
        <label>
          <input
            type="checkbox"
            name={`choice.${field.key}`}
            value={option.value}
            checked={chosen.includes(option.value)}
          />{" "}
          {option.label}
        </label>
      ))}
      {field.description ? <small>{text(field.description)}</small> : null}
    </fieldset>
  );
}

export function LlmEndpointPage(props: {
  admin: SignedInAdmin;
  endpoint: LlmEndpointSummary | null;
  /** The OCR languages, which read what the endpoint's model cannot. */
  languages: LanguageSettings;
  /** How many messages wait to be read. */
  waiting: number;
  /** What the Admin entered, shown again with a problem. */
  entered?: { baseUrl: string; model: string };
  problem?: string;
}) {
  const { endpoint } = props;
  const shown = props.entered ?? endpoint;
  const { t } = useTranslation();
  const l = t.llm;
  return (
    <AdminLayout title={l.title} admin={props.admin} current="llm">
      {/* The status comes with the models, which `/admin/llm/status` loads after the page. */}
      <SectionHeader
        title={l.title}
        status={<span id="llm-status"></span>}
        description={l.description}
      />
      <Problem message={props.problem} />
      <form method="post" action="/admin/llm" class="fam-sheet fam-sheet__form">
        <Group title={l.connection} level={2}>
          <ConnectionFields shown={shown} endpoint={endpoint} />
        </Group>
        <OptionsGroup configured={endpoint !== null} />
      </form>
      {endpoint ? (
        <form method="post" action="/admin/llm/remove" id="remove-llm" />
      ) : null}
      {endpoint && props.waiting > 0 ? (
        <section class="fam-sheet">
          <WaitingGroup label={l.waitingTitle} waiting={props.waiting} />
        </section>
      ) : null}
      <OcrSections languages={props.languages} />
    </AdminLayout>
  );
}

/** What `/admin/llm/status` answers: the saved endpoint's models to choose from, and its status in the header. */
export function LlmStatusFragment(props: {
  shown: { model: string };
  check: EndpointCheck;
}) {
  return (
    <>
      <ModelField shown={props.shown} check={props.check} oob />
      <LlmHealthStatus ok={props.check.ok} tested={false} />
    </>
  );
}

/** What testing the entered endpoint answers: the model field, and the header chip saying it is a test's result. */
export function LlmTestFragment(props: {
  shown: { model: string };
  check: EndpointCheck;
}) {
  return (
    <>
      <ModelField shown={props.shown} check={props.check} tested />
      <LlmHealthStatus ok={props.check.ok} tested />
    </>
  );
}

/** The header chip, swapped in out of band. */
function LlmHealthStatus(props: { ok: boolean; tested: boolean }) {
  const l = useTranslation().t.llm;
  const text = props.tested
    ? props.ok
      ? l.testOk
      : l.testFailing
    : props.ok
      ? l.statusOk
      : l.statusFailing;
  return (
    <span id="llm-status" hx-swap-oob="true">
      <span
        class={
          props.ok ? "fam-chip fam-chip--ok" : "fam-chip fam-chip--problem"
        }
      >
        {text}
      </span>
    </span>
  );
}

/** A problem, such as why asking a Source Type's plugin failed, where what it would have answered is shown. */
function ProblemBanner(props: { title: string; message: string | null }) {
  if (props.message === null) return null;
  return (
    <div class="fam-banner fam-banner--problem" role="status">
      <span class="fam-banner__glyph" aria-hidden="true">
        !
      </span>
      <span class="fam-banner__title">{props.title}</span>
      <div class="fam-banner__body">{props.message}</div>
    </div>
  );
}

function ConnectionFields(props: {
  shown: { baseUrl: string; model: string } | null;
  endpoint: LlmEndpointSummary | null;
}) {
  const { t } = useTranslation();
  const l = t.llm;
  const { shown, endpoint } = props;
  const model = { model: shown?.model ?? "" };
  // Only the saved endpoint's status is known; other entered values are not tested yet.
  const saved =
    endpoint !== null && (shown === null || shown.baseUrl === endpoint.baseUrl);
  return (
    <>
      {/* Edited fields mark the guard, so that the late status does not overwrite them. */}
      <div class="fam-group__fields" id="llm-connection" data-edit-guard="">
        <div class="fam-field">
          <label for="baseUrl">{l.baseUrl}</label>
          <input
            id="baseUrl"
            name="baseUrl"
            type="url"
            required
            value={shown?.baseUrl}
          />
          <small>{l.baseUrlHint}</small>
        </div>
        <ModelField shown={model} check={saved ? "loading" : null} />
        <ApiKeyFields endpoint={endpoint} />
        <TestConnectionButton />
      </div>
      {saved ? <StatusLoader model={model.model} /> : null}
    </>
  );
}

/**
 * Loads the saved endpoint's status after the page, which swaps in the model field and the header
 * chip out of band; dropped once a field was edited or a test ran (`editGuards`). Empty, so that
 * a failing request leaves the fields as they are.
 */
function StatusLoader(props: { model: string }) {
  const href = props.model
    ? `/admin/llm/status?model=${encodeURIComponent(props.model)}`
    : "/admin/llm/status";
  return (
    <div
      id="llm-status-loader"
      hx-get={href}
      hx-trigger="load"
      hx-swap="none"
      data-unless-edited="#llm-connection"
    ></div>
  );
}

/** Asks the entered URL with the entered API key, swapping in the model field with what it answered. */
function TestConnectionButton() {
  const { t } = useTranslation();
  return (
    <div class="fam-field">
      <button
        type="button"
        class="fam-button"
        hx-post="/admin/llm/test"
        hx-include="#baseUrl, #apiKey, #model"
        hx-target="#model-field"
        hx-swap="outerHTML"
        hx-disabled-elt="this, #model"
        hx-indicator="#llm-testing"
      >
        {t.llm.testConnection}
      </button>
      <span id="llm-testing" class="htmx-indicator" role="status">
        <span class="fam-spinner" aria-hidden="true"></span> {t.llm.testing}
      </span>
    </div>
  );
}

/** What the model field knows of the endpoint: what it answered, that it is being asked, or not yet tested (null). */
type ModelCheck = EndpointCheck | "loading" | null;

/**
 * The model field: a choice among the models `check` found, or text, with why there is no choice:
 * the endpoint is not tested yet (null), is being asked, lists none, or failed. `tested` says that
 * the Admin asked, so that it says it connected.
 */
export function ModelField(props: {
  shown: { model: string };
  check: ModelCheck;
  tested?: boolean;
  oob?: boolean;
}) {
  const { t } = useTranslation();
  const { shown, check } = props;
  const answer = typeof check === "object" ? check : null;
  const models = answer?.ok ? answer.models : [];
  const problem = answer && !answer.ok ? answer.message : null;
  return (
    <div
      class="fam-field"
      id="model-field"
      hx-swap-oob={props.oob ? "true" : undefined}
    >
      <label for="model">{t.llm.model}</label>
      <ProblemBanner title={t.llm.connectionError} message={problem} />
      {models.length > 0 ? (
        <select id="model" name="model" required>
          {/* A model the endpoint no longer lists stays selectable, so saving does not change it. */}
          {withChosen(models, shown.model).map((model) => (
            <option value={model} selected={model === shown.model}>
              {model}
            </option>
          ))}
        </select>
      ) : (
        <input id="model" name="model" required value={shown.model} />
      )}
      <ModelNote check={check} tested={props.tested === true} />
    </div>
  );
}

function ModelNote(props: { check: ModelCheck; tested: boolean }) {
  const l = useTranslation().t.llm;
  const note = modelNoteOf(l, props.check, props.tested);
  return note === null ? null : <small role="status">{note}</small>;
}

function modelNoteOf(
  l: Catalogue["llm"],
  check: ModelCheck,
  tested: boolean,
): string | null {
  if (check === null) return l.modelsAfterTest;
  if (check === "loading") return l.loadingModels;
  if (!check.ok) return l.modelsFailed;
  if (check.models.length === 0) return l.noModels;
  return tested ? l.connected(check.models.length) : null;
}

/** The models offered, with the chosen one even where the endpoint no longer lists it. */
function withChosen(models: string[], chosen: string | undefined): string[] {
  return chosen && !models.includes(chosen) ? [chosen, ...models] : models;
}

function ApiKeyFields(props: { endpoint: LlmEndpointSummary | null }) {
  const { t } = useTranslation();
  const { endpoint } = props;
  return (
    <>
      <div class="fam-field">
        <label for="apiKey">{t.llm.apiKey}</label>
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
          <input type="checkbox" name="removeApiKey" value="yes" />{" "}
          {t.llm.removeApiKey}
        </label>
      ) : null}
    </>
  );
}

function OptionsGroup(props: { configured: boolean }) {
  const { t } = useTranslation();
  const l = t.llm;
  return (
    <Group title={l.options} level={2}>
      <div class="fam-group__fields">
        <label>
          <input type="checkbox" name="thirdPartiesAcknowledged" value="yes" />{" "}
          {l.thirdParties}
        </label>
      </div>
      <div class="fam-group__actions">
        {props.configured ? (
          <button
            type="submit"
            form="remove-llm"
            class="fam-button fam-button--danger"
            formnovalidate
          >
            {l.remove}
          </button>
        ) : null}
        <button type="submit" class="fam-button fam-button--primary">
          {t.common.save}
        </button>
      </div>
    </Group>
  );
}

/** How many messages wait to be read, if any do. */
function WaitingGroup(props: { label: string; waiting: number }) {
  const { t } = useTranslation();
  if (props.waiting === 0) return null;
  return (
    <Group title={props.label} level={2}>
      <ul class="fam-rows">
        <li class="fam-row">
          <span class="fam-row__main">
            <span class="fam-row__hint">{t.llm.waiting(props.waiting)}</span>
          </span>
        </li>
      </ul>
    </Group>
  );
}

/** A form that posts one OCR language to an action, as its one button. */
function OcrLanguageButton(props: {
  action: string;
  language?: OcrLanguage;
  label: string;
}) {
  return (
    <form method="post" action={props.action} class="fam-row__form">
      {props.language ? (
        <input type="hidden" name="language" value={props.language} />
      ) : null}
      <button type="submit" class="fam-button fam-button--quiet">
        {props.label}
      </button>
    </form>
  );
}

/** The OCR section: its switch, and while it is on the languages with their models. */
function OcrSections(props: { languages: LanguageSettings }) {
  const { languages } = props;
  const { t } = useTranslation();
  const l = t.ocr;
  return (
    <section class="fam-sheet">
      <Group title={l.title} level={2} intro={l.ocrIntro}>
        <ul class="fam-rows">
          <li class="fam-row">
            <span class="fam-row__main">
              <span class="fam-row__label" id="ocr-enabled">
                {l.enable}
              </span>
              <span class="fam-row__hint">{l.enableHint}</span>
            </span>
            <form
              method="post"
              action="/admin/llm/ocr/enabled"
              class="fam-row__form"
            >
              <input
                type="hidden"
                name="ocr"
                value={languages.ocrEnabled ? "no" : "yes"}
              />
              <button
                type="submit"
                role="switch"
                aria-checked={languages.ocrEnabled ? "true" : "false"}
                aria-labelledby="ocr-enabled"
                class="fam-switch"
              ></button>
            </form>
          </li>
        </ul>
        {languages.ocrEnabled ? (
          <OcrLanguageList languages={languages} />
        ) : null}
      </Group>
    </section>
  );
}

/** The OCR languages in the order Tesseract tries them, with what adds, orders and removes them. */
function OcrLanguageList(props: { languages: LanguageSettings }) {
  const { languages } = props;
  const { t, locale, ocrLanguageName } = useTranslation();
  const l = t.ocr;
  const byName = (a: OcrLanguage, b: OcrLanguage) =>
    ocrLanguageName(a).localeCompare(ocrLanguageName(b), locale);
  const addable = [...languages.addable].sort(byName);
  return (
    <>
      <ul class="fam-rows">
        {languages.ocrLanguages.map((ocr, index) => (
          <li class="fam-row">
            <span class="fam-row__main">
              <span class="fam-row__label">
                {ocrLanguageName(ocr.language)}
              </span>
              {ocr.installed ? (
                <span class="fam-row__hint">{l.tried(index + 1)}</span>
              ) : (
                <span class="fam-status fam-status--waiting">
                  {l.notInstalled}
                </span>
              )}
            </span>
            {ocr.installed ? null : (
              <OcrLanguageButton
                action="/admin/llm/ocr"
                language={ocr.language}
                label={l.downloadLanguage(ocrLanguageName(ocr.language))}
              />
            )}
            {index > 0 ? (
              <OcrLanguageButton
                action={`/admin/llm/ocr/${ocr.language}/up`}
                label={l.moveUp}
              />
            ) : null}
            {languages.ocrLanguages.length > 1 ? (
              <OcrLanguageButton
                action={`/admin/llm/ocr/${ocr.language}/remove`}
                label={l.remove}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {languages.ocrLanguages.some((ocr) => !ocr.installed) ? (
        <p class="fam-problem">{l.missingModel}</p>
      ) : null}
      {addable.length > 0 ? (
        <form method="post" action="/admin/llm/ocr" class="fam-inline-add">
          <label for="add-ocr">{l.addLanguage}</label>
          <div class="fam-inline-add__controls">
            <select id="add-ocr" name="language">
              {addable.map((language) => (
                <option value={language}>{ocrLanguageName(language)}</option>
              ))}
            </select>
            <button
              type="submit"
              class="fam-button fam-button--quiet fam-button--add"
            >
              {l.add}
            </button>
          </div>
          <small>
            {l.addHint((code) => (
              <code>{code}</code>
            ))}
          </small>
        </form>
      ) : null}
    </>
  );
}

/** How the pages look in a browser, which each browser keeps for itself. */
const themes = ["system", "light", "dark"] as const;

type SingleSignOnShown = {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  requiredGroup: string;
  publicBaseUrl: string;
};

/** What is saved, or the starting point where nothing is. */
function savedSingleSignOn(
  current: SingleSignOnSummary | null,
  suggestedBaseUrl: string,
): SingleSignOnSummary {
  return (
    current ?? {
      enabled: false,
      issuerUrl: "",
      clientId: "",
      hasClientSecret: false,
      requiredGroup: defaultRequiredGroup,
      publicBaseUrl: suggestedBaseUrl,
      redirectUri: suggestedBaseUrl + singleSignOnCallbackPath,
    }
  );
}

/** The single sign-on section: the Identity Provider Admins may sign in through. */
export function SingleSignOnPage(props: {
  admin: SignedInAdmin;
  current: SingleSignOnSummary | null;
  /** What the Admin entered, shown again with a problem. */
  entered?: SingleSignOnShown;
  problem?: string;
  /** The origin of this request, suggested as the public base URL where none is saved. */
  suggestedBaseUrl: string;
}) {
  const { t } = useTranslation();
  const o = t.sso;
  const saved = savedSingleSignOn(props.current, props.suggestedBaseUrl);
  const shown = props.entered ?? saved;
  return (
    <AdminLayout title={o.title} admin={props.admin} current="sso">
      <SectionHeader title={o.title} description={o.description} />
      <Problem message={props.problem} />
      <form method="post" action="/admin/sso" class="fam-sheet fam-sheet__form">
        <Group title={o.title} level={2}>
          <div class="fam-group__fields">
            <label>
              <input
                type="checkbox"
                name="enabled"
                value="yes"
                checked={shown.enabled}
              />{" "}
              {o.enabled}
            </label>
            <div class="fam-field">
              <label for="issuerUrl">{o.issuerUrl}</label>
              <input
                id="issuerUrl"
                name="issuerUrl"
                type="url"
                required
                value={shown.issuerUrl}
              />
              <small>{o.issuerUrlHint}</small>
            </div>
            <div class="fam-field">
              <label for="clientId">{o.clientId}</label>
              <input
                id="clientId"
                name="clientId"
                required
                autocomplete="off"
                value={shown.clientId}
              />
            </div>
            <div class="fam-field">
              <label for="clientSecret">{o.clientSecret}</label>
              <input
                id="clientSecret"
                name="clientSecret"
                type="password"
                autocomplete="off"
                placeholder={
                  saved.hasClientSecret ? t.common.storedSecret : undefined
                }
              />
            </div>
            <div class="fam-field">
              <label for="requiredGroup">{o.requiredGroup}</label>
              <input
                id="requiredGroup"
                name="requiredGroup"
                required
                value={shown.requiredGroup}
              />
              <small>{o.requiredGroupHint}</small>
            </div>
            <div class="fam-field">
              <label for="publicBaseUrl">{o.publicBaseUrl}</label>
              <input
                id="publicBaseUrl"
                name="publicBaseUrl"
                type="url"
                required
                value={shown.publicBaseUrl}
              />
              <small>{o.publicBaseUrlHint}</small>
            </div>
            <div class="fam-field">
              <label for="redirectUri">{o.redirectUri}</label>
              <input
                id="redirectUri"
                type="text"
                readonly
                value={shown.publicBaseUrl + singleSignOnCallbackPath}
              />
              <small>{o.redirectUriHint}</small>
            </div>
            <div class="fam-field">
              <label for="scopes">{o.scopes}</label>
              <input
                id="scopes"
                type="text"
                readonly
                value="openid email profile groups"
              />
            </div>
          </div>
          <div class="fam-group__actions">
            <button type="submit" class="fam-button fam-button--primary">
              {t.common.save}
            </button>
          </div>
        </Group>
      </form>
    </AdminLayout>
  );
}

/** The Display section: the Family Language, and the Theme of this browser. */
export function DisplayPage(props: {
  admin: SignedInAdmin;
  family: FamilyLanguage;
  problem?: string;
}) {
  const { t } = useTranslation();
  const d = t.display;
  return (
    <AdminLayout title={d.title} admin={props.admin} current="display">
      <SectionHeader title={d.title} description={d.description} />
      <Problem message={props.problem} />
      <form
        method="post"
        action="/admin/display"
        class="fam-sheet fam-sheet__form"
      >
        <Group title={d.familyLanguage} level={2}>
          <div class="fam-group__fields">
            <div class="fam-field">
              {/* The group's title names it already. */}
              <label for="language" class="fam-visually-hidden">
                {d.familyLanguage}
              </label>
              <select id="language" name="language">
                <FamilyLanguageOptions selected={props.family} />
              </select>
              <small>{d.familyLanguageHint}</small>
            </div>
          </div>
          <div class="fam-group__actions">
            <button type="submit" class="fam-button fam-button--primary">
              {t.common.save}
            </button>
          </div>
        </Group>
      </form>

      <section class="fam-sheet">
        <Group title={d.theme} level={2}>
          <div class="fam-group__fields">
            <div class="fam-field">
              {/* Saved in this browser as soon as it changes, so that there is no form. */}
              <label for="theme" class="fam-visually-hidden">
                {d.theme}
              </label>
              <select id="theme" data-theme-select>
                {themes.map((theme) => (
                  <option value={theme}>{d.themeOptions[theme]}</option>
                ))}
              </select>
              <small>{d.themeHint}</small>
            </div>
          </div>
        </Group>
      </section>
    </AdminLayout>
  );
}

export function MessagePage(props: {
  admin: SignedInAdmin;
  message: MessageDetails;
  items: MessageItemRows;
  timeZone: string;
}) {
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
        {message.sender !== null ? (
          <>
            <dt>{m.sender}</dt>
            <dd>{message.sender}</dd>
          </>
        ) : null}
        {message.subject !== null ? (
          <>
            <dt>{m.subject}</dt>
            <dd>{message.subject}</dd>
          </>
        ) : null}
        {message.attributes.length > 0 ? (
          <>
            <dt>{m.attributes}</dt>
            <dd>{message.attributes.join(", ")}</dd>
          </>
        ) : null}
      </dl>
      {message.purgedAt !== null ? (
        <p>{m.purged}</p>
      ) : (
        <pre class="fam-message">{message.text}</pre>
      )}
      {message.attachments.length > 0 ? (
        <>
          <h2>{m.attachments}</h2>
          <ul>
            {message.attachments.map((attachment) => (
              <li>
                <a
                  href={`/admin/messages/${message.id}/attachments/${attachment.position}`}
                  download={attachment.filename}
                >
                  {attachment.filename}
                </a>{" "}
                {m.attachment(
                  attachment.contentType,
                  Math.ceil(attachment.size / 1024),
                )}
                {attachment.conversionProblem !== null ? (
                  <p class="fam-problem">
                    {m.unreadable(attachment.conversionProblem)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <MessageItems messageId={message.id} items={props.items} />
    </AdminLayout>
  );
}
