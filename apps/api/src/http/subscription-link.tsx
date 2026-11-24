import { createContext, useContext } from "hono/jsx";
import { useTranslation } from "./i18n/translation";

/**
 * The operator's page of the Family's subscription, from `SUBSCRIPTION_URL`: absolute and linked
 * as given, with no path prefix and no Family data. Null for none, as on a self-hosted Instance.
 */
export const SubscriptionUrlContext = createContext<string | null>(null);

/** The link to the subscription page, first in the contract group; nothing without one. */
export function SubscriptionNav() {
  const url = useContext(SubscriptionUrlContext);
  const { t } = useTranslation();
  if (url === null) return null;
  return (
    <>
      <a class="fam-navitem" id="subscription" href={url}>
        <svg
          class="fam-navitem__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="6" width="18" height="13" rx="2"></rect>
          <path d="M3 10h18M7 15h4"></path>
        </svg>
        <span class="fam-navitem__text">
          <span class="fam-navitem__label">{t.settings.subscription}</span>
        </span>
      </a>
    </>
  );
}
