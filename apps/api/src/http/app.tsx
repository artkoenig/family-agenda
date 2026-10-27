import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  pollIntervalRange,
  type SourceInput,
  type Showing,
  type ViewAccessPolicy,
} from "@family-butler/application";
import {
  horizonDaysRange,
  maximumNameLength,
  maximumPhotoBytes,
  minimumPasswordLength,
  photoTypes,
  type AdminId,
  type FamilyMemberId,
  type SourceId,
  type ViewId,
} from "@family-butler/domain";
import type { HealthResponse } from "@family-butler/contracts";
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import { sessionLifetimeMs, signInLimits } from "@family-butler/application";
import type { Application } from "../composition-root";
import {
  AdminHomePage,
  AdminsPage,
  FamilyMembersPage,
  FirstAdminPage,
  RecoveryKitPage,
  recoveryKitText,
  SignInPage,
  SourcesPage,
  SourceTypesPage,
  ViewsPage,
  type SignedInAdmin,
} from "./pages";
import { ViewPageDocument, ViewTimeline } from "./view-page";

export type HttpOptions = {
  /** Whether a reverse proxy in front sets `X-Forwarded-For` and `X-Forwarded-Proto`. */
  trustProxy: boolean;
  /** Whether a View opens, as decided for the listener this app serves (ADR-0005). */
  viewAccess: ViewAccessPolicy;
};

type Env = {
  Bindings: HttpBindings;
  Variables: { admin: SignedInAdmin };
};

const sessionCookie = "fb_session";

const problems = {
  "invalid-email": "Enter a valid email address.",
  "password-too-short": `The password must have at least ${minimumPasswordLength} characters.`,
  "email-taken": "This email already has an Admin account.",
  "invalid-credentials": "Wrong email or password.",
  "rate-limited": `Too many failed sign-ins. Wait ${signInLimits.windowMs / 60_000} minutes and try again.`,
  "own-account": "You cannot reset your own password here.",
  "unknown-admin": "This Admin does not exist.",
  "kit-not-saved": "Confirm that you have saved the Recovery Kit.",
  "invalid-name": `Enter a name of at most ${maximumNameLength} characters.`,
  "invalid-photo": `The photo must be one of ${photoTypes.map((type) => type.replace("image/", "").toUpperCase()).join(", ")}.`,
  "photo-too-large": `The photo must be at most ${maximumPhotoBytes / 1024 / 1024} MB.`,
  "unknown-member": "This Family Member does not exist.",
  "invalid-horizon": `The horizon must be between ${horizonDaysRange.min} and ${horizonDaysRange.max} days.`,
  "unknown-view": "This View does not exist.",
  "unknown-source-type": "This Source Type is not installed.",
  "not-loadable": "This Source Type cannot be loaded.",
  "risk-not-acknowledged": "Confirm that you understand the risk of this Source Type.",
  "has-sources": "Remove the Sources of this Source Type before disabling it.",
  "source-type-not-enabled": "This Source Type is not enabled.",
  "unknown-source": "This Source does not exist.",
  "invalid-interval": `The polling interval must be between ${pollIntervalRange.minSeconds / 60} minute and ${pollIntervalRange.maxSeconds / 86_400} days.`,
} satisfies Record<string, string>;

const htmx = readFileSync(createRequire(import.meta.url).resolve("htmx.org/dist/htmx.min.js"));

