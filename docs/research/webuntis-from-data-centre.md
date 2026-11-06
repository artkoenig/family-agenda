# WebUntis from a data centre: reliable, and legitimate?

Question (issue #213, under map #222): if a hosted Instance reads WebUntis from a data-centre IP for many Families, does it keep working, what do the terms and data-protection position say about an operator reading parent accounts on a Family's behalf, and is there an official or parent-sanctioned path? Decides whether WebUntis is among the hosting's launch Sources. Background: [webuntis-parent-access.md](webuntis-parent-access.md), [ADR-0004](../adr/0004-self-hosted-only-with-paid-agenda-cloud-services.md).

Research date: 2026-11-06 (second pass, with network access). Every quote below was read on the page named, today. What could still not be read is listed at the end.

## Short answer

**WebUntis should stay out of the hosted launch Sources.** The recommendation of the first pass stands, now on primary sources:

1. **Terms.** Untis publishes no end-user terms of use that I could find, and no clause about automated access or scraping exists in the documents that are published. That is silence, not permission.
2. **Legitimacy.** In Untis' own model, the school is the controller and Untis only its processor, and the school decides who gets access. The only machine-access route Untis documents is the Untis Platform API, which a **school administrator activates** for a registered platform application. No parent-sanctioned machine access exists: the parent's QR login is, per a school's guide, personal and not to be passed to third parties.
3. **Reliability.** Rate limits and a "fair use" monitoring regime are published for the Platform API only. Nothing is published for the undocumented endpoints we would use, so reliability from data-centre IPs stays untested.

An official route does exist, but through schools, not Families: become an Untis integration partner. That is a business decision, not a Source.

## 1. Automated-access or scraping clause in the terms

- Untis' [GTC page](https://www.untis.at/en/gtc) ("GTC - Untis of Gruber & Petters GmbH for entrepreneurs and educational institutions", "Valid as at 1 January 2015") is the only general terms document linked from the imprint. It governs sales and licensing between the vendor and its *Contracting Party* (a business or school). I searched it for automated access, scraping, robots, interfaces, APIs, credentials and misuse and found no such clause. It says software licensing terms are given "during installation or [...] made available in English upon request" ([GTC](https://www.untis.at/en/gtc), final licensing paragraph: "the Contracting Party undertakes to agree to the relevant software licensing terms of which it will be informed by G&P during installation or which will be made available in English upon request"), so end-user terms, if any, are not published there.
- The [privacy policy for WebUntis and apps](https://www.untis.at/en/privacy-policy-wu-apps) and the [DPA page](https://www.untis.at/en/dsgvo) contain no acceptable-use or automated-access wording either.
- Result: **no explicit clause either way.** The first pass's "unverified: no explicit ToS clause found" is now confirmed by reading the published documents. Whether the login page or the app shows end-user terms was not checked (login needs an account).

## 2. Rate limits and blocking policy

- Platform API (partners only): ["Our platform operates on the basis of the fair use principle. All requests made by every platform app are actively monitored. Nevertheless, there are strict limits: Your app may send a maximum of 40 requests per second. Furthermore, larger synchronisation jobs must be scheduled for off-peak hours. [...] Please do not carry them out during the schools' main working hours (06:00 to 09:00)."](https://developer.untis.com/api-reference/api-overview/) The same page routes all calls through "a central API gateway that handles authentication, authorization, rate limiting" and says "Do not call school-specific WebUntis server URLs directly".
- For the undocumented mobile/REST endpoints a parent login can reach (see [webuntis-parent-access.md](webuntis-parent-access.md)), **no rate limit, blocking policy or bot-protection statement is published** in any Untis document I could read. I did not probe schools' servers to test for blocking: that would be unauthorised load on third parties' systems.
- The vendor's own wording ("actively monitored", "strict limits") shows monitoring exists on the supported path. An unsupported client that concentrates many Families on a few data-centre IPs is likelier to be noticed. This is an inference, untested.
- Confirmed per-school variance: the school search at `https://schoolsearch.webuntis.com/schoolquery2` returns a separate `server`, `loginName` and `tenantId` for each school (queried with a JSON-RPC `searchSchool` call; first hit: `"server":"gymnasium-karthause.webuntis.com"`, `"tenantId":"5567100"`), and the developer docs state "Every school is a separate tenant" with isolated credentials ([authorization model](https://developer.untis.com/core-concepts/authorization-model/)).

## 3. Parent-sanctioned machine access

- **Platform API: school-side only.** "A *platform application* is the unit of integration on the Untis Platform. [...] school administrators browse available applications and activate the ones they want to use." ([overview](https://developer.untis.com/getting-started/overview/)). To get one: "Contact Untis to have yours configured in the platform application manager (PAM)." ([quick start](https://developer.untis.com/getting-started/quick-start/)). Credentials are per school: "A single set of credentials cannot be used across multiple schools." Production use "Requires an approved platform application." ([API overview](https://developer.untis.com/api-reference/api-overview/)). A Family cannot activate anything.
- The API exists in useful shape (WebUntis APIs for "Timetables, lessons, absences", a Legal Guardian Management API, a Messaging API; [developer home](https://developer.untis.com/)), so a partner integration with schools opting in is technically possible. It is school-by-school.
- **Parent QR login: personal, not transferable.** The vendor's mobile app is documented to scan QR codes for login ("Camera access is required to [...] scan QR codes for login", [privacy policy](https://www.untis.at/en/privacy-policy-wu-apps)). A school's guide for it: ["Der QR-Code enthält Ihre persönlichen Zugangsdaten. Geben Sie ihn nicht an Dritte weiter und schließen Sie das Fenster nach dem Scannen."](https://gymnasium-karthause.bildung.koblenz.de/wp-content/uploads/2026/08/Anmeldung-auf-einem-mobilen-Endgeraet-mit-QR-Code.pdf) ("The QR code contains your personal access credentials. Do not pass it on to third parties and close the window after scanning.") This is one school's guide, not an Untis rule, but it shows what the school as account issuer tells users. Uploading it to an operator is the opposite.
- No parent API, parent token or parent-granted OAuth flow appears in the developer documentation. Its OIDC authorization-code flow is for platform applications that a school has activated, with "Permissions [...] based on application config AND the user's role and school membership" ([authorization model](https://developer.untis.com/core-concepts/authorization-model/)).
- The [qr-code help page](https://webhelp.untis.at/HTML/WebHelp/uk/untis/qr-code.htm) is about something else: a printable timetable QR that sends users to the app's install page. It says nothing on login secrets.

## 4. Controller and processor

From the [Untis privacy policy for WebUntis & Apps](https://www.untis.at/en/privacy-policy-wu-apps) (last change 25.9.2026):

- "For the personal data that are processed in the course of performing the contractual service within Untis products, however, we act exclusively on behalf of and according to the instructions of our contractual partner and are therefore processors within the meaning of the GDPR. If our contractual partner is, for example, a school, then we are the controller for its account and contract data, while we act as a processor for the data processed in the application for the school (e.g., timetable and substitution planning, class register data of the pupils and teachers). The controller in this case is the school or the school authority."
- "The controller can independently set which users receive which permissions and thus which functions are activated."
- The complementary [integrations page](https://www.untis.at/en/privacy-policy-wu-integrations): "On activation of an integration, the integration partner becomes data processor as per your instruction for processing of personal data in your responsibility." Untis requires the school to have a data processing agreement with, or Untis-engaged sub-processing for, each partner.
- The [DPA (v1.10, 13.08.2026)](https://www.untis.at/fileadmin/user_upload/AVVs/Untis_AVV_UntisGmbH_EN_1_10.pdf): the Contractor "may only disclose any information regarding personal data arising from this Agreement to third parties or the data subject following the prior instruction or consent of the Customer" (the school), and its security measures state "User access to the WebUntis application and its add-on modules is password protected. The permission system allows for restrictions of access and competence."

Consequence for us: the data we would read (a child's timetable, class register data, school messages) is data the **school controls**. Untis' contractual design is that third parties get at it only on the school's instruction (activated integrations with a processor agreement). An operator that logs in with a parent's credentials sits outside that design, with no agreement with the controller. Whether that is unlawful under the GDPR or national law is a legal question I did not resolve (the GDPR text itself was not read); the point for scope is that it has no sanctioned footing.

## Implications for launch scope

- Do not list WebUntis among the hosted launch Sources. Keep it self-hosted only, as ADR-0004 says (a Family reading its own account from its own Instance).
- Routes that could change this, each a decision for the owner: (a) apply to Untis for a platform application and ask schools to activate it (school-by-school, partner approval, rate-limited at 40 requests per second per app); (b) ask Untis in writing, via the privacy contact in its policy, whether Family-authorised automated parent access is allowed; (c) forward WebUntis e-mail notifications into the email Source as a degraded fallback.

## Still unverified

1. `help.untis.at` (including the Platform API partner article and the WebUntis release notes on 2FA) is behind a Cloudflare challenge ("Just a moment...", HTTP 403) for non-browser clients. I did not try to bypass it. The current partner documentation has moved to developer.untis.com, which I read.
2. End-user terms shown at WebUntis login or in the Untis Mobile app / app-store listing: not published at a fetchable URL that I found.
3. Real-world blocking behaviour from data-centre IPs: untested, deliberately.
4. The GDPR and national school-data law: not read; the legal conclusion above is out of scope.
