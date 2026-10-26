import type { AdminSummary, RecoveryKit } from "@family-butler/application";
import { minimumPasswordLength } from "@family-butler/domain";
import type { Child } from "hono/jsx";
import { Layout, Problem } from "./layout";

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

function AdminLayout(props: { title: string; admin: AdminSummary; children: Child }) {
  return (
    <Layout title={props.title}>
      <nav>
        <a href="/admin">Admin area</a>
        <a href="/admin/admins">Admins</a>
        <a href="/admin/recovery-kit">Recovery Kit</a>
        <span>{props.admin.email}</span>
        <form method="post" action="/admin/sign-out">
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <h1>{props.title}</h1>
      {props.children}
    </Layout>
  );
}

export function AdminHomePage(props: { admin: AdminSummary }) {
  return (
    <AdminLayout title="Admin area" admin={props.admin}>
      <p>Nothing to manage yet.</p>
    </AdminLayout>
  );
}

export function AdminsPage(props: {
  admin: AdminSummary;
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
  admin: AdminSummary;
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
