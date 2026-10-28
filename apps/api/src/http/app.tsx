import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  type RuleInput,
  type SourceInput,
  type SourceSummary,
  type Showing,
  type TimelineDays,
  type ViewAccessPolicy,
} from "@family-agenda/application";
import {
  defaultFamilyLanguage,
  isAcceptableTimelineRange,
  isFamilyLanguage,
  isLocalDate,
  maximumPhotoBytes,
  type AdminId,
  type AttributionRuleId,
  type FamilyLanguage,
  type FamilyMemberId,
  type RawMessageId,
  type SourceId,
  type ViewId,
} from "@family-agenda/domain";
import type { HealthResponse } from "@family-agenda/contracts";
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import QRCode from "qrcode";
import type { Child } from "hono/jsx";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import { sessionLifetimeMs } from "@family-agenda/application";
import type { Application } from "../composition-root";
import type { Catalogue } from "./i18n/en";
import { TranslationContext, translationFor, type Translation } from "./i18n/translation";
import {
  AdminsPage,
  AttributionRulesPage,
  FamilyMembersPage,
  FirstAdminPage,
  LanguagePage,
  LiveStepProgress,
  LlmEndpointPage,
  MessagePage,
  RecoveryKitPage,
  recoveryKitText,
  SignInPage,
  SourcesPage,
  SourceTypesPage,
  ViewsPage,
  type LiveStep,
  type RuleDialog,
  type SettingsSummary,
  type SignedInAdmin,
  type SourceAdding,
} from "./pages";
import { icsFeed } from "./ics-feed";
import {
  ActivityIndicator,
  activityEnded,
  ShownDay,
  ViewDays,
  ViewPageDocument,
  ViewTimeline,
  viewUrl,
} from "./view-page";

export type HttpOptions = {
  /** Whether a reverse proxy in front sets `X-Forwarded-For` and `X-Forwarded-Proto`. */
  trustProxy: boolean;
  /** Whether a View opens, as decided for the listener this app serves (ADR-0005). */
  viewAccess: ViewAccessPolicy;
};

type Env = {
  Bindings: HttpBindings;
  Variables: { admin: SignedInAdmin; translation: Translation };
};

/** A problem a use case reports, as the catalogue words it. */
type ProblemKey = keyof Catalogue["problems"];

/** A page or fragment rendered in the request's Translation. */
const render = (c: Context<Env>, node: Child, status?: 200 | 400 | 401 | 413 | 429) =>
  c.html(<TranslationContext.Provider value={c.get("translation")}>{node}</TranslationContext.Provider>, status);

/** What the catalogue of the request's Translation says about a problem. */
const problemIn = (c: Context<Env>, problem: ProblemKey): string => c.get("translation").t.problems[problem];

const sessionCookie = "fb_session";

const htmx = readFileSync(createRequire(import.meta.url).resolve("htmx.org/dist/htmx.min.js"));

const resolve = createRequire(import.meta.url).resolve;

/** The design system's stylesheets (`design/`), served as they are. */
const stylesheets: Record<string, typeof htmx> = {
  "tokens.css": readFileSync(new URL("./design/tokens.css", import.meta.url)),
  "design.css": readFileSync(new URL("./design/design.css", import.meta.url)),
};

/** The font files `tokens.css` names, from their packages: the Instance serves them itself, as it runs offline. */
const fonts: Record<string, typeof htmx> = Object.fromEntries(
  ["atkinson-hyperlegible-next", "atkinson-hyperlegible-mono"].flatMap((family) =>
    (family.endsWith("next") ? ["normal", "italic"] : ["normal"]).flatMap((style) =>
      ["latin", "latin-ext"].map((subset) => {
        const file = `${family}-${subset}-wght-${style}.woff2`;
        return [file, readFileSync(resolve(`@fontsource-variable/${family}/files/${file}`))] as const;
      }),
    ),
  ),
);