export function createHttpApp(application: Application, options: HttpOptions) {
  const { admins, recoveryKit, familyMembers, views, sourceTypes, sources } = application;
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

  app.get("/setup", (c) => c.html(<FirstAdminPage />));

  app.post("/setup", async (c) => {
    const form = await c.req.parseBody();
    const email = field(form, "email");
    const result = await admins.createFirstAdmin({ email, password: field(form, "password") });
    if (!result.ok) {
      if (result.problem === "admin-exists") return c.notFound();
      return c.html(<FirstAdminPage email={email} problem={problems[result.problem]} />, 400);
    }
    startSession(c, result.sessionToken);
    return c.redirect("/admin/recovery-kit", 303);
  });

  app.get("/", (c) => c.redirect("/admin"));

  // Views open without signing in, as far as the listener's ViewAccessPolicy allows.
  app.get("/views/:id", async (c) => {
    const page = await views.open(c.req.param("id") as ViewId, {
      access: options.viewAccess,
      ...showingOf(c.req.query("show")),
    });
    if (!page) return c.notFound();
    c.header("cache-control", "no-store");
    c.header("vary", "HX-Request");
    // htmx asks for the whole page when it restores history it has not cached.
    const fragment = c.req.header("hx-request") === "true" && !c.req.header("hx-history-restore-request");
    return c.html(fragment ? <ViewTimeline page={page} /> : <ViewPageDocument page={page} />);
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

  app.get("/admin/sign-in", (c) => c.html(<SignInPage />));

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
      return c.html(<SignInPage email={email} problem={problems[result.problem]} />, status);
    }
    startSession(c, result.sessionToken);
    return c.redirect("/admin", 303);
  });

  const requireAdmin = createMiddleware<Env>(async (c, next) => {
    if (c.req.path === "/admin/sign-in") {
      await next();
      return;
    }
    const token = getCookie(c, sessionCookie);
    const admin = token ? await admins.authenticate(token) : null;
    if (!admin) return c.redirect("/admin/sign-in");
    c.set("admin", { ...admin, newSourceTypes: await sourceTypes.hasNew() });
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
    return c.html(page, problem ? 400 : 200);
  };

  app.get("/admin/recovery-kit", (c) => recoveryKitPage(c));

  app.get("/admin/recovery-kit/download", (c) =>
    c.text(recoveryKitText(recoveryKit.contents()), 200, {
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="family-butler-recovery-kit.txt"',
    }),
  );

  app.post("/admin/recovery-kit/confirm", async (c) => {
    const form = await c.req.parseBody();
    if (field(form, "saved") !== "yes") return recoveryKitPage(c, problems["kit-not-saved"]);
    await recoveryKit.confirm();
    return c.redirect("/admin", 303);
  });

  app.get("/admin", (c) => c.html(<AdminHomePage admin={c.get("admin")} />));

  const adminsPageWithProblem = async (c: Context<Env>, problem: string, email = "") => {
    const page = (
      <AdminsPage
        admin={c.get("admin")}
        admins={await admins.listAdmins()}
        email={email}
        problem={problem}
      />
    );
    return c.html(page, 400);
  };

  app.get("/admin/admins", async (c) =>
    c.html(<AdminsPage admin={c.get("admin")} admins={await admins.listAdmins()} />),
  );

  app.post("/admin/admins", async (c) => {
    const form = await c.req.parseBody();
    const email = field(form, "email");
    const result = await admins.createAdmin({ email, password: field(form, "password") });
    if (!result.ok) return adminsPageWithProblem(c, problems[result.problem], email);
    return c.redirect("/admin/admins", 303);
  });

  app.post("/admin/admins/:id/password", async (c) => {
    const form = await c.req.parseBody();
    const result = await admins.resetPassword(c.get("admin"), {
      adminId: c.req.param("id") as AdminId,
      newPassword: field(form, "password"),
    });
    if (!result.ok) return adminsPageWithProblem(c, problems[result.problem]);
    return c.redirect("/admin/admins", 303);
  });

  const familyMembersPage = async (
    c: Context<Env>,
    shown: { problem?: string; name?: string; status?: 200 | 400 | 413 } = {},
  ) => {
    const { problem, name } = shown;
    const page = (
      <FamilyMembersPage
        admin={c.get("admin")}
        members={await familyMembers.list()}
        {...(problem ? { problem } : {})}
        {...(name ? { name } : {})}
      />
    );
    return c.html(page, shown.status ?? (problem ? 400 : 200));
  };

  // A photo and the rest of the form; larger uploads are refused before they are read.
  const photoUpload = bodyLimit({
    maxSize: maximumPhotoBytes + 64 * 1024,
    onError: (c: Context<Env>) => familyMembersPage(c, { problem: problems["photo-too-large"], status: 413 }),
  });

  app.get("/admin/family-members", (c) => familyMembersPage(c));

  app.post("/admin/family-members", photoUpload, async (c) => {
    const form = await c.req.parseBody();
    const name = field(form, "name");
    const photo = await upload(form, "photo");
    const result = await familyMembers.add({ name, ...(photo ? { photo } : {}) });
    if (!result.ok) return familyMembersPage(c, { problem: problems[result.problem], name });
    return c.redirect("/admin/family-members", 303);
  });

  app.post("/admin/family-members/:id", photoUpload, async (c) => {
    const form = await c.req.parseBody();
    const photo = field(form, "removePhoto") === "yes" ? null : await upload(form, "photo");
    const result = await familyMembers.edit(c.req.param("id") as FamilyMemberId, {
      name: field(form, "name"),
      ...(photo !== undefined ? { photo } : {}),
    });
    if (!result.ok) return familyMembersPage(c, { problem: problems[result.problem] });
    return c.redirect("/admin/family-members", 303);
  });

  app.post("/admin/family-members/:id/remove", async (c) => {
    await familyMembers.remove(c.req.param("id") as FamilyMemberId);
    return c.redirect("/admin/family-members", 303);
  });

  const viewsPage = async (c: Context<Env>, problem?: string) => {
    const page = (
      <ViewsPage
        admin={c.get("admin")}
        views={await views.list()}
        members={await familyMembers.list()}
        {...(problem ? { problem } : {})}
      />
    );
    return c.html(page, problem ? 400 : 200);
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

  app.post("/admin/views", async (c) => {
    const result = await views.create(await viewSettingsOf(c));
    if (!result.ok) return viewsPage(c, problems[result.problem]);
    return c.redirect("/admin/views", 303);
  });

  app.post("/admin/views/:id", async (c) => {
    const result = await views.edit(c.req.param("id") as ViewId, await viewSettingsOf(c));
    if (!result.ok) return viewsPage(c, problems[result.problem]);
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
        {...(problem ? { problem } : {})}
      />
    );
    return c.html(page, problem ? 400 : 200);
  };

  app.get("/admin/source-types", (c) => sourceTypesPage(c));

  app.post("/admin/source-types/:id/enable", async (c) => {
    const form = await c.req.parseBody();
    const result = await sourceTypes.enable(c.req.param("id"), {
      riskAcknowledged: field(form, "riskAcknowledged") === "yes",
    });
    if (!result.ok) return sourceTypesPage(c, problems[result.problem]);
    return c.redirect("/admin/source-types", 303);
  });

  app.post("/admin/source-types/:id/disable", async (c) => {
    const result = await sourceTypes.disable(c.req.param("id"));
    if (!result.ok) return sourceTypesPage(c, problems[result.problem]);
    return c.redirect("/admin/source-types", 303);
  });

  const sourcesPage = async (c: Context<Env>, problem?: string) => {
    const forms = await sources.forms();
    const page = (
      <SourcesPage
        admin={c.get("admin")}
        sources={await sources.list()}
        forms={forms}
        {...(problem ? { problem } : {})}
      />
    );
    return c.html(page, problem ? 400 : 200);
  };

  /** The message for a Source that cannot be saved, naming the fields by their labels. */
  const sourceProblem = async (
    result: { problem: keyof typeof problems } | { problem: "invalid-config"; fields: string[] },
  ) => {
    if (!("fields" in result)) return problems[result.problem];
    const labels = new Map((await sources.forms()).flatMap((form) => form.fields.map((f) => [f.key, f.label])));
    return `Check ${result.fields.map((key) => labels.get(key) ?? key).join(", ")}.`;
  };

  app.get("/admin/sources", (c) => sourcesPage(c));

  app.post("/admin/sources", async (c) => {
    const form = await c.req.parseBody();
    const result = await sources.add({ sourceTypeId: field(form, "sourceTypeId"), ...sourceInputOf(form) });
    if (!result.ok) return sourcesPage(c, await sourceProblem(result));
    return c.redirect("/admin/sources", 303);
  });

  app.post("/admin/sources/:id", async (c) => {
    const form = await c.req.parseBody();
    const result = await sources.edit(c.req.param("id") as SourceId, sourceInputOf(form));
    if (!result.ok) return sourcesPage(c, await sourceProblem(result));
    return c.redirect("/admin/sources", 303);
  });

  app.post("/admin/sources/:id/remove", async (c) => {
    await sources.remove(c.req.param("id") as SourceId);
    return c.redirect("/admin/sources", 303);
  });

  return app;
}

/**
 * A Source form's fields: `plain.<key>` and `secret.<key>` as the plugin declares them, and the
 * polling interval in minutes, empty for the plugin's suggestion.
 */
function sourceInputOf(form: Record<string, unknown>): SourceInput {
  const plain: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(form)) {
    if (typeof value !== "string") continue;
    if (name.startsWith("plain.")) plain[name.slice("plain.".length)] = value.trim();
    if (name.startsWith("secret.")) secrets[name.slice("secret.".length)] = value.trim();
  }
  const minutes = field(form, "pollIntervalMinutes").trim();
  return { plain, secrets, pollIntervalSeconds: minutes === "" ? null : Number(minutes) * 60 };
}

/** The quick filter's setting from the `show` query parameter: `all`, or ids separated by commas. */
function showingOf(show: string | undefined): { show?: Showing } {
  if (show === undefined) return {};
  if (show === "all") return { show: "all" };
  return { show: show.split(",").map((id) => id as FamilyMemberId) };
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
