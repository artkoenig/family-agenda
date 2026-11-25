import { familyLanguages, type FamilyLanguage } from "@family-agenda/domain";
import { z } from "zod";

/**
 * A section the platform in front of a core in supplied mode adds to the Admin area: the core shows
 * its navigation entry and its page, and the browser loads the page's content from the platform.
 */
export type ContextSection = {
  /** Its address: `/admin/sections/<id>`. */
  id: string;
  /** The navigation entry and the page's title. */
  label: Record<FamilyLanguage, string>;
  /** The OIDC subject of the one Admin who sees it; every Admin if left out. */
  onlyFor?: string;
  /** Where the browser loads the content from, at the origin of the Family's public address. */
  src: Record<FamilyLanguage, string>;
};

/** What each Family Language has one of. */
const perLanguage = (value: z.ZodString) => z.strictObject(Object.fromEntries(familyLanguages.map((language) => [language, value])) as Record<FamilyLanguage, z.ZodString>);

const sectionsSchema = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9-]{1,32}$/),
      label: perLanguage(z.string().max(60).regex(/\S/)),
      onlyFor: z.string().min(1).optional(),
      src: perLanguage(z.string().max(500)),
    }),
  )
  .max(5)
  .refine((sections) => new Set(sections.map(({ id }) => id)).size === sections.length);

/**
 * The sections `value` describes, or null unless all keep the limits; each `src` must be of the
 * origin of `publicUrl`, as its answer lands in the Admin page and is asked for with its cookies.
 */
export function parseSections(value: unknown, publicUrl: string): ContextSection[] | null {
  const parsed = sectionsSchema.safeParse(value);
  if (!parsed.success) return null;
  const { origin } = new URL(publicUrl);
  if (!parsed.data.every(({ src }) => Object.values(src).every((address) => isSecureAddressOf(origin, address)))) return null;
  return parsed.data.map(({ onlyFor, ...section }) => ({ ...section, ...(onlyFor === undefined ? {} : { onlyFor }) }));
}

function isSecureAddressOf(origin: string, address: string): boolean {
  if (!/^https:\/\/\S+$/i.test(address) || !URL.canParse(address)) return false;
  const url = new URL(address);
  return url.origin === origin && url.username === "" && url.password === "";
}

/** The sections the Admin with this OIDC subject may see, in the platform's order. */
export function sectionsFor(subject: string, sections: readonly ContextSection[]): readonly ContextSection[] {
  return sections.filter(({ onlyFor }) => onlyFor === undefined || onlyFor === subject);
}
