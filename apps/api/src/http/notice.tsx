import type { FamilyLanguage } from "@family-agenda/domain";
import { createContext, useContext } from "hono/jsx";

/** A text of a notice in every Family Language: plain text, which the pages escape as all content. */
export type NoticeText = Record<FamilyLanguage, string>;

/**
 * What the caller of a core in supplied mode asks every page of the Family to show, in a thin
 * banner at its top (ADR-0003), such as the end of a trial: a text for every reader, and for a
 * signed-in Admin a link too. The core only shows it: it neither stores nor reads anything in it.
 */
export type Notice = {
  /** For every reader, on every page. */
  text: NoticeText;
  /** Only on the pages of a signed-in Admin: `text` as a link to `href`, an `https:` address. */
  admin?: { text: NoticeText; href: string };
};

/** A notice as one page shows it: in the page's language, the link only for a signed-in Admin. */
export type ShownNotice = { text: string; link: { text: string; href: string } | null };

/** The notice as the page of a request shows it, or null for none. */
export function shownNotice(notice: Notice | undefined, language: FamilyLanguage, signedInAdmin: boolean): ShownNotice | null {
  if (!notice) return null;
  const link = signedInAdmin && notice.admin ? { text: notice.admin.text[language], href: notice.admin.href } : null;
  return { text: notice.text[language], link };
}

/** The notice of the page being rendered; none by default, as in fixed mode, which has no Context. */
export const NoticeContext = createContext<ShownNotice | null>(null);

/** The banner at the top of every page while the Context carries a notice; nothing otherwise. */
export function NoticeBanner() {
  const notice = useContext(NoticeContext);
  if (!notice) return null;
  return (
    <aside class="fam-notice">
      <span class="fam-notice__text">{notice.text}</span>
      {notice.link ? <a href={notice.link.href}>{notice.link.text}</a> : null}
    </aside>
  );
}
