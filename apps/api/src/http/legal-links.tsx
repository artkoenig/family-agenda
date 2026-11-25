import { createContext, useContext } from "hono/jsx";
import { useTranslation } from "./i18n/translation";

/** A legal page of the operator's, which every page but an Agenda links to: the imprint, the privacy policy or the terms. */
export type LegalLinkKind = "imprint" | "privacy" | "terms";

/** A legal page and its address, absolute and linked as given: no path prefix, no Family data. */
export type LegalLink = { kind: LegalLinkKind; url: string };

/**
 * The operator's legal pages, from `IMPRINT_URL`, `PRIVACY_URL` and `TERMS_URL`, in that order;
 * empty for none, as on a self-hosted Instance, which then shows no footer at all. An Agenda
 * shows none either way.
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
