import { createContext, useContext } from "hono/jsx";
import { useTranslation } from "./i18n/translation";

/** A page of the operator's to cancel or withdraw from the contract, or to delete the Family. */
export type ContractLinkKind = "cancel" | "withdraw" | "delete";

/** A contract page and its address, absolute and linked as given: no path prefix, no Family data. */
export type ContractLink = { kind: ContractLinkKind; url: string };

/**
 * The operator's contract pages, from `CANCEL_URL`, `WITHDRAW_URL` and `DELETE_URL`, in that order;
 * empty for none, as on a self-hosted Instance, which then shows nothing of them.
 */
export const ContractLinksContext = createContext<readonly ContractLink[]>([]);

/**
 * The contract pages below the header of the Admin area, so that they are in sight on each of its
 * pages (§ 312k Abs. 2 BGB): on a phone, the settings list scrolls sideways and would hide them.
 * The statutory labels are German in every Family Language, and marked so for screen readers.
 */
export function ContractLinks() {
  const links = useContext(ContractLinksContext);
  const { t } = useTranslation();
  if (links.length === 0) return null;
  return (
    <nav class="fam-contract" aria-label={t.contract.title}>
      {links.map(({ kind, url }) => (
        <a href={url} lang={kind === "delete" ? undefined : "de"}>
          {t.contract[kind]}
        </a>
      ))}
    </nav>
  );
}
