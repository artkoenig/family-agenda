import type { AdminSummary } from "@family-butler/application";
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
