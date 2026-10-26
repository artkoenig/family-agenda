import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AdminSummary } from "@family-butler/application";
import { minimumPasswordLength, type AdminId } from "@family-butler/domain";
import type { HealthResponse } from "@family-butler/contracts";
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import { sessionLifetimeMs, signInLimits } from "@family-butler/application";
import type { Application } from "../composition-root";
import { AdminHomePage, AdminsPage, FirstAdminPage, SignInPage } from "./pages";

export type HttpOptions = {
  /** Whether a reverse proxy in front sets `X-Forwarded-For` and `X-Forwarded-Proto`. */
  trustProxy: boolean;
};

type Env = {
  Bindings: HttpBindings;
  Variables: { admin: AdminSummary };
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
} satisfies Record<string, string>;

const htmx = readFileSync(createRequire(import.meta.url).resolve("htmx.org/dist/htmx.min.js"));

export function createHttpApp(application: Application, options: HttpOptions) {
  const { admins } = application;
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
    return c.redirect("/admin", 303);
  });

  app.get("/", (c) => c.redirect("/admin"));

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
    c.set("admin", admin);
    await next();
  });
  app.use("/admin", requireAdmin);
  app.use("/admin/*", requireAdmin);

  app.post("/admin/sign-out", async (c) => {
    const token = getCookie(c, sessionCookie);
    if (token) await admins.signOut(token);
    deleteCookie(c, sessionCookie, { path: "/" });
    return c.redirect("/admin/sign-in", 303);
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

  return app;
}

function field(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  return typeof value === "string" ? value : "";
}
