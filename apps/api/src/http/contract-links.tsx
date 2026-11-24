import { createContext, useContext, type Child } from "hono/jsx";
import { useTranslation } from "./i18n/translation";

/**
 * A page of the operator's about the contract they sell Family Agenda under: cancelling it
 * (§ 312k BGB), withdrawing from it (§ 356a BGB), or deleting the whole Family.
 */
export type ContractLinkKind = "cancel" | "withdraw" | "delete";

/**
 * A contract page and its address, absolute and linked as given: no path prefix, no Family id,
 * user or token. The operator's page signs the person in itself and finds their Family.
 */
export type ContractLink = { kind: ContractLinkKind; url: string };

/**
 * The operator's contract pages, from `CANCEL_URL`, `WITHDRAW_URL` and `DELETE_URL`, in that
 * order; empty for none, as on a self-hosted Instance, whose Admin area then shows nothing new.
 */
export const ContractLinksContext = createContext<readonly ContractLink[]>([]);

/** Each page's line icon, drawn in the text colour like the sections'. */
const icons: Record<ContractLinkKind, Child> = {
  cancel: (
    <>
      <path d="M6 3h9l4 4v14H6z"></path>
      <path d="M10 12l5 5M15 12l-5 5"></path>
    </>
  ),
  withdraw: (
    <>
      <path d="M9 14L4 9l5-5"></path>
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path>
    </>
  ),
  delete: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6"></path>
      <path d="M6 7l1 13h10l1-13M9 7V4h6v3"></path>
    </>
  ),
};

/**
 * The contract pages as their own group at the end of the Admin area's settings list, on every
 * Admin page and so always in reach, as § 312k (2) BGB asks; nothing, not even the group's name,
 * when none is configured. Every signed-in Admin sees them: the operator's page decides who may act.
 */
export function ContractLinks() {
  const links = useContext(ContractLinksContext);
  const { t } = useTranslation();
  if (links.length === 0) return null;
  return (
    <>
      <span class="fam-settings__group fam-contract">{t.contract.group}</span>
      {links.map((link) => (
        <a class="fam-navitem" href={link.url}>
          <svg
            class="fam-navitem__icon"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            {icons[link.kind]}
          </svg>
          <span class="fam-navitem__text">
            <span class="fam-navitem__label">{t.contract[link.kind]}</span>
          </span>
        </a>
      ))}
    </>
  );
}
