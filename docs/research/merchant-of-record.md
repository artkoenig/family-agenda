# Merchant of Record for a one-person EU subscription business

Question (issue #215, under map #222): which payment provider fits a German individual operator (Einzelunternehmen) selling a monthly consumer subscription in the EU? Compared: Paddle, Lemon Squeezy, and Stripe with Stripe Tax as the baseline. Stripe's own Merchant of Record product, Managed Payments, is added because Lemon Squeezy is migrating to it.

Research date: 2026-11-06, second pass. The first pass relied on search extracts because the sandbox could not reach the providers. This pass fetched the official pages directly (paddle.com, docs.lemonsqueezy.com, stripe.com, docs.stripe.com, eur-lex.europa.eu). Quotes are copied from those pages. Stripe's Managed Payments pricing help page needs JavaScript, so the Managed Payments fee is quoted from Stripe's German pricing page instead. Items marked *unverifiable* could not be settled from a primary source. Not legal or tax advice.

## Answer in short

- **Paddle is still the best fit if it approves the product.** It is a true Merchant of Record (MoR). Sole traders skip business verification and only pass an identity check. Cost: **5% + 50 cents per checkout transaction**, all-in, with monthly payouts above a 100 (EUR/USD/GBP) threshold.
- **Lemon Squeezy** costs about the same but adds 0.5% on subscription payments and is being merged into Stripe's product line.
- **Stripe Managed Payments** (MoR) is now confirmed available to businesses in Germany: 3.5% on top of card fees (1.5% + 0.25 EUR for standard EEA cards), so about 5% + 0.25 EUR, before Billing's 0.7%. It is the closest alternative to Paddle.
- **Plain Stripe + Stripe Tax** is not an MoR. The operator files OSS VAT returns and handles withdrawals.
- Take-rate to price in: **5% + 50 cents** (Paddle), about 15% of a EUR 5 plan. The fixed part dominates.

## Comparison

| | Paddle | Lemon Squeezy | Stripe + Stripe Tax | Stripe Managed Payments |
|---|---|---|---|---|
| Role | MoR | MoR | Operator is the seller | MoR |
| Fee | 5% + 50¢ per Checkout transaction, all-in | 5% + 50¢ on the total order value incl. VAT; +0.5% subscriptions, +1.5% non-US, +1.5% PayPal | EEA standard cards 1.5% + 0.25 EUR, premium 2.8% + 0.25 EUR, SEPA debit 0.35 EUR; Billing 0.7%; Tax Basic 0.5% per transaction or Tax Complete from 80 EUR | 3.5% per transaction on top of payment fees; Billing 0.7% extra |
| Payout | Monthly, requested on the 1st, sent by the 15th; 100 minimum | Twice monthly (paid 14th and 28th); USD 50 minimum; 1% fee outside the US | Daily automatic; Germany: first payout 7 calendar days, later 3 business days; 1 EUR minimum | Same Stripe payouts |
| EU VAT | Paddle files and remits | Lemon Squeezy as MoR | Stripe calculates; operator registers and files | Stripe collects and remits (80+ countries) |
| Individual operator | Sole traders skip business verification | Sole proprietor allowed | Sole proprietors covered by Services Agreement | Germany supported; sole-proprietor rule *unverifiable* |

## Verified claims, with quotes

### Paddle fee, currency and base (point 1)
- Headline fee, still current: "5% + 50¢ per Checkout transaction" and "No monthly fees, migration fees, or hidden extras" ([paddle.com/pricing](https://www.paddle.com/pricing)).
- Payout threshold: "the minimum being $100 adjustable all the way to $100,000 (if your account balance is in Pound Sterling or Euro, this translates to £100 and €100 respectively)" ([Paddle: When and how do I get paid](https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid)). Schedule: "We then issue transfers once a month"; "1st of the month: As long as your account balance is over the payout threshold ... 2nd-15th of the month: Paddle will send your payment by the 15th." Payout fees: "For most countries, Paddle will not charge you any fees on your payout. However, for certain countries, a $15 SWIFT fee may be applicable."
- Balance currency: "You can hold your balance in USD, EUR, GBP, AUD, or CAD" ([Paddle: supported currencies](https://developer.paddle.com/concepts/sell/supported-currencies/)).
- **Unverifiable:** no Paddle page states whether the 50 in "50¢" is charged as 50 euro cents on a EUR balance, nor whether the 5% applies to the VAT-inclusive total. Paddle's pages, terms and refund policy do not say. Price conservatively: assume 5% of the VAT-inclusive price plus 0.50 EUR. Confirm in the Paddle dashboard or with sales before fixing the price.

### Paddle approval for a German sole trader (point 2)
- "Business verification ... this step is not required for individuals or sole traders." ([Business identification](https://www.paddle.com/help/start/account-verification/what-is-business-verification))
- "If you are an individual or sole trader, you will be the person required to do the identity verification check." The check runs through Sumsub, sometimes with a liveness video ([Identity verification](https://www.paddle.com/help/start/account-verification/what-is-identity-verification)).
- Domain review still applies. Product fit: "Paddle is built to serve software companies (including B2B SaaS, Consumer Software, and Games). If your company's primary offering is human services ... or the sale of physical goods, Paddle is not a good fit" ([Acceptable Use Policy](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle)). A hosted software subscription is in scope.
- **Unverifiable:** no country-specific criterion for Germany and no approval-rate or decision criteria for sole traders is published. Only an application settles approval risk.

### Lemon Squeezy fees and payouts (point 5)
- "The platform fee is calculated on the total order value ... +1.5% for international (outside of the US) transactions +1.5% for PayPal transactions +0.5% for subscription payments." Its example: "Total $24.00 (incl. 20% VAT); Platform fee ($0.50 + 5% of total + 1.5% int'l payment) $2.06" ([Fees](https://docs.lemonsqueezy.com/help/getting-started/fees)). So the base includes VAT.
- Payout fees: "Payouts via Stripe: Free for bank accounts in the US; 1% per payout for bank accounts outside the US" (same page); PayPal "3% capped at $30 per payout for accounts outside the US".
- Schedule: "Payouts are created twice monthly on the 1st and 15th of the month ... Net sales are held for 13 days before becoming available for payout on the 14th and 28th." "There is a minimum payout threshold of $50." Bank payouts are made in USD and converted ([Getting Paid](https://docs.lemonsqueezy.com/help/getting-started/getting-paid)).
- Direction: migration to Stripe Managed Payments ([2026 update](https://www.lemonsqueezy.com/blog/2026-update)); no sunset date was found.

### Stripe EU card rate, Billing, Tax, payouts (points 3 and 5)
- Cards (German pricing page): "1,5 % + 0,25 € für Standardkarten aus dem EWR", "2,8 % + 0,25 € für Premiumkarten aus dem EWR", UK cards 2.5% + 0.25 EUR, other foreign cards 3.15% + 0.25 EUR, "+2 % sofern eine Währungsumrechnung erforderlich ist", "0,35 € SEPA-Lastschriftverfahren" ([stripe.com/de/pricing](https://stripe.com/de/pricing)).
- Billing: "0,7 % des Billing-Volumens" (same page). Stripe Tax: "Tax Basic ... Integration ohne Code 0,5 % je Transaktion, am Ort der Meldung bei der Steuerbehörde"; "Tax Complete ... Ab 80,00 € Jahresvertrag, monatlich" (same page). Billing and Tax are separate line items that stack.
- Payouts: "Daily payouts: Stripe automatically transfers your available funds every business day"; Germany settlement "7 calendar days" initially and "3 business days" by default; minimum payout "DE | 1 EUR" ([Stripe payouts](https://docs.stripe.com/payouts)).
- Webhooks: `customer.subscription.created` ("Sent when the subscription is created"), `customer.subscription.deleted` ("Sent when a customer's subscription ends"), `invoice.paid` ("You can provision access to your product when you receive this event and the subscription status is active"), `invoice.payment_failed` ([Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)).

### Stripe Managed Payments eligibility (point 4)
- Fee: "3,5 % pro erfolgreicher Transaktion mit Managed Payments zusätzlich zu Zahlungsgebühren" and it includes "Konformität mit den Vorgaben für indirekte Steuern ... und die Abführung in mehr als 75 Ländern sowie Betrugsprävention, Management von Anfechtungen, Rechnungsstellung und Kundensupport" ([stripe.com/de/pricing](https://stripe.com/de/pricing)).
- Germany: the supported business locations under "Europe" include `DE` ([Managed Payments eligibility](https://docs.stripe.com/payments/managed-payments/eligibility)). The same page: "Stripe determines access to Managed Payments based on an eligibility review that considers factors such as business type and geography" and "Managed Payments supports direct integrations only" (no Connect platforms or Express accounts).
- Product fit: the page lists "Software" and "Electronically supplied business and web services, such as website hosting" as supported, and requires "a fully automated digital product". A hosted Family Agenda should qualify.
- Refunds: "Stripe can issue refunds within 60 days of the original transaction in certain cases" ([How Managed Payments works](https://docs.stripe.com/payments/managed-payments/how-it-works)); Stripe sends receipts, invoices and refund notices to the customer.
- **Unverifiable:** the Managed Payments page does not say whether a sole proprietor (Einzelunternehmen) passes the eligibility review. The general Stripe Services Agreement covers sole proprietors; the Managed Payments review itself is individual.

### Withdrawal right and C-234/25 (re-check)
- Judgment of the Court (First Chamber), 9 July 2026, Sky Österreich (C-234/25) ([EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A62025CJ0234)). Ruling: "the supply of a streaming service ... does not constitute the supply of 'digital content' ... but rather the supply of a 'digital service', within the meaning of Article 2(16) of that directive, where the offering proposed by the trader concerned is of a dynamic nature which goes beyond the mere stable and, as the case may be, continuous provision of specific content."
- **Correction to pass one:** the first pass said streaming is simply not digital content. The ruling is conditional: it is a digital service when the offering is "dynamic". The consequence is the same for a hosted app. A hosted, evolving application is more clearly a digital service than a streaming catalogue, so the Article 16(m) exception for digital content is not available, and the referring court's lower instance applied "the right of withdrawal could be extinguished only once the service has been performed in full" (paragraph describing the Austrian proceedings). Plan for the 14-day withdrawal right on the first payment.
- Paddle as MoR applies it: "The right to withdraw applies to one-off purchases and to the first payment under a Subscription contract. It does not apply to subsequent Subscription payments"; "If a Subscription includes a free trial period, then, as soon as that free trial period ends, you will again have a period of 14 calendar days to exercise your right to withdraw"; "An online withdrawal button is available in the Paddle Customer Portal" ([Paddle Refund Policy](https://www.paddle.com/legal/refund-policy)). A free trial therefore restarts the 14 days once it ends.

### Webhooks for provisioning (unchanged)
- Paddle: `subscription.created`, `subscription.past_due`, `subscription.canceled`; guide: "Where subscriptions are paused or canceled, limit or stop access to your app" ([Provision access](https://developer.paddle.com/build/subscriptions/provision-access-webhooks/)).
- Lemon Squeezy: `subscription_created`, `subscription_cancelled`, `subscription_expired`, `subscription_updated` ([Event types](https://docs.lemonsqueezy.com/help/webhooks/event-types)).
- All three share one shape: create the Instance on the creation (Stripe: `invoice.paid`) event, keep it through past due, stop it on cancel/expiry, process events idempotently.

### EU VAT without an MoR (unchanged from pass one)
- Cross-border B2C electronic services are taxed in the customer's Member State; below an EU-wide EUR 10,000 threshold a single-state supplier may charge home VAT; above it the Union One Stop Shop (OSS) replaces per-country registration ([European Commission OSS portal](https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en)). This pass did not re-read that page.

## Recommendation and open points

1. Apply to Paddle first. Fallback: Stripe Managed Payments (Germany is supported; ask whether a sole proprietor qualifies), then Stripe + Stripe Tax with OSS filing by the operator.
2. Price with **5% + 50 cents**, assuming the VAT-inclusive base. Compare Stripe Managed Payments: about 3.5% + 1.5% + 0.25 EUR + 0.7% Billing = 5.7% + 0.25 EUR on standard EEA cards. At EUR 5 that is 0.54 EUR versus Paddle's 0.75 EUR, but Stripe's cost rises for premium or non-EEA cards.
3. Still unverifiable: Paddle's fee currency and base, Paddle's approval of a sole trader, Managed Payments eligibility of a sole proprietor.
4. Not covered: German Kleinunternehmer status for cross-border EU B2C VAT, GDPR roles of the MoR.
