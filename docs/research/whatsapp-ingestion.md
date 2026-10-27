# WhatsApp group ingestion: options and risks

Research for [issue #3](https://github.com/artkoenig/family-buttler/issues/3). Question: how can a self-hosted Family Agenda read messages, including images and PDFs, from WhatsApp groups an Admin belongs to (school class groups, sports clubs), and what does each option cost in effort, ban risk, legal exposure and maintenance?

Researched October 2026. Meta's developer docs and whatsapp.com were not directly fetchable from the research environment, so claims about them rest on search-indexed excerpts of those official pages. Re-check the linked pages before building.

## Summary

| Option | Reads existing groups? | Images / PDFs | Setup effort | Ban risk | ToS | Maintenance |
|---|---|---|---|---|---|---|
| A. WhatsApp Business Cloud API | **No.** Only groups the business number creates itself (max 8 participants) | Yes, for messages it receives | Medium (Meta business account, separate number) | None | Compliant | Low |
| B. Unofficial linked-device client (Baileys, whatsmeow, WAHA, whatsapp-web.js, mautrix-whatsapp) | **Yes**, every group the Admin's account is in | Yes | Medium (Docker + QR scan) | Real but low for receive-only use | Violates ToS | Medium–high |
| C. Manual chat export | Yes, any chat | Yes ("attach media") | None to build; manual per chat | None | Compliant | High human effort, not live |
| D. Forward messages to a bot number (on Cloud API) | Only what the Admin forwards | Yes | Medium (as A) | None | Compliant | Low tech, per-message human effort |

## A. WhatsApp Business Platform (Cloud API)

- **What it can read:** The Cloud API receives messages sent *to* a business number via webhooks. Since early 2026 it has a [Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups), but only for groups the business itself creates: max **8 participants**, participants cannot be added directly, only via an invite link, and only one Cloud API business per group ([Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups), [group reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/reference), [get started](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started)). It requires an **Official Business Account** and is unavailable to WhatsApp Business *app* numbers ([changelog, Feb 2026](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog)). A business number cannot join or read an existing 30-parent class group. **Verdict: cannot ingest the groups that matter.**
- **Self-hosting:** The On-Premises API was sunset on 23 Oct 2025 ([sunset notice](https://developers.facebook.com/docs/whatsapp/on-premises/sunset)); only the Meta-hosted Cloud API remains, so message content passes through Meta's servers before reaching the webhook.
- **Cost:** Meta resumed charging for service messages from 1 Oct 2026, with 1,000 free service messages per number per month ([pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)). Inbound messages to a bot that rarely replies stay within that.
- **Policy:** Since 15 Jan 2026 the Business Solution terms bar general-purpose AI assistants as a primary function; task-specific bots with incidental AI are still allowed ([coverage, respond.io](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban)). A private extraction bot should fit, but this is a policy surface to watch.

## B. Unofficial multi-device clients

All of these log in as an extra **linked device** of the Admin's own account (QR code or pairing code), just like WhatsApp Web. They then receive every message in every group the account is in, live, end-to-end decrypted locally.

| Library | Stack | Notes |
|---|---|---|
| [Baileys](https://github.com/WhiskeySockets/Baileys) | TypeScript, WebSocket, MIT | `downloadMediaMessage`, `groupFetchAllParticipating`, `syncFullHistory` / `fetchMessageHistory` for backfill (README). v7 introduced breaking changes. |
| [whatsmeow](https://github.com/tulir/whatsmeow) | Go, MPL-2.0 | Receive messages, group events, app state, media download code. Basis of mautrix-whatsapp and WAHA's GOWS engine. |
| [WAHA](https://github.com/devlikeapro/waha) | Docker REST API + webhooks over engines WEBJS (headless browser), NOWEB (Baileys-style), GOWS (Go) ([engines](https://waha.devlike.pro/docs/engines)) | Least code to write. Free Core runs a single session; Plus (paid) adds multiple sessions and further features (README). |
| [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) | Node + Puppeteer driving real WhatsApp Web | Heavier (Chromium) and breaks when the Web client changes. |
| [mautrix-whatsapp](https://github.com/mautrix/whatsapp) | Go bridge to Matrix (on whatsmeow) | Only worthwhile if a Matrix server already exists. |

- **Setup:** A Docker container, one QR scan from the Admin's phone. Linked devices work without the phone online, but **are logged out if the phone is unused for over 14 days**; max four linked devices ([WhatsApp FAQ: linked devices](https://faq.whatsapp.com/378279804439436/)).
- **ToS:** WhatsApp's EEA terms require use "only for legal, authorized, and acceptable purposes" and forbid reverse engineering and access "through automated means"; violations may lead to account disabling or suspension ([Terms of Service – EEA](https://www.whatsapp.com/legal/terms-of-service-eea)). Every library disclaims affiliation; whatsapp-web.js states plainly: "WhatsApp does not allow bots or unofficial clients on their platform, so this shouldn't be considered totally safe" ([README](https://github.com/pedroslopez/whatsapp-web.js#disclaimer)).
- **Ban risk:** The reported bans are overwhelmingly tied to *sending*: bulk or unsolicited messages to new contacts, status uploads, datacenter IPs, fresh accounts ([Baileys #2309](https://github.com/WhiskeySockets/Baileys/issues/2309), [#2707](https://github.com/WhiskeySockets/Baileys/issues/2707), [#2800](https://github.com/WhiskeySockets/Baileys/issues/2800), [discussion #2663](https://github.com/WhiskeySockets/Baileys/discussions/2663)). There are also waves with no clear cause hitting long-running accounts ([#1869](https://github.com/WhiskeySockets/Baileys/issues/1869)). A receive-only client on a residential IP, attached to an established personal account, is the lowest-risk profile, but the risk is not zero. The downside is losing the **Admin's personal WhatsApp account**, which is severe.
- **Maintenance:** Protocol changes break these libraries regularly (e.g., the move to `@lid` identifiers coincided with breakage and bans per #1869), so budget for frequent image or library upgrades and re-pairing.

## C. Manual chat export

- **What it reads:** WhatsApp's built-in "Export chat" produces a `.txt` plus, optionally, media files as a ZIP. Limits: about **10,000 most recent messages with media, 40,000 without**; one chat at a time; a snapshot, not a feed ([PC-Welt](https://www.pcwelt.de/ratgeber/Whatsapp-Chat-exportieren-und-teilen-so-geht-s-11015467.html), [t-online](https://www.t-online.de/digital/handy/id_100006500/whatsapp-chats-exportieren-bei-iphone-und-android-so-geht-s.html); WhatsApp's own FAQ was not reachable).
- **Effort / risk:** Zero ban or ToS risk. The text format differs by OS and locale, so the parser needs care. Works as a one-off backfill or occasional catch-up, not for "the trip slip due tomorrow".

## D. Forwarding to a bot number

- **How:** Run a Cloud API number (option A) that only receives messages. The Admin forwards relevant group messages, images and PDFs to it. Cloud API webhooks deliver the message plus a media ID for download ([webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/), [messages reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/)).
- **Reads:** Only what the Admin chooses to forward. A forward loses the original sender and group context, so the Source must be inferred or tagged, e.g. with a short caption.
- **Effort / risk:** ToS-compliant, no risk to the personal account. Needs a second phone number (a Cloud API number cannot simultaneously be a normal WhatsApp Messenger account; unverified detail, check Meta docs) and a Meta business setup. The ongoing cost is human attention per message.
- **Variant:** Forwarding to the Family Agenda's **email** ingestion (share → mail) avoids Meta entirely and reuses the email Source.

## Legal (Germany / GDPR)

- Group messages contain personal data of **third parties** (other parents, coaches, sometimes children's names and photos).
- GDPR does not apply to processing "by a natural person in the course of a purely personal or household activity" ([Art. 2(2)(c)](https://eur-lex.europa.eu/eli/reg/2016/679/oj); [Recital 18](https://gdpr-info.eu/recitals/no-18/) names private correspondence and social networking). A family reading its own groups on its own server fits this reasonably well. **But** Recital 18 keeps GDPR applicable to "controllers or processors which provide the means" for such processing, so any **cloud LLM/OCR provider** that receives the messages is in scope. Self-hosted extraction keeps the household exemption cleanest.
- The exemption holds only while the data stays within the Family: no publishing, no sharing Views outside the household, no retention beyond need. Children's data warrants minimisation (e.g., store extracted Items, drop raw messages after extraction).
- Option B adds contractual (ToS) exposure, not a GDPR problem per se. WhatsApp can disable the account; ToS violation is not itself unlawful for the user.

## Implications for Family Agenda

1. **Option A cannot satisfy the requirement.** The official API cannot read groups the family is merely a member of. Drop it as a primary Source.
2. **Recommended path:** Treat WhatsApp as a **staged Source**:
   - **Phase 1 (safe default):** Forward-to-ingest (option D), preferably via the existing **email** Source or a dedicated inbox, plus **manual export** (option C) for occasional backfill. Zero account risk.
   - **Phase 2 (opt-in, explicit Admin consent to ToS risk):** A **receive-only** linked device via **WAHA (GOWS/NOWEB engine)** or **whatsmeow** directly, behind a Source adapter so the library can be swapped. Hard rules: never send, never mark as read, residential IP, allow-list only the selected groups, alert the Admin on logout (14-day rule).
3. Design the Source interface so all WhatsApp variants deliver the same shape (group/chat name, sender, timestamp, text, attachments) into Item extraction. Then switching variants does not touch downstream code.
4. Keep extraction (OCR/LLM) **self-hosted** for WhatsApp content to stay within the GDPR household exemption, and store derived Items rather than raw third-party messages.
