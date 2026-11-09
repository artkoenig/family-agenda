import { iconUrl, icons } from "./design/icons.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  type SourceInput,
  type SourceSummary,
  type SourceTypeSummary,
  type Showing,
  type TimelineDays,
  type AgendaAccessPolicy,
} from "@family-agenda/application";
import {
  defaultFamilyLanguage,
  isAcceptableTimelineRange,
  isFamilyLanguage,
  isLocalDate,
  maximumPhotoBytes,
  type AdminId,
  type FamilyLanguage,
  type FamilyMemberId,
  type ItemId,
  type RawMessageId,
  type SourceId,
  type AgendaId,
  type MultilingualText,
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
import {
  sessionLifetimeMs,
  type PendingSignIn,
} from "@family-agenda/application";
import type { Application } from "../composition-root";
import type { Catalogue } from "./i18n/en";
import { TranslationContext, translationFor, type Translation } from "./i18n/translation";
import {
  AdminsPage,
  FamilyMembersPage,
  FirstAdminPage,
  DisplayPage,
  LiveStepProgress,
  LlmEndpointPage,
  SingleSignOnPage,
  MessagePage,
  RecoveryKitPage,
  recoveryKitText,
  SignInPage,
  SourcesPage,
  SourcePage,
  SourceTypePage,
  sourceHref,
  sourceTypeHref,
  AgendasPage,
  type LiveStep,
  type SettingsSummary,
  type SignedInAdmin,
  type SourceAdding,
} from "./pages";
import { icsFeed } from "./ics-feed";
import {
  ActivityIndicator,
  activityEnded,
  ShownDay,
  TaskList,
  TaskListDocument,
  AgendaDays,
  AgendaPageDocument,
  AgendaTimeline,
  agendaUrl,
} from "./agenda-page";

export type HttpOptions = {
  /** Whether a reverse proxy in front sets `X-Forwarded-For` and `X-Forwarded-Proto`. */
  trustProxy: boolean;
  /** Scheme and host the Family reaches the Instance at; without it, those of the request. */
  publicUrl?: string;
  /** Whether an Agenda opens, as decided for the listener this app serves. */
  agendaAccess: AgendaAccessPolicy;
  /** The release the image was built from; shown by the health check and in the Admin area. Defaults to a development build. */
  version?: string;
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

type SingleSignOnFormValues = NonNullable<
  Parameters<typeof SingleSignOnPage>[0]["entered"]
>;

/** What the single sign-on cookie holds, or null if it is missing or not what `/sso/start` set. */
function pendingSignInOf(cookie: string | undefined): PendingSignIn | null {
  try {
    const parsed: unknown = JSON.parse(cookie ?? "");
    if (typeof parsed !== "object" || parsed === null) return null;
    const { state, nonce, codeVerifier } = parsed as Record<string, unknown>;
    return typeof state === "string" &&
      typeof nonce === "string" &&
      typeof codeVerifier === "string"
      ? { state, nonce, codeVerifier }
      : null;
  } catch {
    return null;
  }
}

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
    agendas,
    tasks,
    sourceTypes,
    catalogues,
    sources,
    llmEndpoint,
    singleSignOn,
    extraction,
    messages,
    timeZone,
  } = application;
  const app = new Hono<Env>();
  const version = options.version ?? "dev";

  const isHttps = (c: Context) =>
    options.trustProxy
      ? c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
      : new URL(c.req.url).protocol === "https:";

  const hostOf = (c: Context) =>
    (options.trustProxy ? c.req.header("x-forwarded-host") : undefined) ??
    c.req.header("host") ??
    new URL(c.req.url).host;

  /** Where the Family reaches the Instance: `PUBLIC_URL`, else the scheme and host of the request. */
  const originOf = (c: Context) => options.publicUrl ?? requestOriginOf(c);

  /** The origin the request itself came to, whatever `PUBLIC_URL` says. */
  function requestOriginOf(c: Context): string {
    return `${isHttps(c) ? "https" : "http"}://${hostOf(c)}`;
  }

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

  app.get("/static/icons/:file", (c) => {
    const icon = icons[c.req.param("file")];
    if (!icon) return c.notFound();
    return c.body(icon, 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
  });

  app.get("/static/fonts/:file", (c) => {
    const font = fonts[c.req.param("file")];
    if (!font) return c.notFound();
    return c.body(font, 200, { "content-type": "font/woff2", "cache-control": "public, max-age=604800" });
  });

  app.get("/api/health", (c) => c.json({ status: "ok", version } satisfies HealthResponse));

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

  // Agendas open without signing in, as far as the listener's AgendaAccessPolicy allows.
  app.get("/agendas/:id", async (c) => {
    const days = timelineDaysOf(c.req.query("from"), c.req.query("until"));
    if (days === "invalid") return c.text("Unacceptable days", 400);
    const page = await agendas.open(c.req.param("id") as AgendaId, {
      access: options.agendaAccess,
      ...showingOf(c.req.query("show")),
      ...days,
    });
    if (!page) return c.notFound();
    c.header("cache-control", "no-store");
    c.header("vary", "HX-Request");
    // htmx asks for the whole page when it restores history it has not cached.
    const fragment = c.req.header("hx-request") === "true" && !c.req.header("hx-history-restore-request");
    if (page.layout === "task_list") return render(c, fragment ? <TaskList page={page} /> : <TaskListDocument page={page} />);
    return render(c, fragment ? <AgendaTimeline page={page} /> : <AgendaPageDocument page={page} />);
  });

  // What puts an Agenda on a home screen as an app that opens fullscreen. Its addresses come from the path
  // it was asked at, so that they stay right whatever address an Agenda is opened at.
  app.get("/agendas/:id/manifest.webmanifest", async (c) => {
    const page = await agendas.open(c.req.param("id") as AgendaId, { access: options.agendaAccess });
    if (!page) return c.notFound();
    const name = page.layout === "task_list" ? "Todos" : "Agenda";
    const address = c.req.path.replace(/\/manifest\.webmanifest$/, "");
    return c.body(
      JSON.stringify({
        id: address,
        name,
        short_name: name,
        start_url: address,
        scope: address,
        display: "standalone",
        background_color: "#faf6f0",
        theme_color: "#faf6f0",
        icons: [
          { src: iconUrl("icon-192.png"), sizes: "192x192", type: "image/png" },
          { src: iconUrl("icon-512.png"), sizes: "512x512", type: "image/png" },
          // Full-bleed art with the content inside the safe zone: Android masks it to its own shape instead of putting it on white.
          { src: iconUrl("icon-192.png"), sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: iconUrl("icon-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      }),
      200,
      { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-store" },
    );
  });

  // More days of a timeline, as htmx loads them while scrolling into the past or the future.
  app.get("/agendas/:id/days", async (c) => {
    const days = timelineDaysOf(c.req.query("from"), c.req.query("until"));
    const then = c.req.query("then");
    if (days === "invalid" || !days.days || (then !== "earlier" && then !== "later")) {
      return c.text("Unacceptable days", 400);
    }
    const page = await agendas.open(c.req.param("id") as AgendaId, {
      access: options.agendaAccess,
      ...showingOf(c.req.query("show")),
      ...days,
    });
    // A Task List has no days to scroll to.
    if (!page || page.layout === "task_list") return c.notFound();
    c.header("cache-control", "no-store");
    // The page's refresh asks for the loaded days too, so the side they extend moves with them.
    const earlier = then === "earlier";
    return render(
      c,
      <>
        <AgendaDays page={page} earlier={earlier} later={!earlier} />
        <ShownDay side={earlier ? "from" : "until"} date={earlier ? days.days.first : days.days.last} oob />
      </>,
    );
  });

  // What the worker is busy with, as an Agenda's indicator asks for it while the Agenda is open.
  app.get("/agendas/:id/activity", async (c) => {
    const id = c.req.param("id") as AgendaId;
    const activity = await agendas.activity(id, { access: options.agendaAccess });
    if (activity === undefined) return c.notFound();
    c.header("cache-control", "no-store");
    // Once the worker is done, the timeline refreshes to show what it brought.
    if (!activity && c.req.query("was") === "busy") c.header("hx-trigger", activityEnded);
    return render(c, <ActivityIndicator agendaId={id} activity={activity} />);
  });

  // Ticking a Task done, or taking the tick back, is the one write an Agenda makes, without a session.
  app.post("/agendas/:id/tasks/:task/:tick{done|undone}", async (c) => {
    const id = c.req.param("id") as AgendaId;
    const result = await tasks.tickFromAgenda(id, c.req.param("task") as ItemId, {
      done: c.req.param("tick") === "done",
      access: options.agendaAccess,
    });
    if (!result.ok) return c.notFound();
    if (c.req.header("hx-request") !== "true") return c.redirect(agendaUrl(id), 303);
    // htmx swaps the timeline or the Task List as it was, the days scrolled to and the quick filter included.
    const form = await c.req.parseBody();
    const days = timelineDaysOf(field(form, "from") || undefined, field(form, "until") || undefined);
    const show = field(form, "show");
    const page = await agendas.open(id, {
      access: options.agendaAccess,
      ...showingOf(show === "" ? undefined : show),
      ...(days === "invalid" ? {} : days),
    });
    if (!page) return c.notFound();
    c.header("cache-control", "no-store");
    return render(c, page.layout === "task_list" ? <TaskList page={page} /> : <AgendaTimeline page={page} />);
  });

  // An Agenda's feed follows the Agenda's access, so that calendar apps can subscribe without a session.
  app.get("/agendas/:id/feed.ics", async (c) => {
    const feed = await agendas.feed(c.req.param("id") as AgendaId, { access: options.agendaAccess });
    if (!feed) return c.notFound();
    const agendaLink = `${originOf(c)}${agendaUrl(feed.id)}`;
    return c.body(icsFeed(feed, agendaLink), 200, {
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

  app.get("/admin/sign-in", async (c) =>
    render(
      c,
      <SignInPage
        singleSignOn={await singleSignOn.isOfferedAt(requestOriginOf(c))}
      />,
    ),
  );

  const singleSignOnCookie = "fb_sso";

  // Sends the Admin to the Identity Provider, remembering state, nonce and PKCE verifier in a short-lived cookie.
  app.get("/sso/start", async (c) => {
    const begun = await singleSignOn.begin(requestOriginOf(c));
    if (!begun) return c.notFound();
    setCookie(c, singleSignOnCookie, JSON.stringify(begun.pending), {
      path: "/sso",
      httpOnly: true,
      // Lax, so that the cookie comes back with the redirect from the Identity Provider.
      sameSite: "Lax",
      secure: isHttps(c),
      maxAge: 10 * 60,
    });
    return c.redirect(begun.authorizationUrl, 303);
  });

  app.get("/sso/callback", async (c) => {
    const origin = requestOriginOf(c);
    const pending = pendingSignInOf(getCookie(c, singleSignOnCookie));
    deleteCookie(c, singleSignOnCookie, { path: "/sso" });
    const offered = await singleSignOn.isOfferedAt(origin);
    if (!offered) return c.notFound();
    const result = pending
      ? await singleSignOn.complete({
          origin,
          query: new URL(c.req.url).search,
          pending,
        })
      : ({ ok: false, problem: "sso-failed" } as const);
    if (!result.ok) {
      return render(
        c,
        <SignInPage problem={problemIn(c, result.problem)} singleSignOn />,
        401,
      );
    }
    startSession(c, result.sessionToken);
    return c.redirect("/admin", 303);
  });

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
    const llmHealth = endpoint ? (await llmEndpoint.health())?.ok ? "ok" as const : "failing" as const : null;
    const language = await languages.current();
    const allSources = await sources.list();
    return {
      members: (await familyMembers.list()).map((member) => member.name),
      agendas: (await agendas.list()).length,
      sources: allSources.length,
      failingSources: allSources.filter((source) => source.health.status === "failing").length,
      llm: endpoint ? { model: endpoint.model, local: endpoint.local } : null,
      llmHealth,
      admins: (await admins.listAdmins()).length,
      singleSignOn: (await singleSignOn.current())?.enabled ?? false,
      kitSaved: await recoveryKit.isConfirmed(),
      version,
      family: language.language,
      ocr: {
        enabled: language.ocrEnabled,
        languages: language.ocrLanguages.map((ocr) => ocr.language),
        missing: language.ocrEnabled && language.ocrLanguages.some((ocr) => !ocr.installed),
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
    c.set("admin", { ...admin, settings: await settings() });
    await next();
  });
  // Until an Admin confirms saving the Recovery Kit, the Admin area shows only the kit (ADR-0003).
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
    shown: { problem?: string; adding?: { email?: string; problem?: string }; editing?: { id: AdminId; problem?: string } } = {},
  ) => {
    const page = (
      <AdminsPage
        admin={c.get("admin")}
        admins={await admins.listAdmins()}
        {...(shown.problem ? { problem: shown.problem } : {})}
        {...(shown.adding ? { adding: shown.adding } : {})}
        {...(shown.editing ? { editing: shown.editing } : {})}
      />
    );
    return render(c, page, shownStatus(undefined, [shown.problem, shown.adding?.problem, shown.editing?.problem]));
  };

  app.get("/admin/admins", (c) => adminsPage(c));

  app.get("/admin/admins/new", (c) => adminsPage(c, { adding: {} }));

  // Another Admin opens in a dialog, where their password is reset.
  app.get("/admin/admins/:id", (c) => adminsPage(c, { editing: { id: c.req.param("id") as AdminId } }));

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
    if (!result.ok) return adminsPage(c, { editing: { id: c.req.param("id") as AdminId, problem: problemIn(c, result.problem) } });
    return c.redirect("/admin/admins", 303);
  });

function shownStatus(status: 200 | 400 | 413 | undefined, problems: (string | undefined)[]): 200 | 400 | 413 {
  return status ?? (problems.some((p) => p !== undefined && p !== "") ? 400 : 200);
}

    const familyMembersPage = async (
    c: Context<Env>,
    shown: {
      problem?: string;
      adding?: { name?: string; problem?: string };
      editing?: { id: FamilyMemberId; problem?: string };
      status?: 200 | 400 | 413;
    } = {},
  ) => {
    const { problem, adding, editing } = shown;
    const page = (
      <FamilyMembersPage
        admin={c.get("admin")}
        members={await familyMembers.list()}
        {...(problem ? { problem } : {})}
        {...(adding ? { adding } : {})}
        {...(editing ? { editing } : {})}
      />
    );
    return render(c, page, shownStatus(shown.status, [problem, adding?.problem, editing?.problem]));
  };

  // A photo and the rest of the form; larger uploads are refused before they are read.
  const photoUpload = bodyLimit({
    maxSize: maximumPhotoBytes + 64 * 1024,
    onError: (c: Context<Env>) => {
      const problem = problemIn(c, "photo-too-large");
      // Adding and editing show the problem in their dialog.
      const editing = /^\/admin\/family-members\/([^/]+)$/.exec(c.req.path)?.[1];
      const shown = editing ? { editing: { id: editing as FamilyMemberId, problem } } : { adding: { problem } };
      return familyMembersPage(c, { ...shown, status: 413 });
    },
  });

  app.get("/admin/family-members", (c) => familyMembersPage(c));

  app.get("/admin/family-members/new", (c) => familyMembersPage(c, { adding: {} }));

  app.get("/admin/family-members/:id", (c) => familyMembersPage(c, { editing: { id: c.req.param("id") as FamilyMemberId } }));

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
    if (!result.ok) {
      return familyMembersPage(c, { editing: { id: c.req.param("id") as FamilyMemberId, problem: problemIn(c, result.problem) } });
    }
    return c.redirect("/admin/family-members", 303);
  });

  app.post("/admin/family-members/:id/remove", async (c) => {
    const id = c.req.param("id") as FamilyMemberId;
    const name = (await familyMembers.list()).find((member) => member.id === id)?.name ?? "";
    const result = await familyMembers.remove(id);
    if (result.ok) return c.redirect("/admin/family-members", 303);
    // Say which Source Attributes keep them, each with its Source's name.
    const listed = await sources.list();
    const blocking = result.blocking.map(({ sourceId, attribute }) => {
      const source = listed.find((candidate) => candidate.id === sourceId);
      return `${source?.name ?? (source ? c.get("translation").text(source.displayName) : "")}: ${attribute}`;
    });
    const { t, list } = c.get("translation");
    return familyMembersPage(c, { problem: t.members.soleAssignee(name, list(blocking)) });
  });

  const agendasPage = async (
    c: Context<Env>,
    shown: { problem?: string; creating?: { problem?: string }; editing?: { id: AgendaId; problem?: string } } = {},
  ) => {
    const page = (
      <AgendasPage
        admin={c.get("admin")}
        agendas={await agendas.list()}
        members={await familyMembers.list()}
        origin={originOf(c)}
        {...(shown.problem ? { problem: shown.problem } : {})}
        {...(shown.creating ? { creating: shown.creating } : {})}
        {...(shown.editing ? { editing: shown.editing } : {})}
      />
    );
    return render(c, page, shownStatus(undefined, [shown.problem, shown.creating?.problem, shown.editing?.problem]));
  };

  const agendaSettingsOf = async (c: Context<Env>) => {
    const form = await c.req.parseBody({ all: true });
    const memberIds = form.memberIds;
    const layout = field(form, "layout");
    return {
      ...(layout ? { layout } : {}),
      memberIds: (Array.isArray(memberIds) ? memberIds : [memberIds])
        .filter((id): id is string => typeof id === "string")
        .map((id) => id as FamilyMemberId),
      horizonDays: Number(field(form, "horizonDays")),
    };
  };

  app.get("/admin/agendas", (c) => agendasPage(c));

  app.get("/admin/agendas/new", (c) => agendasPage(c, { creating: {} }));

  app.get("/admin/agendas/:id", (c) => agendasPage(c, { editing: { id: c.req.param("id") as AgendaId } }));

  app.post("/admin/agendas", async (c) => {
    const result = await agendas.create(await agendaSettingsOf(c));
    if (!result.ok) return agendasPage(c, { creating: { problem: problemIn(c, result.problem) } });
    return c.redirect("/admin/agendas", 303);
  });

  app.post("/admin/agendas/:id", async (c) => {
    const result = await agendas.edit(c.req.param("id") as AgendaId, await agendaSettingsOf(c));
    if (!result.ok) return agendasPage(c, { editing: { id: c.req.param("id") as AgendaId, problem: problemIn(c, result.problem) } });
    return c.redirect("/admin/agendas", 303);
  });

  app.post("/admin/agendas/:id/remove", async (c) => {
    await agendas.remove(c.req.param("id") as AgendaId);
    return c.redirect("/admin/agendas", 303);
  });

  // Each Source Type's card, leading to its page with its Sources.
  const sourcesPage = async (c: Context<Env>) => {
    const page = <SourcesPage admin={c.get("admin")} sourceTypes={await sourceTypes.list()} sources={await sources.list()} />;
    return render(c, page);
  };

  app.get("/admin/sources", (c) => sourcesPage(c));

  // The Source Types had a page of their own before they moved onto the Sources page.
  app.get("/admin/source-types", (c) => c.redirect("/admin/sources", 301));

  /**
   * A Source Type's page, with a dialog over it while one of its Sources is added or set up; the
   * Sources page for a Source Type that is neither installed nor has Sources.
   */
  const sourceTypePage = async (
    c: Context<Env>,
    id: string,
    shown: { problem?: string; adding?: SourceAdding; settingUp?: SourceSummary } = {},
  ) => {
    const sourceType = (await sourceTypes.list()).find((type) => type.id === id) ?? null;
    const ofType = await sources.listOfType(id);
    const displayName = sourceType?.displayName ?? ofType[0]?.displayName;
    if (!displayName) return c.redirect("/admin/sources");
    const page = await sourceTypePageElement(c, id, sourceType, displayName, ofType, shown);
    return render(c, page, refusedStatus(shown));
  };

  async function sourceTypePageElement(
    c: Context<Env>,
    id: string,
    sourceType: SourceTypeSummary | null,
    displayName: MultilingualText,
    ofType: SourceSummary[],
    shown: { problem?: string; adding?: SourceAdding; settingUp?: SourceSummary },
  ) {
    return (
      <SourceTypePage
        admin={c.get("admin")}
        sourceTypeId={id}
        sourceType={sourceType}
        displayName={displayName}
        sources={ofType}
        form={(await sources.forms()).find((form) => form.sourceTypeId === id)}
        catalogue={(await catalogues.list()).find((catalogue) => catalogue.sourceTypeId === id)}
        members={await familyMembers.list()}
        timeZone={timeZone}
        {...(shown.problem ? { problem: shown.problem } : {})}
        {...(shown.adding ? { adding: shown.adding } : {})}
        {...(shown.settingUp ? { settingUp: shown.settingUp, liveSteps: await liveStepsOf(shown.settingUp) } : {})}
      />
    );
  }

  const refusedStatus = (shown: { problem?: string; adding?: SourceAdding }) =>
    shown.problem || shown.adding?.problem ? 400 : 200;

  app.get("/admin/source-types/:id", (c) => sourceTypePage(c, c.req.param("id")));

  /** Enabling or disabling a Source Type or a catalogue entry: the same form, refused the same way. */
  const enablement = (
    path: string,
    act: (params: Record<string, string>, riskAcknowledged: boolean) => Promise<{ ok: true } | { ok: false; problem: ProblemKey }>,
  ) => {
    app.post(path, async (c) => {
      const form = await c.req.parseBody();
      const id = c.req.param("id") ?? "";
      const result = await act(c.req.param(), field(form, "riskAcknowledged") === "yes");
      if (!result.ok) return sourceTypePage(c, id, { problem: problemIn(c, result.problem) });
      return c.redirect(sourceTypeHref(id), 303);
    });
  };

  enablement("/admin/source-types/:id/enable", ({ id = "" }, riskAcknowledged) => sourceTypes.enable(id, { riskAcknowledged }));
  enablement("/admin/source-types/:id/disable", ({ id = "" }) => sourceTypes.disable(id));
  enablement("/admin/source-types/:id/catalogue/:entry/enable", ({ id = "", entry = "" }, riskAcknowledged) =>
    catalogues.enable(id, entry, { riskAcknowledged }),
  );
  enablement("/admin/source-types/:id/catalogue/:entry/disable", ({ id = "", entry = "" }) => catalogues.disable(id, entry));

  // How often the Sources using a catalogue entry are polled, such as all WhatsApp accounts.
  app.post("/admin/source-types/:id/catalogue/:entry/interval", async (c) => {
    const id = c.req.param("id");
    const minutes = field(await c.req.parseBody(), "pollIntervalMinutes").trim();
    const result = await catalogues.setPollInterval(id, c.req.param("entry"), minutes === "" ? null : Number(minutes) * 60);
    if (!result.ok) return sourceTypePage(c, id, { problem: problemIn(c, result.problem) });
    return c.redirect(sourceTypeHref(id), 303);
  });

  /** What the live setup steps of a Source show now, such as a QR code to scan. */
  const liveStepsOf = async (source: SourceSummary): Promise<LiveStep[]> => {
    const form = (await sources.forms()).find((candidate) => candidate.sourceTypeId === source.sourceTypeId);
    const candidates = form ? form.setupSteps : [];
    const steps: LiveStep[] = [];
    for (const step of candidates.filter((candidate) => candidate.live)) {
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

  /** A Source by its id, for the page of its Source Type. */
  const sourceOf = async (id: string) => (await sources.list()).find((source) => source.id === id);

  // Adding a Source: its Source Type's form, in a dialog over that Source Type's page.
  app.get("/admin/sources/new", async (c) => {
    const type = c.req.query("type");
    if (type === undefined) return c.redirect("/admin/sources");
    const form = (await sources.forms()).find((candidate) => candidate.sourceTypeId === type);
    if (!form) return c.redirect(sourceTypeHref(type));
    // Added at a catalogue entry, such as a Messenger, the Source uses that entry.
    const entry = c.req.query("entry");
    if (form.catalogue && entry !== undefined) {
      return sourceTypePage(c, type, { adding: { form, entered: { plain: { [form.catalogue.configKey]: entry }, interval: "" } } });
    }
    return sourceTypePage(c, type, { adding: { form } });
  });

  app.post("/admin/sources", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const sourceTypeId = field(form, "sourceTypeId");
    const input = sourceInputOf(form);
    const result = await sources.add({ sourceTypeId, ...input });
    if (!result.ok) {
      const problem = await sourceProblem(c, result);
      const sourceForm = (await sources.forms()).find((candidate) => candidate.sourceTypeId === sourceTypeId);
      if (!sourceForm) return sourceTypePage(c, sourceTypeId, { problem });
      const plain = Object.fromEntries(Object.entries(input.plain).map(([key, value]) => [key, String(value)]));
      const entered = { plain, interval: field(form, "pollIntervalMinutes").trim() };
      return sourceTypePage(c, sourceTypeId, { adding: { form: sourceForm, entered, problem } });
    }
    return c.redirect(result.setUp ? `/admin/sources/${result.id}/setup` : sourceTypeHref(sourceTypeId), 303);
  });

  // A Source with live setup steps, such as a QR code login, goes through them once added.
  app.get("/admin/sources/:id/setup", async (c) => {
    const settingUp = await sources.find(c.req.param("id") as SourceId);
    if (!settingUp) return c.redirect("/admin/sources");
    return sourceTypePage(c, settingUp.sourceTypeId, { settingUp });
  });

  // What a live setup step shows now; asked for again every few seconds while it waits.
  app.get("/admin/sources/:id/setup/:step", async (c) => {
    const live = await liveStepOf(c.req.param("id") as SourceId, c.req.param("step"));
    if (!live) return c.body(null, 404);
    return render(c, <LiveStepProgress step={live} />);
  });

  /** A Source's page, with its Fix dialog over it once its Fix button is pressed. */
  const sourcePage = async (c: Context<Env>, listed: SourceSummary, shown: { problem?: string; fixing?: boolean } = {}) => {
    // Its own page is where the values its choice fields offer are asked for.
    const source = (await sources.find(listed.id)) ?? listed;
    const page = (
      <SourcePage
        admin={c.get("admin")}
        source={source}
        form={(await sources.forms()).find((form) => form.sourceTypeId === source.sourceTypeId)}
        members={await familyMembers.list()}
        timeZone={timeZone}
        {...(shown.problem ? { problem: shown.problem } : {})}
        {...(shown.fixing ? { fixing: true, liveSteps: await liveStepsOf(source) } : {})}
        {...((await sourceTypes.list()).find((type) => type.id === source.sourceTypeId)?.needsLlm
          ? { waiting: await extraction.waiting({ sourceId: source.id }) }
          : {})}
      />
    );
    return render(c, page, shown.problem ? 400 : 200);
  };

  app.get("/admin/sources/:id", async (c) => {
    const source = await sourceOf(c.req.param("id"));
    if (!source) return c.redirect("/admin/sources");
    return sourcePage(c, source);
  });

  // A Fix button opens the Source's form in the dialog adding a Source uses.
  app.get("/admin/sources/:id/fix", async (c) => {
    const fixing = await sourceOf(c.req.param("id"));
    if (!fixing) return c.redirect("/admin/sources");
    return sourcePage(c, fixing, { fixing: true });
  });

  app.post("/admin/sources/:id", async (c) => {
    const source = await sourceOf(c.req.param("id"));
    if (!source) return c.redirect("/admin/sources", 303);
    const form = await c.req.parseBody({ all: true });
    // Its name is saved with the rest of its form; a name it refuses leaves everything as it was.
    if (typeof form.name === "string") {
      const renamed = await sources.rename(source.id, form.name);
      if (!renamed.ok) return sourcePage(c, source, { problem: problemIn(c, renamed.problem) });
    }
    const result = await sources.edit(source.id, sourceInputOf(form));
    if (!result.ok) return sourcePage(c, (await sourceOf(source.id)) ?? source, { problem: await sourceProblem(c, result) });
    return c.redirect(sourceHref(source.id), 303);
  });

  app.post("/admin/sources/:id/name", async (c) => {
    const source = await sourceOf(c.req.param("id"));
    if (!source) return c.redirect("/admin/sources", 303);
    const result = await sources.rename(source.id, field(await c.req.parseBody(), "name"));
    if (!result.ok) return sourcePage(c, source, { problem: problemIn(c, result.problem) });
    return c.redirect(sourceHref(source.id), 303);
  });

  app.post("/admin/sources/:id/shown", async (c) => {
    const source = await sourceOf(c.req.param("id"));
    if (!source) return c.redirect("/admin/sources", 303);
    const form = await c.req.parseBody();
    await sources.setShown(source.id, field(form, "shown") === "yes");
    return c.redirect(sourceHref(source.id), 303);
  });

  // Whom the Items of each of its Source Attributes concern: the Family Members ticked, or the whole Family with none.
  app.post("/admin/sources/:id/attributes", async (c) => {
    const source = await sourceOf(c.req.param("id"));
    if (!source) return c.redirect("/admin/sources", 303);
    const form = await c.req.parseBody({ all: true });
    for (const attribute of source.attributes) {
      const chosen = form[`member.${attribute.id}`];
      const concerns = (Array.isArray(chosen) ? chosen : [chosen]).filter((id): id is string => typeof id === "string");
      const result = await sources.assignAttribute(attribute.id, concerns as FamilyMemberId[]);
      if (!result.ok) return sourcePage(c, source, { problem: problemIn(c, result.problem) });
    }
    return c.redirect(sourceHref(source.id), 303);
  });

  app.post("/admin/sources/:id/remove", async (c) => {
    const source = await sourceOf(c.req.param("id"));
    if (!source) return c.redirect("/admin/sources", 303);
    await sources.remove(source.id);
    return c.redirect(sourceTypeHref(source.sourceTypeId), 303);
  });

  const displayPage = async (c: Context<Env>, problem?: string) => {
    const page = <DisplayPage admin={c.get("admin")} family={await languages.familyLanguage()} {...(problem ? { problem } : {})} />;
    return render(c, page, problem ? 400 : 200);
  };

  const singleSignOnPage = async (
    c: Context<Env>,
    extra: { problem?: string; entered?: SingleSignOnFormValues } = {},
  ) => {
    const page = (
      <SingleSignOnPage
        admin={c.get("admin")}
        current={await singleSignOn.current()}
        suggestedBaseUrl={requestOriginOf(c)}
        {...(extra.problem ? { problem: extra.problem } : {})}
        {...(extra.entered ? { entered: extra.entered } : {})}
      />
    );
    return render(c, page, extra.problem ? 400 : 200);
  };

  app.get("/admin/sso", (c) => singleSignOnPage(c));

  app.post("/admin/sso", async (c) => {
    const form = await c.req.parseBody();
    const entered = {
      enabled: field(form, "enabled") === "yes",
      issuerUrl: field(form, "issuerUrl"),
      clientId: field(form, "clientId"),
      requiredGroup: field(form, "requiredGroup"),
      publicBaseUrl: field(form, "publicBaseUrl"),
    };
    const result = await singleSignOn.save({
      ...entered,
      clientSecret: field(form, "clientSecret"),
    });
    if (result.ok) return c.redirect("/admin/sso", 303);
    const problem =
      result.problem === "discovery-failed"
        ? c.get("translation").t.problemsWith.discoveryFailed(result.message)
        : problemIn(c, result.problem);
    return singleSignOnPage(c, { problem, entered });
  });

  app.get("/admin/display", (c) => displayPage(c));

  app.post("/admin/display", async (c) => {
    const result = await languages.setLanguage(field(await c.req.parseBody(), "language"));
    if (!result.ok) return displayPage(c, problemIn(c, result.problem));
    return c.redirect("/admin/display", 303);
  });

  const llmEndpointPage = async (c: Context<Env>, problem?: string) => {
    const page = (
      <LlmEndpointPage
        admin={c.get("admin")}
        endpoint={await llmEndpoint.current()}
        languages={await languages.current()}
        waiting={await extraction.waiting()}
        health={await llmEndpoint.health()}
        models={await llmEndpoint.models()}
        {...(problem ? { problem } : {})}
      />
    );
    return render(c, page, problem ? 400 : 200);
  };

  app.post("/admin/llm/ocr/enabled", async (c) => {
    await languages.setOcrEnabled(field(await c.req.parseBody(), "ocr") === "yes");
    return c.redirect("/admin/llm", 303);
  });

  // Adds an OCR language, downloading its model where needed; for a listed one whose model is missing, downloads it again.
  app.post("/admin/llm/ocr", async (c) => {
    const result = await languages.addOcrLanguage(field(await c.req.parseBody(), "language"));
    if (!result.ok) {
      const problem =
        result.problem === "download-failed"
          ? c.get("translation").t.problemsWith.downloadFailed(result.message)
          : problemIn(c, result.problem);
      return llmEndpointPage(c, problem);
    }
    return c.redirect("/admin/llm", 303);
  });

  app.post("/admin/llm/ocr/:language/remove", async (c) => {
    const result = await languages.removeOcrLanguage(c.req.param("language"));
    if (!result.ok) return llmEndpointPage(c, problemIn(c, result.problem));
    return c.redirect("/admin/llm", 303);
  });

  app.post("/admin/llm/ocr/:language/up", async (c) => {
    const result = await languages.moveOcrLanguageUp(c.req.param("language"));
    if (!result.ok) return llmEndpointPage(c, problemIn(c, result.problem));
    return c.redirect("/admin/llm", 303);
  });

  app.get("/admin/llm", (c) => llmEndpointPage(c));

  app.post("/admin/llm", async (c) => {
    const form = await c.req.parseBody();
    const entered = { baseUrl: field(form, "baseUrl"), model: field(form, "model") };
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
          languages={await languages.current()}
          waiting={await extraction.waiting()}
          health={await llmEndpoint.health()}
          models={await llmEndpoint.models()}
          entered={entered}
          problem={problemIn(c, result.problem)}
        />
      );
      return render(c, page, 400);
    }
    return c.redirect("/admin/llm", 303);
  });

  // Raw messages are third parties' words: only Admins open them, never an Agenda.
  app.get("/admin/messages/:id", async (c) => {
    const message = await messages.open(c.req.param("id") as RawMessageId);
    if (!message) return c.notFound();
    c.header("cache-control", "no-store");
    const items = await agendas.messageItemRows(message.items);
    return render(c, <MessagePage admin={c.get("admin")} message={message} items={items} timeZone={timeZone} />);
  });

  // An Admin's only correction of an Item is deleting it (ADR-0005); back to the message it came from.
  app.post("/admin/items/:id/delete", async (c) => {
    await messages.deleteItem(c.req.param("id") as ItemId);
    const message = field(await c.req.parseBody(), "message");
    return c.redirect(/^[0-9a-f-]{36}$/.test(message) ? `/admin/messages/${message}` : "/admin", 303);
  });

  // Downloaded, never shown inline: an attachment is a third party's file and may be HTML or a script.
  app.get("/admin/messages/:id/attachments/:position{[0-9]+}", async (c) => {
    const attachment = await messages.attachment(c.req.param("id") as RawMessageId, Number(c.req.param("position")));
    if (!attachment) return c.notFound();
    return c.body(attachment.bytes, 200, {
      "content-type": mediaTypePattern.test(attachment.contentType) ? attachment.contentType : "application/octet-stream",
      "content-disposition": contentDisposition(attachment.filename),
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
  });

  return app;
}

/**
 * A Source form's fields: `plain.<key>` and `secret.<key>` as the plugin declares them,
 * `choice.<key>` once per ticked box of a choice field, which makes a list, and the polling
 * interval in minutes, empty for the plugin's suggestion.
 */
function sourceInputOf(form: Record<string, unknown>): SourceInput {
  const plain: Record<string, string | string[]> = {};
  const secrets: Record<string, string> = {};
  for (const [name, given] of Object.entries(form)) {
    const values = (Array.isArray(given) ? given : [given]).filter((value): value is string => typeof value === "string");
    classifyField(name, values, plain, secrets);
  }
  const minutes = field(form, "pollIntervalMinutes").trim();
  return { plain, secrets, pollIntervalSeconds: minutes === "" ? null : Number(minutes) * 60 };
}

/** Fills `plain` or `secrets` from one form field. */
function classifyField(name: string, values: string[], plain: Record<string, string | string[]>, secrets: Record<string, string>): void {
  if (name.startsWith("choice.")) {
    plain[name.slice("choice.".length)] = values.map((value) => value.trim()).filter((value) => value !== "");
    return;
  }
  const value = values.at(-1);
  if (value === undefined) return;
  if (name.startsWith("plain.")) plain[name.slice("plain.".length)] = value.trim();
  if (name.startsWith("secret.")) secrets[name.slice("secret.".length)] = value.trim();
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
// eslint-disable-next-line sonarjs/function-return-type -- the result is either a days object or "invalid"
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

/** A bare media type such as `application/pdf`, which is safe to put into a header as it is. */
const mediaTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** Asks the browser to save a file under its name, which may hold any character (RFC 6266). */
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