export function createHttpApp(application: Application, options: HttpOptions) {
  const {
    admins,
    recoveryKit,
    familyMembers,
    languages,
    views,
    sourceTypes,
    catalogues,
    sources,
    attributionRules,
    llmEndpoint,
    messages,
    timeZone,
  } = application;
  const app = new Hono<Env>();

  const isHttps = (c: Context) =>
    options.trustProxy
      ? c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
      : new URL(c.req.url).protocol === "https:";

  const hostOf = (c: Context) =>
    (options.trustProxy ? c.req.header("x-forwarded-host") : undefined) ??
    c.req.header("host") ??
    new URL(c.req.url).host;

  /** The address the request came from; behind a trusted proxy, the one the proxy saw. */
  const clientOf = (c: Context<Env>) => {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (options.trustProxy && forwarded) return forwarded;
    // In-process requests, as in tests, come without Node bindings.
    const bindings = c.env as Partial<HttpBindings> | undefined;
    return bindings?.incoming?.socket.remoteAddress ?? "unknown";
  };

  const startSession = (c: Context<Env>, token: string) => {
    setCookie(c, sessionCookie, token, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(c),
      maxAge: sessionLifetimeMs / 1000,
    });
  };

  app.get("/static/htmx.min.js", (c) =>
    c.body(htmx, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=86400",
    }),
  );

  app.get("/static/:file{[a-z]+\\.css}", (c) => {
    const css = stylesheets[c.req.param("file")];
    if (!css) return c.notFound();
    return c.body(css, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=86400" });
  });

  app.get("/static/fonts/:file", (c) => {
    const font = fonts[c.req.param("file")];
    if (!font) return c.notFound();
    return c.body(font, 200, { "content-type": "font/woff2", "cache-control": "public, max-age=604800" });
  });

  app.get("/api/health", (c) => c.json({ status: "ok" } satisfies HealthResponse));

  app.use(
    csrf({
      // Compares hosts, so that it works behind a proxy terminating HTTPS too.
      origin: (origin, c) => URL.canParse(origin) && new URL(origin).host === hostOf(c),
    }),
  );

  // Until the first Admin exists, every page leads to creating one; afterwards that page is gone.
  app.use(async (c, next) => {
    const onSetup = c.req.path === "/setup";
    const needed = await admins.needsFirstAdmin();
    if (needed && !onSetup) return c.redirect("/setup");
    if (!needed && onSetup) return c.notFound();
    await next();
  });

  // The pages speak the Family Language; the setup speaks the one the browser prefers until one is chosen.
  app.use(async (c, next) => {
    const language =
      c.req.path === "/setup" ? preferredFamilyLanguage(c.req.header("accept-language")) : await languages.familyLanguage();
    c.set("translation", translationFor(language));
    await next();
  });

  app.get("/setup", (c) => render(c, <FirstAdminPage language={c.get("translation").language} />));

  app.post("/setup", async (c) => {
    const form = await c.req.parseBody();
    const email = field(form, "email");
    const language = field(form, "language");
    const result = await admins.createFirstAdmin({
      email,
      password: field(form, "password"),
      ...(language !== "" ? { language } : {}),
    });
    if (!result.ok) {
      if (result.problem === "admin-exists") return c.notFound();
      if (isFamilyLanguage(language)) c.set("translation", translationFor(language));
      const page = <FirstAdminPage language={c.get("translation").language} email={email} problem={problemIn(c, result.problem)} />;
      return render(c, page, 400);
    }
    startSession(c, result.sessionToken);
    return c.redirect("/admin/recovery-kit", 303);
  });

  app.get("/", (c) => c.redirect("/admin"));

  // Views open without signing in, as far as the listener's ViewAccessPolicy allows.
  app.get("/views/:id", async (c) => {
    const days = timelineDaysOf(c.req.query("from"), c.req.query("until"));
    if (days === "invalid") return c.text("Unacceptable days", 400);
    const page = await views.open(c.req.param("id") as ViewId, {
      access: options.viewAccess,
      ...showingOf(c.req.query("show")),
      ...days,
    });
    if (!page) return c.notFound();
    c.header("cache-control", "no-store");
    c.header("vary", "HX-Request");
    // htmx asks for the whole page when it restores history it has not cached.
    const fragment = c.req.header("hx-request") === "true" && !c.req.header("hx-history-restore-request");
    return render(c, fragment ? <ViewTimeline page={page} /> : <ViewPageDocument page={page} />);
  });

  // More days of a timeline, as htmx loads them while scrolling into the past or the future.
  app.get("/views/:id/days", async (c) => {
    const days = timelineDaysOf(c.req.query("from"), c.req.query("until"));
    const then = c.req.query("then");
    if (days === "invalid" || !days.days || (then !== "earlier" && then !== "later")) {
      return c.text("Unacceptable days", 400);
    }
    const page = await views.open(c.req.param("id") as ViewId, {
      access: options.viewAccess,
      ...showingOf(c.req.query("show")),
      ...days,
    });
    if (!page) return c.notFound();
    c.header("cache-control", "no-store");
    // The page's refresh asks for the loaded days too, so the side they extend moves with them.
    const earlier = then === "earlier";
    return render(
      c,
      <>
        <ViewDays page={page} earlier={earlier} later={!earlier} />
        <ShownDay side={earlier ? "from" : "until"} date={earlier ? days.days.first : days.days.last} oob />
      </>,
    );
  });

  // What the worker is busy with, as a View's indicator asks for it while the View is open.
  app.get("/views/:id/activity", async (c) => {
    const id = c.req.param("id") as ViewId;
    const activity = await views.activity(id, { access: options.viewAccess });
    if (activity === undefined) return c.notFound();
    c.header("cache-control", "no-store");
    // Once the worker is done, the timeline refreshes to show what it brought.
    if (!activity && c.req.query("was") === "busy") c.header("hx-trigger", activityEnded);
    return render(c, <ActivityIndicator viewId={id} activity={activity} />);
  });

  // A View's feed follows the View's access, so that calendar apps can subscribe without a session.
  app.get("/views/:id/feed.ics", async (c) => {
    const feed = await views.feed(c.req.param("id") as ViewId, { access: options.viewAccess });
    if (!feed) return c.notFound();
    const viewLink = `${isHttps(c) ? "https" : "http"}://${hostOf(c)}${viewUrl(feed.id)}`;
    return c.body(icsFeed(feed, viewLink), 200, {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  app.get("/family-members/:id/photo", async (c) => {
    const photo = await familyMembers.photo(c.req.param("id") as FamilyMemberId);
    if (!photo) return c.notFound();
    return c.body(photo.bytes, 200, {
      "content-type": photo.contentType,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    });
  });

  app.get("/admin/sign-in", (c) => render(c, <SignInPage />));

  app.post("/admin/sign-in", async (c) => {
    const form = await c.req.parseBody();
    const email = field(form, "email");
    const result = await admins.signIn({
      email,
      password: field(form, "password"),
      client: clientOf(c),
    });
    if (!result.ok) {
      const status = result.problem === "rate-limited" ? 429 : 401;
      return render(c, <SignInPage email={email} problem={problemIn(c, result.problem)} />, status);
    }
    startSession(c, result.sessionToken);
    return c.redirect("/admin", 303);
  });

  /** What the settings list says about each section. */
  const settings = async (): Promise<SettingsSummary> => {
    const endpoint = await llmEndpoint.current();
    const language = await languages.current();
    const allSources = await sources.list();
    return {
      members: (await familyMembers.list()).map((member) => member.name),
      views: (await views.list()).length,
      sources: allSources.length,
      failingSources: allSources.filter((source) => source.health.status === "failing").length,
      rules: (await attributionRules.list()).length,
      enabledSourceTypes: (await sources.forms()).length,
      llm: endpoint ? { model: endpoint.model, local: endpoint.local } : null,
      admins: (await admins.listAdmins()).length,
      kitSaved: await recoveryKit.isConfirmed(),
      language: {
        family: language.language,
        ocr: language.ocrLanguages.map((ocr) => ocr.language),
        missing: language.ocrLanguages.some((ocr) => !ocr.installed),
      },
    };
  };

  const requireAdmin = createMiddleware<Env>(async (c, next) => {
    if (c.req.path === "/admin/sign-in") {
      await next();
      return;
    }
    const token = getCookie(c, sessionCookie);
    const admin = token ? await admins.authenticate(token) : null;
    if (!admin) return c.redirect("/admin/sign-in");
    c.set("admin", { ...admin, newSourceTypes: await sourceTypes.hasNew(), settings: await settings() });
    await next();
  });
  // Until an Admin confirms saving the Recovery Kit, the Admin area shows only the kit (ADR-0006).
  const requireSavedRecoveryKit = createMiddleware<Env>(async (c, next) => {
    const exempt = ["/admin/sign-in", "/admin/sign-out"].includes(c.req.path) ||
      c.req.path.startsWith("/admin/recovery-kit");
    if (!exempt && !(await recoveryKit.isConfirmed())) return c.redirect("/admin/recovery-kit");
    await next();
  });
  for (const path of ["/admin", "/admin/*"]) app.use(path, requireAdmin, requireSavedRecoveryKit);

  app.post("/admin/sign-out", async (c) => {
    const token = getCookie(c, sessionCookie);
    if (token) await admins.signOut(token);
    deleteCookie(c, sessionCookie, { path: "/" });
    return c.redirect("/admin/sign-in", 303);
  });

  const recoveryKitPage = async (c: Context<Env>, problem?: string) => {
    c.header("cache-control", "no-store");
    const page = (
      <RecoveryKitPage
        admin={c.get("admin")}
        kit={recoveryKit.contents()}
        confirmed={await recoveryKit.isConfirmed()}
        problem={problem}
      />
    );
    return render(c, page, problem ? 400 : 200);
  };

  app.get("/admin/recovery-kit", (c) => recoveryKitPage(c));

  app.get("/admin/recovery-kit/download", (c) =>
    c.text(recoveryKitText(recoveryKit.contents(), c.get("translation").t), 200, {
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="family-agenda-recovery-kit.txt"',
    }),
  );

  app.post("/admin/recovery-kit/confirm", async (c) => {
    const form = await c.req.parseBody();
    if (field(form, "saved") !== "yes") return recoveryKitPage(c, problemIn(c, "kit-not-saved"));
    await recoveryKit.confirm();
    return c.redirect("/admin", 303);
  });

  // The Admin area opens on its first section.
  app.get("/admin", (c) => familyMembersPage(c));

  const adminsPage = async (
    c: Context<Env>,
    shown: { problem?: string; adding?: { email?: string; problem?: string } } = {},
  ) => {
    const page = (
      <AdminsPage
        admin={c.get("admin")}
        admins={await admins.listAdmins()}
        {...(shown.problem ? { problem: shown.problem } : {})}
        {...(shown.adding ? { adding: shown.adding } : {})}
      />
    );
    return render(c, page, shown.problem || shown.adding?.problem ? 400 : 200);
  };

  app.get("/admin/admins", (c) => adminsPage(c));

  app.get("/admin/admins/new", (c) => adminsPage(c, { adding: {} }));

  app.post("/admin/admins", async (c) => {
    const form = await c.req.parseBody();
    const email = field(form, "email");
    const result = await admins.createAdmin({ email, password: field(form, "password") });
    if (!result.ok) return adminsPage(c, { adding: { email, problem: problemIn(c, result.problem) } });
    return c.redirect("/admin/admins", 303);
  });

  app.post("/admin/admins/:id/password", async (c) => {
    const form = await c.req.parseBody();
    const result = await admins.resetPassword(c.get("admin"), {
      adminId: c.req.param("id") as AdminId,
      newPassword: field(form, "password"),
    });
    if (!result.ok) return adminsPage(c, { problem: problemIn(c, result.problem) });
    return c.redirect("/admin/admins", 303);
  });

  const familyMembersPage = async (
    c: Context<Env>,
    shown: { problem?: string; adding?: { name?: string; problem?: string }; status?: 200 | 400 | 413 } = {},
  ) => {
    const { problem, adding } = shown;
    const page = (
      <FamilyMembersPage
        admin={c.get("admin")}
        members={await familyMembers.list()}
        {...(problem ? { problem } : {})}
        {...(adding ? { adding } : {})}
      />
    );
    return render(c, page, shown.status ?? (problem || adding?.problem ? 400 : 200));
  };

  // A photo and the rest of the form; larger uploads are refused before they are read.
  const photoUpload = bodyLimit({
    maxSize: maximumPhotoBytes + 64 * 1024,
    onError: (c: Context<Env>) => {
      const problem = problemIn(c, "photo-too-large");
      // Adding shows the problem in its dialog, editing above the list.
      const shown = c.req.path === "/admin/family-members" ? { adding: { problem } } : { problem };
      return familyMembersPage(c, { ...shown, status: 413 });
    },
  });

  app.get("/admin/family-members", (c) => familyMembersPage(c));

  app.get("/admin/family-members/new", (c) => familyMembersPage(c, { adding: {} }));

  app.post("/admin/family-members", photoUpload, async (c) => {
    const form = await c.req.parseBody();
    const name = field(form, "name");
    const photo = await upload(form, "photo");
    const result = await familyMembers.add({ name, ...(photo ? { photo } : {}) });
    if (!result.ok) return familyMembersPage(c, { adding: { name, problem: problemIn(c, result.problem) } });
    return c.redirect("/admin/family-members", 303);
  });

  app.post("/admin/family-members/:id", photoUpload, async (c) => {
    const form = await c.req.parseBody();
    const photo = field(form, "removePhoto") === "yes" ? null : await upload(form, "photo");
    const result = await familyMembers.edit(c.req.param("id") as FamilyMemberId, {
      name: field(form, "name"),
      ...(photo !== undefined ? { photo } : {}),
    });
    if (!result.ok) return familyMembersPage(c, { problem: problemIn(c, result.problem) });
    return c.redirect("/admin/family-members", 303);
  });

  app.post("/admin/family-members/:id/remove", async (c) => {
    await familyMembers.remove(c.req.param("id") as FamilyMemberId);
    return c.redirect("/admin/family-members", 303);
  });

  const viewsPage = async (c: Context<Env>, shown: { problem?: string; creating?: { problem?: string } } = {}) => {
    const page = (
      <ViewsPage
        admin={c.get("admin")}
        views={await views.list()}
        members={await familyMembers.list()}
        {...(shown.problem ? { problem: shown.problem } : {})}
        {...(shown.creating ? { creating: shown.creating } : {})}
      />
    );
    return render(c, page, shown.problem || shown.creating?.problem ? 400 : 200);
  };

  const viewSettingsOf = async (c: Context<Env>) => {
    const form = await c.req.parseBody({ all: true });
    const preselected = form.preselected;
    return {
      preselected: (Array.isArray(preselected) ? preselected : [preselected])
        .filter((id): id is string => typeof id === "string")
        .map((id) => id as FamilyMemberId),
      horizonDays: Number(field(form, "horizonDays")),
    };
  };

  app.get("/admin/views", (c) => viewsPage(c));

  app.get("/admin/views/new", (c) => viewsPage(c, { creating: {} }));

  app.post("/admin/views", async (c) => {
    const result = await views.create(await viewSettingsOf(c));
    if (!result.ok) return viewsPage(c, { creating: { problem: problemIn(c, result.problem) } });
    return c.redirect("/admin/views", 303);
  });

  app.post("/admin/views/:id", async (c) => {
    const result = await views.edit(c.req.param("id") as ViewId, await viewSettingsOf(c));
    if (!result.ok) return viewsPage(c, { problem: problemIn(c, result.problem) });
    return c.redirect("/admin/views", 303);
  });

  app.post("/admin/views/:id/remove", async (c) => {
    await views.remove(c.req.param("id") as ViewId);
    return c.redirect("/admin/views", 303);
  });

  const sourceTypesPage = async (c: Context<Env>, problem?: string) => {
    const list = await sourceTypes.open();
    // Opening the list ends the banner, so this page no longer shows it.
    const page = (
      <SourceTypesPage
        admin={{ ...c.get("admin"), newSourceTypes: false }}
        sourceTypes={list}
        catalogues={await catalogues.list()}
        {...(problem ? { problem } : {})}
      />
    );
    return render(c, page, problem ? 400 : 200);
  };

  app.get("/admin/source-types", (c) => sourceTypesPage(c));

  app.post("/admin/source-types/:id/enable", async (c) => {
    const form = await c.req.parseBody();
    const result = await sourceTypes.enable(c.req.param("id"), {
      riskAcknowledged: field(form, "riskAcknowledged") === "yes",
    });
    if (!result.ok) return sourceTypesPage(c, problemIn(c, result.problem));
    return c.redirect("/admin/source-types", 303);
  });

  app.post("/admin/source-types/:id/catalogue/:entry/enable", async (c) => {
    const form = await c.req.parseBody();
    const result = await catalogues.enable(c.req.param("id"), c.req.param("entry"), {
      riskAcknowledged: field(form, "riskAcknowledged") === "yes",
    });
    if (!result.ok) return sourceTypesPage(c, problemIn(c, result.problem));
    return c.redirect("/admin/source-types", 303);
  });

  app.post("/admin/source-types/:id/catalogue/:entry/disable", async (c) => {
    const result = await catalogues.disable(c.req.param("id"), c.req.param("entry"));
    if (!result.ok) return sourceTypesPage(c, problemIn(c, result.problem));
    return c.redirect("/admin/source-types", 303);
  });

  app.post("/admin/source-types/:id/disable", async (c) => {
    const result = await sourceTypes.disable(c.req.param("id"));
    if (!result.ok) return sourceTypesPage(c, problemIn(c, result.problem));
    return c.redirect("/admin/source-types", 303);
  });

  /** What the live setup steps of a Source show now, such as a QR code to scan. */
  const liveStepsOf = async (source: SourceSummary): Promise<LiveStep[]> => {
    const form = (await sources.forms()).find((candidate) => candidate.sourceTypeId === source.sourceTypeId);
    const steps: LiveStep[] = [];
    for (const step of form?.setupSteps.filter((candidate) => candidate.live) ?? []) {
      const live = await liveStepOf(source.id, step.id);
      if (live) steps.push(live);
    }
    return steps;
  };

  const liveStepOf = async (sourceId: SourceId, stepId: string): Promise<LiveStep | null> => {
    const progress = await sources.setupProgress(sourceId, stepId);
    if (!progress) return null;
    const qrSvg =
      progress.status === "waiting" && progress.qrCode !== null
        ? await QRCode.toString(progress.qrCode, { type: "svg", margin: 0, errorCorrectionLevel: "L" })
        : null;
    return { sourceId, stepId, progress, qrSvg };
  };

  const sourcesPage = async (
    c: Context<Env>,
    shown: { problem?: string; adding?: SourceAdding; fixing?: SourceSummary; settingUp?: SourceSummary } = {},
  ) => {
    const forms = await sources.forms();
    const setUp = shown.fixing ?? shown.settingUp;
    const page = (
      <SourcesPage
        admin={c.get("admin")}
        sources={await sources.list()}
        forms={forms}
        timeZone={timeZone}
        {...(shown.problem ? { problem: shown.problem } : {})}
        {...(shown.adding ? { adding: shown.adding } : {})}
        {...(shown.fixing ? { fixing: shown.fixing } : {})}
        {...(shown.settingUp ? { settingUp: shown.settingUp } : {})}
        {...(setUp ? { liveSteps: await liveStepsOf(setUp) } : {})}
      />
    );
    const refused = shown.problem || (shown.adding?.step === "form" && shown.adding.problem);
    return render(c, page, refused ? 400 : 200);
  };

  /** The message for a Source that cannot be saved, naming the fields by their labels. */
  const sourceProblem = async (
    c: Context<Env>,
    result: { problem: ProblemKey } | { problem: "invalid-config"; fields: string[] } | { problem: "setup-failed"; message: string },
  ) => {
    if (result.problem === "setup-failed") return c.get("translation").t.problemsWith.setupFailed(result.message);
    if (!("fields" in result)) return problemIn(c, result.problem);
    const { t, text, list } = c.get("translation");
    const labels = new Map((await sources.forms()).flatMap((form) => form.fields.map((f) => [f.key, text(f.label)])));
    return t.problemsWith.invalidConfig(list(result.fields.map((key) => labels.get(key) ?? key)));
  };

  app.get("/admin/sources", (c) => sourcesPage(c));

  // Adding a Source: choosing among the enabled Source Types, then that one's form.
  app.get("/admin/sources/new", async (c) => {
    const forms = await sources.forms();
    const type = c.req.query("type") ?? (forms.length === 1 ? forms[0]?.sourceTypeId : undefined);
    if (type === undefined) {
      if (forms.length === 0) return c.redirect("/admin/sources");
      return sourcesPage(c, { adding: { step: "choose" } });
    }
    const form = forms.find((candidate) => candidate.sourceTypeId === type);
    if (!form) return c.redirect("/admin/sources/new");
    return sourcesPage(c, { adding: { step: "form", form } });
  });

  app.post("/admin/sources", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const sourceTypeId = field(form, "sourceTypeId");
    const input = sourceInputOf(form);
    const result = await sources.add({ sourceTypeId, ...input });
    if (!result.ok) {
      const problem = await sourceProblem(c, result);
      const sourceForm = (await sources.forms()).find((candidate) => candidate.sourceTypeId === sourceTypeId);
      if (!sourceForm) return sourcesPage(c, { problem });
      const plain = Object.fromEntries(Object.entries(input.plain).map(([key, value]) => [key, String(value)]));
      const entered = { plain, interval: field(form, "pollIntervalMinutes").trim() };
      return sourcesPage(c, { adding: { step: "form", form: sourceForm, entered, problem } });
    }
    return c.redirect(result.setUp ? `/admin/sources/${result.id}/setup` : "/admin/sources", 303);
  });

  // A Source with live setup steps, such as a QR code login, goes through them once added.
  app.get("/admin/sources/:id/setup", async (c) => {
    const settingUp = (await sources.list()).find((source) => source.id === c.req.param("id"));
    if (!settingUp) return c.redirect("/admin/sources");
    return sourcesPage(c, { settingUp });
  });

  // What a live setup step shows now; asked for again every few seconds while it waits.
  app.get("/admin/sources/:id/setup/:step", async (c) => {
    const live = await liveStepOf(c.req.param("id") as SourceId, c.req.param("step"));
    if (!live) return c.body(null, 404);
    return render(c, <LiveStepProgress step={live} />);
  });

  // A Fix button opens the Source's form in the dialog adding a Source uses.
  app.get("/admin/sources/:id/fix", async (c) => {
    const fixing = (await sources.list()).find((source) => source.id === c.req.param("id"));
    if (!fixing) return c.redirect("/admin/sources");
    return sourcesPage(c, { fixing });
  });

  app.post("/admin/sources/:id", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const result = await sources.edit(c.req.param("id") as SourceId, sourceInputOf(form));
    if (!result.ok) return sourcesPage(c, { problem: await sourceProblem(c, result) });
    return c.redirect("/admin/sources", 303);
  });

  app.post("/admin/sources/:id/shown", async (c) => {
    const form = await c.req.parseBody();
    await sources.setShown(c.req.param("id") as SourceId, field(form, "shown") === "yes");
    return c.redirect("/admin/sources", 303);
  });

  app.post("/admin/sources/:id/remove", async (c) => {
    await sources.remove(c.req.param("id") as SourceId);
    return c.redirect("/admin/sources", 303);
  });

  const rulesPage = async (c: Context<Env>, dialog?: RuleDialog) => {
    const page = (
      <AttributionRulesPage
        admin={c.get("admin")}
        rules={await attributionRules.list()}
        targets={await attributionRules.targets()}
        members={await familyMembers.list()}
        {...(dialog ? { dialog } : {})}
      />
    );
    return render(c, page, dialog?.step === "form" && dialog.problem ? 400 : 200);
  };

  /** A rule form's value and whom it concerns: Family Member ids, or `whole-family`, which wins. */
  const ruleInputOf = async (c: Context<Env>) => {
    const form = await c.req.parseBody({ all: true });
    const chosen = form.concerns;
    const concerns = (Array.isArray(chosen) ? chosen : [chosen]).filter((id): id is string => typeof id === "string");
    const input: RuleInput = {
      value: field(form, "value"),
      concerns: concerns.includes("whole-family") ? "whole-family" : concerns.map((id) => id as FamilyMemberId),
    };
    return { input, entered: { value: input.value, concerns }, form };
  };

  app.get("/admin/attribution-rules", (c) => rulesPage(c));

  // Adding a rule: choosing what it matches on, a Source's Origin attribute, then its form.
  app.get("/admin/attribution-rules/new", async (c) => {
    const targets = await attributionRules.targets();
    const only = targets.length === 1 ? targets[0] : undefined;
    const sourceId = c.req.query("source") ?? only?.sourceId;
    const attribute = c.req.query("attribute") ?? only?.attribute;
    if (sourceId === undefined || attribute === undefined) {
      if (targets.length === 0) return c.redirect("/admin/attribution-rules");
      return rulesPage(c, { step: "choose" });
    }
    const form = await attributionRules.form(sourceId as SourceId, attribute);
    if (!form) return c.redirect("/admin/attribution-rules/new");
    return rulesPage(c, { step: "form", form });
  });

  app.post("/admin/attribution-rules", async (c) => {
    const { input, entered, form: posted } = await ruleInputOf(c);
    const sourceId = field(posted, "sourceId") as SourceId;
    const attribute = field(posted, "attribute");
    const result = await attributionRules.create({ sourceId, attribute, ...input });
    if (!result.ok) {
      const form = await attributionRules.form(sourceId, attribute);
      if (!form) return c.redirect("/admin/attribution-rules/new", 303);
      return rulesPage(c, { step: "form", form, entered, problem: problemIn(c, result.problem) });
    }
    return c.redirect("/admin/attribution-rules", 303);
  });

  /** The dialog editing a rule, with the values its Source's plugin knows of; null if there is no such rule. */
  const ruleDialog = async (id: AttributionRuleId, shown: Pick<Extract<RuleDialog, { step: "form" }>, "entered" | "problem"> = {}) => {
    const rule = await attributionRules.find(id);
    if (!rule) return null;
    const form = (await attributionRules.form(rule.sourceId, rule.attribute)) ?? { ...rule, knownValues: [] };
    return { step: "form" as const, form, rule, ...shown };
  };

  app.get("/admin/attribution-rules/:id", async (c) => {
    const dialog = await ruleDialog(c.req.param("id") as AttributionRuleId);
    if (!dialog) return c.redirect("/admin/attribution-rules");
    return rulesPage(c, dialog);
  });

  app.post("/admin/attribution-rules/:id", async (c) => {
    const id = c.req.param("id") as AttributionRuleId;
    const { input, entered } = await ruleInputOf(c);
    const result = await attributionRules.edit(id, input);
    if (!result.ok) {
      const dialog = await ruleDialog(id, { entered, problem: problemIn(c, result.problem) });
      if (!dialog) return c.redirect("/admin/attribution-rules", 303);
      return rulesPage(c, dialog);
    }
    return c.redirect("/admin/attribution-rules", 303);
  });

  app.post("/admin/attribution-rules/:id/remove", async (c) => {
    await attributionRules.remove(c.req.param("id") as AttributionRuleId);
    return c.redirect("/admin/attribution-rules", 303);
  });

  const languagePage = async (c: Context<Env>, problem?: string) => {
    const page = <LanguagePage admin={c.get("admin")} languages={await languages.current()} {...(problem ? { problem } : {})} />;
    return render(c, page, problem ? 400 : 200);
  };

  app.get("/admin/language", (c) => languagePage(c));

  app.post("/admin/language", async (c) => {
    const result = await languages.setLanguage(field(await c.req.parseBody(), "language"));
    if (!result.ok) return languagePage(c, problemIn(c, result.problem));
    return c.redirect("/admin/language", 303);
  });

  // The OCR languages in Tesseract's notation, `deu+eng`, as each button of the page posts them.
  app.post("/admin/language/ocr", async (c) => {
    const chosen = field(await c.req.parseBody(), "ocrLanguages").split("+").filter((language) => language !== "");
    const result = await languages.setOcrLanguages(chosen);
    if (!result.ok) return languagePage(c, problemIn(c, result.problem));
    return c.redirect("/admin/language", 303);
  });

  app.post("/admin/language/models", async (c) => {
    const result = await languages.install(field(await c.req.parseBody(), "language"));
    if (!result.ok) {
      const problem =
        result.problem === "download-failed"
          ? c.get("translation").t.problemsWith.downloadFailed(result.message)
          : problemIn(c, result.problem);
      return languagePage(c, problem);
    }
    return c.redirect("/admin/language", 303);
  });

  app.post("/admin/language/models/:language/remove", async (c) => {
    const result = await languages.remove(c.req.param("language"));
    if (!result.ok) return languagePage(c, problemIn(c, result.problem));
    return c.redirect("/admin/language", 303);
  });

  app.get("/admin/llm", async (c) =>
    render(c, <LlmEndpointPage admin={c.get("admin")} endpoint={await llmEndpoint.current()} />),
  );

  app.post("/admin/llm", async (c) => {
    const form = await c.req.parseBody();
    const entered = { baseUrl: field(form, "baseUrl"), model: field(form, "model"), vision: field(form, "vision") === "yes" };
    const result = await llmEndpoint.save({
      ...entered,
      apiKey: field(form, "apiKey"),
      removeApiKey: field(form, "removeApiKey") === "yes",
      thirdPartiesAcknowledged: field(form, "thirdPartiesAcknowledged") === "yes",
    });
    if (!result.ok) {
      const page = (
        <LlmEndpointPage
          admin={c.get("admin")}
          endpoint={await llmEndpoint.current()}
          entered={entered}
          problem={problemIn(c, result.problem)}
        />
      );
      return render(c, page, 400);
    }
    return c.redirect("/admin/llm", 303);
  });

  // Raw messages are third parties' words: only Admins open them, never a View.
  app.get("/admin/messages/:id", async (c) => {
    const message = await messages.open(c.req.param("id") as RawMessageId);
    if (!message) return c.notFound();
    c.header("cache-control", "no-store");
    return render(c, <MessagePage admin={c.get("admin")} message={message} timeZone={timeZone} />);
  });

  return app;
}

/**
 * A Source form's fields: `plain.<key>` and `secret.<key>` as the plugin declares them, and the
 * polling interval in minutes, empty for the plugin's suggestion.
 */
/** A Source's form, parsed with every value of a name: a choice field's ticked boxes are a list. */
function sourceInputOf(form: Record<string, unknown>): SourceInput {
  const plain: Record<string, string | string[]> = {};
  const secrets: Record<string, string> = {};
  for (const [name, given] of Object.entries(form)) {
    const values = (Array.isArray(given) ? given : [given]).filter((value): value is string => typeof value === "string");
    if (name.startsWith("choice.")) {
      plain[name.slice("choice.".length)] = values.map((value) => value.trim()).filter((value) => value !== "");
      continue;
    }
    const value = values.at(-1);
    if (value === undefined) continue;
    if (name.startsWith("plain.")) plain[name.slice("plain.".length)] = value.trim();
    if (name.startsWith("secret.")) secrets[name.slice("secret.".length)] = value.trim();
  }
  const minutes = field(form, "pollIntervalMinutes").trim();
  return { plain, secrets, pollIntervalSeconds: minutes === "" ? null : Number(minutes) * 60 };
}

/**
 * The Family Language the browser prefers most by its `Accept-Language` header, such as `de` for
 * `fr-FR,fr;q=0.9,de;q=0.7`; English if it prefers neither.
 */
function preferredFamilyLanguage(acceptLanguage: string | undefined): FamilyLanguage {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((entry) => {
      const [tag = "", ...parameters] = entry.trim().split(";");
      const quality = parameters.map((parameter) => /^\s*q=([\d.]+)\s*$/.exec(parameter)?.[1]).find(Boolean);
      return { language: tag.split("-")[0]?.toLowerCase() ?? "", quality: quality ? Number(quality) : 1 };
    })
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);
  return ranked.map((entry) => entry.language).find(isFamilyLanguage) ?? defaultFamilyLanguage;
}

/** The quick filter's setting from the `show` query parameter: `all`, or ids separated by commas. */
function showingOf(show: string | undefined): { show?: Showing } {
  if (show === undefined) return {};
  if (show === "all") return { show: "all" };
  return { show: show.split(",").map((id) => id as FamilyMemberId) };
}

/** The days a timeline was scrolled to, none for the horizon from today, or "invalid". */
function timelineDaysOf(from: string | undefined, until: string | undefined): { days?: TimelineDays } | "invalid" {
  if (from === undefined && until === undefined) return {};
  if (from === undefined || until === undefined || !isLocalDate(from) || !isLocalDate(until)) return "invalid";
  return isAcceptableTimelineRange(from, until) ? { days: { first: from, last: until } } : "invalid";
}

/** An uploaded file's contents, or undefined if none was chosen. */
async function upload(form: Record<string, unknown>, name: string): Promise<Uint8Array | undefined> {
  const value = form[name];
  if (!(value instanceof File) || value.size === 0) return undefined;
  return new Uint8Array(await value.arrayBuffer());
}

function field(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value : "";
}
