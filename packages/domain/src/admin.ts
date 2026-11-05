
export type AdminId = string & { readonly __brand: "AdminId" };

export type Email = string & { readonly __brand: "Email" };

export type Admin = {
  id: AdminId;
  email: Email;
  /** Null for an Admin who signs in only through the Identity Provider, until a password is set. */
  passwordHash: string | null;
  /** The Identity Provider's stable id (`sub`) for this Admin, once they have signed in through it. */
  identitySubject: string | null;
  createdAt: Date;
};

export const minimumPasswordLength = 12;

const emailPattern = /^[^\s@]+@[^\s@]+$/;

/** Emails are compared case-insensitively and without surrounding whitespace. */
export function parseEmail(raw: string): Email | null {
  const email = raw.trim().toLowerCase();
  return emailPattern.test(email) ? (email as Email) : null;
}

export function isAcceptablePassword(password: string): boolean {
  return password.length >= minimumPasswordLength;
}
