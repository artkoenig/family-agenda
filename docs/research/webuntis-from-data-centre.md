# WebUntis from a data centre: reliable, and legitimate?

Question (issue #213, under map #222): if a hosted Instance reads WebUntis from a data-centre IP for many Families, does it keep working, what do the terms and data-protection position say about an operator reading parent accounts on a Family's behalf, and is there an official or parent-sanctioned path? Decides whether WebUntis is among the hosting's launch Sources. Background: [webuntis-parent-access.md](webuntis-parent-access.md), [ADR-0004](../adr/0004-self-hosted-only-with-paid-agenda-cloud-services.md).

Research date: 2026-11-06.

## Method and limits (read first)

The research sandbox could not fetch any primary source. `untis.at`, `help.untis.at`, `webhelp.untis.at`, `schoolsearch.webuntis.com`, `eur-lex.europa.eu` and school sites all failed to resolve (outside the allowed network). Only search-engine extracts were available. Every claim below is therefore marked *(search extract)* or *unverified*, and nothing here quotes a contract clause. The Untis terms of use / AGB were **not found at all**, even through search. Before the decision is final, someone with open network access should read the pages listed under "To verify".

## Short answer

**No: WebUntis is not clearly acceptable as a launch Source for a hosted offering.** Technically it may well work, but nothing found shows it is reliable from data-centre IPs, and no official path lets an operator read a parent account on a Family's behalf. Legitimacy is the weaker side: the parent account is issued and controlled by the school, school guides (repeating the vendor's flow) tell users not to hand the QR login to third parties, and the only documented machine-access route (Untis Platform API) is for integration partners under a school-side arrangement. This agrees with ADR-0004, which keeps WebUntis on the self-hosted Instance. Recommendation: leave WebUntis out of the hosted launch Sources; keep it as a self-hosted-only Source (the Family's own Instance, home IP, own credentials).

## Findings

### 1. Technical reliability from a data centre: unknown, no evidence either way

- No published rate limits, IP-blocking policy or bot protection were found for any endpoint *(search extract)*. Absence of documentation is not evidence that none exists.
- The endpoints used are undocumented and shared with the vendor's own apps ([webuntis-parent-access.md](webuntis-parent-access.md), section 5). They can change without notice.
- Each school runs on its own server/tenant with its own role rights, so behaviour differs per school; a hosted service would face per-school variance for every Family.
- Concentrating many Families' polls on a few data-centre IPs is a different traffic pattern from one parent's home IP and more likely to be rate-limited or blocked. This is an inference, untested.

### 2. Terms of use: not found

- The Untis terms of use / AGB for automated access were not located. A search for them returned only school privacy notices and third-party pages *(search extract)*. No clause permitting or forbidding automated access is confirmed. The prior note reached the same result.
- Untis publishes a privacy policy for WebUntis apps ([untis.at/en/privacy-policy-wu-apps](https://www.untis.at/en/privacy-policy-wu-apps)), a DPA page ([untis.at/en/dsgvo](https://www.untis.at/en/dsgvo)) and a page on platform integrations ([untis.at/en/privacy-policy-wu-integrations](https://www.untis.at/en/privacy-policy-wu-integrations)). Only their titles and snippets were seen *(search extract)*; contents are unverified.

### 3. Data-protection position

- Untis describes itself as either controller or processor under the GDPR, depending on the functionality and the contract with the school *(search extract of the Untis pages)*.
- School notices typically name the **school as controller** and Untis (or a regional entity such as Untis Bayern GmbH) as processor under a written contract *(search extract: [Niedersachsen notice](https://soziales.niedersachsen.de/download/151936/Informationen_zur_Schuelerdatenverarbeitung.pdf), school notices)*.
- Parents access their own and their child's data through the school's account *(search extract, Bavarian school notice)*. That makes the school the party that can say what third parties may touch.
- An operator logging in to many Families' parent accounts would process Families' and children's data on the Family's instruction. Whether that fits school consent texts, which are written for the school's own use of WebUntis, was not found addressed anywhere. *Unverified; legal advice needed.* The GDPR text itself (Arts. 4, 6, 28) could not be fetched and is not quoted here.
- Practical risk: the school can revoke or restrict the account, and the Family cannot override that.

### 4. Official or parent-sanctioned access paths

| Path | Status |
|---|---|
| Untis Mobile QR / secret ("Freigaben" tab, "Zugriff über Untis Mobile") | Sanctioned for the parent's **own Untis Mobile app**. School guides state the QR code carries personal access credentials and must not be passed to third parties *(search extract: [Gymnasium Karthause guide](https://gymkarthause.bildung.koblenz.de/wp-content/uploads/2026/08/Anmeldung-auf-einem-mobilen-Endgeraet-mit-QR-Code.pdf))*. Uploading it to an operator is the opposite of that guidance. Vendor help: [webhelp.untis.at qr-code](https://webhelp.untis.at/HTML/WebHelp/uk/untis/qr-code.htm), unread. |
| Untis Platform API (OAuth, REST) | Documented, but for integration partners; needs a partnership and school-side activation *(search extract, see the prior note)*. Not available to a parent or a Family-side operator. |
| Legacy JSON-RPC | Spec on request only; the `webuntis` npm author says he may not publish it ([Readme](https://github.com/SchoolUtils/WebUntis/blob/master/Readme.md)). Not a sanctioned route for parents. |
| Parent API | None found. |
| E-mail forwarding of WebUntis messages (parent profile setting) | Parent-controlled, documented feature; covers messages only, not timetable or homework. Could feed the email Source. |

## Implications for launch scope

- Do **not** list WebUntis among the hosted launch Sources. Reading parent accounts from a data centre has no sanctioned basis, unknown reliability, and a school as data controller who has not agreed.
- Keep WebUntis as a self-hosted Source, consistent with ADR-0004.
- Possible later routes, each needing a decision: an Untis integration-partner agreement (schools would also need to opt in); asking Untis in writing (datenschutz@untis.at is the stated privacy contact *(search extract)*) whether Family-authorised automated access is permitted; email forwarding as a degraded hosted fallback.

## To verify (needs open network access)

1. Untis terms of use / AGB and any acceptable-use or automated-access clause.
2. The three untis.at privacy/DPA pages above, for roles and third-party access.
3. The `help.untis.at` articles on the Untis Platform API (partner terms) and on Untis Mobile access.
4. GDPR Arts. 4(7)-(8), 6, 28 and the relevant national school-data law, for a lawyer's reading.
5. An empirical test from a data-centre IP against a test school, if the owner decides to pursue this.
