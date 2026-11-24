import { createContext, useContext } from "hono/jsx";
import { useTranslation } from "./i18n/translation";

/** A legal page of the operator's, which every page links to: the imprint, the privacy policy or the terms. */
export type LegalLinkKind = "imprint" | "privacy" | "terms";

/** A legal page and its address, absolute and linked as given: no path prefix, no Family data. */
export type LegalLink = { kind: LegalLinkKind; url: string };

/**
 * The operator's legal pages, from `IMPRINT_URL`, `PRIVACY_URL` and `TERMS_URL`, in that order;
 * empty for none, as on a self-hosted Instance, which then shows no footer at all.
 */
export const LegalLinksContext = createContext<readonly LegalLink[]>([]);

function LegalAnchor(props: { link: LegalLink }) {
  const { t } = useTranslation();
  return <a href={props.link.url}>{t.legal[props.link.kind]}</a>;
}

/** The footer of every page but an Agenda: the legal pages in one quiet line, joined by „ · “. */
export function LegalFooter() {
  const links = useContext(LegalLinksContext);
  if (links.length === 0) return null;
  return (
    <footer class="fam-legal">
      {links.map((link, index) => (
        <>
          {index > 0 ? <span aria-hidden="true"> · </span> : null}
          <LegalAnchor link={link} />
        </>
      ))}
    </footer>
  );
}

/**
 * The legal pages on an Agenda, whose timeline loads more days without end, so that no footer
 * could be reached: a small menu in its top bar, which stays in sight however far the page is
 * scrolled. It opens without JavaScript, and stays open while htmx swaps the bar every minute.
 */
export function LegalMenu() {
  const links = useContext(LegalLinksContext);
  const { t } = useTranslation();
  if (links.length === 0) return null;
  return (
    <details id="legal-menu" class="fam-legal-menu" hx-preserve="true">
      <summary class="fam-legal-menu__toggle" aria-label={t.legal.menu} title={t.legal.menu}>
        <span aria-hidden="true">§</span>
      </summary>
      <nav class="fam-legal-menu__links" aria-label={t.legal.menu}>
        {links.map((link) => (
          <LegalAnchor link={link} />
        ))}
      </nav>
    </details>
  );
}
