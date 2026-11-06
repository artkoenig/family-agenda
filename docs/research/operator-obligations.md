# What hosting a Family's data obliges the operator to do

> **Not legal or tax advice.** This is research material for the operator to take to a lawyer (IT/data-protection law) and a tax advisor (Steuerberater). It names the provisions to ask about; it does not decide any of them.
>
> **Verification status: unverified against fetched text.** Research date 2026-11-06 (issue #217, map #222). Every primary-source host was unreachable from the research sandbox (`eur-lex.europa.eu`, `www.gesetze-im-internet.de`, `edpb.europa.eu`, `www.bfdi.bund.de`, `www.datenschutzkonferenz-online.de` all failed DNS resolution). The provisions below are therefore cited **by article or section number from the researcher's own knowledge, not read from the statute text in this session**. Treat each citation as a pointer to check, not as a quotation. The one secondary source used is marked as such. Section "How to verify" lists the URLs to open. Figures (thresholds, deadlines, fees) are the most likely to be stale and are marked *check*.

## Short answer

Hosting makes the operator, for Family Instance data, most probably a **processor (Auftragsverarbeiter, Art. 28 GDPR)** and, for its own customer, billing and website data, a **controller**. The first role needs an AVV, a sub-processor list, records of processing (Art. 30(2)), security measures (Art. 32), breach notification to the customer (Art. 33(2)) and deletion or return on cancellation (Art. 28(3)(g)). The second needs a Datenschutzerklärung (Art. 13). As a seller to consumers the operator also needs an Impressum (§ 5 DDG), AGB, a withdrawal notice (§§ 312g, 355 BGB), a Kündigungsbutton (§ 312k BGB) and compliant renewal terms (§ 309 Nr. 9 BGB). As an Einzelunternehmer it needs a Gewerbeanmeldung (§ 14 GewO) and tax registration, with VAT either charged or waived under the Kleinunternehmerregelung (§ 19 UStG), and it is personally liable without limit.

None of this blocks a one-person operation. Three points are genuinely open and are the first questions for the lawyer:

1. **Is the operator a processor or a controller for a purely private household?** The household exemption (Art. 2(2)(c)) may mean the Family is not a controller, so there is no controller to bind the operator by an AVV. See section 1.
2. **Key custody.** ADR-0006 keeps the master key on the Instance's volume. If the operator runs that volume, the operator can read everything, so "encrypted at rest" does not protect Family data from the operator. This shapes the Art. 32 statements and what may be promised in the contract.
3. **EU Data Act switching rules** may apply to the promised data export (section 6.4).

## 1. Role under GDPR

### 1.1 Processor for the Family, in the usual reading

- **Processor definition:** Art. 4(8) (processes personal data on behalf of the controller); controller: Art. 4(7). The operator runs the Instance and its Sources, extraction pipeline and storage for the Family and does not decide purposes. That fits Art. 4(8). Guidance: EDPB Guidelines 07/2020 on the concepts of controller and processor in the GDPR (v2.1, 2021); DSK Kurzpapier Nr. 13 "Auftragsverarbeitung".
- **Staying a processor:** Art. 28(10): a processor that determines purposes and means of processing itself is a controller for that processing. So the operator must not use Family data or message text for its own purposes: no analytics on content, no model training, no product telemetry derived from content.
- **LLM included (map #212):** the extraction prompt carries the text of Family mail, including third parties' data. The LLM provider is a sub-processor (1.3).

### 1.2 The household exemption problem *(question for the lawyer)*

- Art. 2(2)(c) excludes processing "by a natural person in the course of a purely personal or household activity". Recital 18 adds that the Regulation still applies to "controllers or processors which provide the means for processing personal data for such personal or household activities".
- Consequence: a Family using the Instance for its own organisation is probably outside the GDPR as to that processing, but the operator who provides the means is inside it. Whether the operator is then a processor for a controller who is not subject to Art. 28, or a controller itself for that processing, is not settled by the text. EDPB Guidelines 07/2020 should be read for the case of providers of means to private users.
- Practical position either way: sign an AVV-equivalent (it costs little, and Art. 28(3) content is the right content), behave as a processor (28(10)), and let the lawyer decide the wording of the role clause.
- A Family is a consumer (§ 13 BGB), but nothing says every customer is: a Family Agenda used by a small business or a school class would not be exempt. The terms can limit the offering to private households, which also helps with the consumer-law choices below.

### 1.3 The AVV (Art. 28)

Art. 28(3) lists the minimum content of the contract; Art. 28(9) allows electronic form. Points the AVV must cover, with where they bite in this product:

| Art. 28 point | Content | Product-specific note |
|---|---|---|
| 28(3) intro | Subject, duration, nature, purpose, data types, data subjects, controller's rights | Data subjects: Family Members including children, and third parties in mail (teachers, other parents, other children). Data types include Items, raw messages, attachments (ADR-0006 blobs), Source credentials |
| 28(3)(a) | Process only on documented instructions | Instruction = the Admin's configuration of Sources and Agendas |
| 28(3)(b) | Confidentiality commitment of persons authorised | Applies to the operator's support access. One person, but state it |
| 28(3)(c) | Security measures, Art. 32 | See 3 |
| 28(2), 28(4) | Sub-processors only with prior authorisation (general or specific), same obligations flowed down, operator stays liable | Host, backup storage, LLM provider, payment/MoR (the MoR is likely the operator's or its own controller, not a sub-processor of Family data: check) |
| 28(3)(e) | Assist with data-subject requests | Export function, deletion of an Item or a Family Member's data |
| 28(3)(f) | Assist with Art. 32 to 36 | Breach, DPIA support |
| 28(3)(g) | Delete or return all data at the end, at the controller's choice, and delete copies | See 5 |
| 28(3)(h) | Provide information and allow audits | Offer documentation and a questionnaire; on-site audits for one operator can be limited by contract (lawyer) |

The Commission's standard contractual clauses for controller-processor contracts (Implementing Decision (EU) 2021/915) are a free, authoritative template for this content *(check number)*.

**Sub-processor list to keep:** hosting provider (EU region), off-site backup target (ADR-0004 had Agenda Cloud storage; for hosting it is the host's or another provider's storage), LLM provider, email/transactional sender, monitoring or error tracking if it can see content (avoid). Each needs its own Art. 28 contract with the operator and, if outside the EU/EEA, a Chapter V transfer basis (Art. 44 to 46: adequacy decision such as the EU-US Data Privacy Framework decision of July 2023, or SCCs plus transfer assessment). Prefer EU hosting for all of them, as ADR-0004 already required for the LLM.

### 1.4 Operator as controller for its own data

Customer account, contact, billing and website visitor data are the operator's own purposes: it is controller (Art. 4(7)). That needs a **Datenschutzerklärung** with the Art. 13 content (identity, purposes, legal basis such as Art. 6(1)(b) and (f), recipients including the MoR and host, retention, rights, right to complain to a supervisory authority). If the website sets non-essential cookies or similar storage, § 25 TDDDG (formerly TTDSG) requires consent; a site without trackers avoids that. A privacy notice is needed even when there is no cookie banner.

## 2. Records, DPO, breaches, fines

- **Records of processing, processor version:** Art. 30(2). The exemption for fewer than 250 employees in Art. 30(5) does not apply when the processing is not occasional or includes special categories, so assume the records are required. DSK publishes processor-record templates (Muster Verzeichnis von Verarbeitungstätigkeiten). Also keep a controller record for the operator's own data (Art. 30(1)).
- **DPO:** Art. 37(1) and § 38 BDSG: designation duty at 20 or more persons constantly engaged in automated processing, or where core activity is large-scale special-category processing, or a DPIA-required processing. A one-person operator is below the headcount; the lawyer should confirm the "core activity" limb given health data possibly present in school mail (see 4).
- **Breach:** Art. 33(2): the processor notifies the controller "without undue delay" after becoming aware. Art. 33(1) gives the controller 72 hours to the authority, so the AVV should fix a short internal notice time (for example 24 hours). Needs an incident log and a contact address that is read (a one-person operator needs a stand-in plan for holidays).
- **Liability and fines:** Art. 82(2) (processor liable for damage where it did not comply with processor obligations or acted outside instructions); Art. 83(4) fines up to EUR 10 million or 2 percent of turnover for Art. 28, 30, 32, 33 breaches. Art. 79/80 allow civil claims and representative actions. Note that GDPR damages are not limited by AGB against data subjects.

## 3. Security (Art. 32) and key custody

- Art. 32(1) requires measures "appropriate to the risk", naming pseudonymisation and encryption, confidentiality, integrity, availability and resilience, restore ability, and regular testing. Art. 32(4): persons acting under authority process only on instructions.
- Child and family data, third parties' mail text and credentials to mailboxes make a high-impact breach: a leak exposes children's schedules, schools, sick notes and Source credentials that open the parents' mailboxes. Read the risk accordingly.
- **ADR-0006 interaction.** The master key is a file in its own volume, and backups exclude it; the Admin keeps a recovery kit. That model assumes the Family holds the Instance. When the operator runs the machine:
  - the operator (or anyone with host access) can read the master key and the blobs, so encryption protects against dump leaks and a stolen backup, not against the operator;
  - the claim in ADR-0004 that backup storage "stores only ciphertext" holds only if the backup key stays out of the operator's reach, which conflicts with operating restores for a non-technical Family;
  - the contract and privacy notice must not promise that the operator cannot read Family data unless the architecture makes that true.
  - This is for the spec ticket on key custody; legally it only needs the statements to be accurate (§ 5 UWG on misleading statements, and the Art. 28(3)(c) description in the AVV).
- Operator access to Instances for support is itself processing: log it, restrict it, and say in the AVV when it happens.
- Art. 35 DPIA: the DSK/BfDI lists of processing operations that require one (Muss-Listen) should be checked for "processing of children's data" and "extraction by AI of personal data". The DPIA duty is the controller's, but the processor assists (28(3)(f)); a lightweight DPIA by the operator is cheap insurance.

## 4. Special points

### 4.1 Children's data

- Art. 8 (age of consent for information society services) concerns services offered **directly to a child**. The Admin is a parent and Agendas show Items to the Family; the service is not offered to children, so Art. 8 is probably not triggered. Lawyer to confirm, especially if Agenda Links are ever opened by children.
- Recital 38 and Recital 75 mark children as deserving specific protection and as vulnerable data subjects, which raises the risk assessment under Arts. 24, 25, 32, 35.
- School mail may carry **special categories** (Art. 9): health (sick notes, allergies, medical appointments), religion (religious education, holidays), possibly ethnicity or disability (support measures). The processing is on the Family's instructions, and the Family's own exemption (1.2) is the open point; for the operator's side Art. 9(2) needs a condition, and the lawyer should say whether acting as processor on the instruction of a household suffices.
- Data minimisation and privacy by design (Art. 5(1)(c), Art. 25) fit the existing design: Items are projections, raw messages are deletable (ADR-0016).

### 4.2 Third parties' data inside mails

- Art. 14 requires the controller to inform people whose data was not collected from them. Art. 14(5)(b) excepts cases where informing is impossible or disproportionate. A Family reading its own mail is within the household exemption (1.2) and owes no Art. 14 notice. The operator, as processor, does not itself owe Art. 14 notices (they are the controller's duty), but if the operator were a controller for this processing (1.2), the question reappears for every teacher or other parent named in a mail. Lawyer question.
- Safe operating line: the operator never reads, shares or reuses message content beyond running the service (28(10)); retention follows the Family's deletion choices; the LLM provider must not train on the content (contract term and technical setting at the provider).
- Art. 15 to 22 requests from a third party ("what do you hold about me?") go to the controller; the AVV must say how the operator forwards and assists within days. With one Instance per Family (ADR-0013) the operator can locate data by Family, but it cannot search across Instances without opening them, so the AVV should say who answers what.

## 5. Retention and deletion on cancellation

- **Art. 28(3)(g):** at the end of the services, delete or return all personal data, at the controller's choice, and delete existing copies unless Union or Member State law requires storage. Art. 5(1)(e) storage limitation; Art. 17 erasure.
- **Backups:** copies in backups are copies. The contract and the privacy notice should state a fixed rotation window after which deleted data is gone from backups (a number of days) rather than promise instant deletion. Art. 28(3)(g) does not give a grace period; document the window as part of the security measures.
- **Export before deletion:** return of the data is the controller's option under 28(3)(g), and map #212 promises data export. A defined sequence works: cancellation takes effect, an export window of N days follows with the Instance read-only, then deletion of the Instance, its volumes (Postgres, blobs, master key, recovery kit copies), and its backups in the next rotation. ADR-0016's sweep removes unreferenced files; deletion of the whole Instance is a separate operator procedure to design.
- **Operator's own retention:** invoices and accounting records are kept despite a deletion request: § 147 AO and § 257 HGB (retention periods of 6 to 10 years; the 10-year period for invoices and books was shortened to 8 years from 2025 *(check)*; § 14b UStG for invoices). These are the operator's controller records (1.4), kept separate from Family data. Art. 17(3)(b) is the exception to erasure for legal obligations.
- **Inactive or non-paying customers:** decide how long an unpaid Instance is kept before deletion and write it in the terms, since silent deletion of a Family's data is a contract problem and silent keeping is an Art. 5(1)(e) problem.

## 6. Consumer-facing duties

### 6.1 Impressum

§ 5 DDG (Digitale-Dienste-Gesetz, which replaced the TMG on 14 May 2024 *(check date)*): easily recognisable, directly reachable, permanently available information: name and address (a postal address where documents can be served; a post-office box is not enough), a way to reach the operator quickly (email plus a second means such as a form or phone, with ECJ case law that a phone number is not always required: lawyer), the VAT identification number if one exists (§ 27a UStG), and the trade register or professional information where applicable. A Kleinunternehmer without a VAT ID omits it. The Impressum is the operator's home address unless a business address is rented; that is a privacy cost for a one-person operator and a reason to price an address service. Editorial responsibility in § 18 MStV applies only to journalistic offers; not expected here.

### 6.2 Contract formation, information and AGB

- E-commerce duties: § 312i BGB (technical means to correct input errors, confirmation of receipt) and **§ 312j(3) BGB** the order button must say clearly that the order means a payment obligation ("zahlungspflichtig bestellen" or equivalent); otherwise no contract arises (§ 312j(4)).
- Pre-contractual information: Art. 246a EGBGB for distance contracts (main features, total price including taxes and recurring charges, contract duration and termination conditions, withdrawal information, functionality and interoperability of digital content). Price statements: PAngV (final prices incl. VAT to consumers).
- **AGB** (§§ 305 to 310 BGB) are not mandatory, but the offer needs terms. Against consumers, clauses are tested under § 307 and the black lists §§ 308, 309. Relevant: liability limits are restricted by **§ 309 Nr. 7** (no exclusion for injury to life, body, health, or gross negligence/intent) and cardinal duties; clauses changing price or services unilaterally are restricted (§ 308 Nr. 4 and § 309 Nr. 1 and for digital products § 327r BGB). AGB in German, as the offer targets DACH. Custom contract terms are the biggest item to have drafted by the lawyer.
- **Digital products law, §§ 327 ff. BGB:** a paid hosted service is a "digital product" contract with a consumer. The operator owes **updates** to keep the service conforming (§ 327f), conformity standards (§§ 327e, 327d), consumer remedies (§ 327i ff.), and modification of the service only for a valid reason named in the contract with notice and a right to terminate (§ 327r). Contract termination with return of the consumer's content (§ 327p, § 327q): the consumer can demand their content back free of charge, which lines up with the export promise and with Art. 28(3)(g). Check the interaction of 327 ff. with a free-of-charge **trial**.
- **Dispute resolution notice:** § 36 VSBG (state whether the operator takes part in consumer arbitration). The EU Online Dispute Resolution platform was shut down in July 2025 *(check)*, so a link to it is no longer expected.

### 6.3 Withdrawal and cancellation of a monthly subscription

- **Withdrawal (Widerruf):** consumer distance contracts carry a 14-day withdrawal right (§§ 312g, 355 BGB) with a formal notice (Art. 246a § 1 EGBGB, model notice in Anlage 1). For services started inside the period, the withdrawal right can lapse early only if the consumer expressly asked for the start and acknowledged the consequence (§ 356(4) BGB), and otherwise the consumer owes a proportionate payment (§ 357a BGB). For digital content not on a physical medium, § 356(5) applies. A fully hosted service is a continuous service, so § 356(4)/§ 357a is the relevant path; the onboarding flow must capture the express request, which affects the sign-up UX. A Merchant of Record (map #212) may run checkout, but the withdrawal duties stay with whoever is the seller.
- **Kündigungsbutton, § 312k BGB** (in force since 1 July 2022): applies to consumer contracts concluded on a website that create a continuing obligation for payment. The operator must offer a continuously and directly accessible, easily readable button or link labelled with the words "Verträge hier kündigen" or an unambiguous equivalent (§ 312k(2)), leading to a confirmation page where the consumer enters or confirms their identity, the contract, the termination type and time, and a button labelled "Jetzt kündigen" or equivalent. The operator must confirm receipt at once in Textform with the date and time (§ 312k(4)); a missing or faulty button gives the consumer a termination right at any time without notice (§ 312k(6)). Whether the button and confirmation page must work without a prior login is a point to confirm in § 312k(2) *(check)*. Secondary source (not verified against the statute): a July 2026 BGH decision reported by [Otto Schmidt](https://www.otto-schmidt.de/news/wirtschaftsrecht/online-kundigung-bestatigungsseite-darf-keine-informationen-zu-kundigungsalternativen-enthalten-2026-07-16.html) holds that the confirmation page must not carry information about alternatives to cancelling, because § 312k(2) sentence 3 lists its content exhaustively. The lawyer should confirm the case and its file number. A hosted-offering consequence: pause or downgrade offers cannot sit on that page.
- **Term and renewal, § 309 Nr. 9 BGB** (since 1 March 2022): in AGB against consumers the initial term may be at most two years, silent renewal only into an indefinite term cancellable on one month's notice, and notice periods for the initial term at most one month. A monthly plan with monthly cancellation is consistent with this. § 314 BGB keeps termination for cause.
- **UWG:** § 5 and § 5a (misleading statements and omissions: "secure", "private", "your data never leaves"), § 7 (marketing email needs prior consent, with the existing-customer exception in § 7(3)). Also relevant to the landing page and to price advertising (PAngV).

### 6.4 EU Data Act: switching and export *(question for the lawyer)*

Regulation (EU) 2023/2854, applicable since 12 September 2025 *(check)*, contains switching rules for providers of "data processing services" (Chapter VI, Arts. 23 to 31): contract terms on switching, a maximum notice period, a transition period, export of "exportable data", and phased removal of switching charges. A hosted SaaS Instance may be such a service, and its "customers" include natural persons. Art. 31 provides lighter treatment for some providers and custom services; whether it covers a one-person operator is open. This could turn the promised "data export" from a feature into a legal requirement with defined contract content.

### 6.5 AI

Regulation (EU) 2024/1689 (AI Act): the extraction uses a third-party LLM on Family text and does not look like a high-risk use or a chatbot. Art. 50 transparency duties and the provider/deployer split should be checked once, so the operator can state in one line why they do not apply. Not expected to bind at launch.

## 7. Business formalities for an Einzelunternehmen

| Topic | Rule | Note |
|---|---|---|
| Gewerbeanmeldung | **§ 14 GewO**: notify the trade office (Gewerbeamt) of the municipality at start, with a fee set by the municipality *(check)*. | Software hosting is a trade, not a freiberufliche activity (lawyer or tax advisor to confirm). The Gewerbeamt forwards to the tax office and IHK |
| Tax registration | **§ 138 AO**: the Fragebogen zur steuerlichen Erfassung, electronically through ELSTER; the Finanzamt then issues the tax number and decides on prepayments | A side income in addition to employment is still reported |
| Chamber | IHK membership follows from the trade registration (IHKG); small traders are often exempt from contributions below a profit limit *(check)* | |
| Trade register | A Kleingewerbetreibender without commercial-scale business is not required to register (§ 1 HGB) and may use the personal name | A trade name needs care (§§ 17 ff. HGB; § 5 UWG) |
| Kleinunternehmerregelung | **§ 19 UStG** (reformed from 1 January 2025 *(check)*): no VAT charged if turnover in the previous year was at most EUR 25,000 and in the current year stays at most EUR 100,000 (exceeding the second limit makes VAT due from that sale). Invoices carry a note that no VAT is shown; no input VAT deduction | The scheme is the default, and opting out binds for five years (§ 19(2) UStG *(check)*). For cross-border EU sales the 2025 reform added a Kleinunternehmer scheme in other member states: ask the tax advisor, since DACH includes Austria and Switzerland (outside the EU) |
| VAT otherwise | Regular VAT on B2C digital services; for EU consumers outside Germany the destination-country rate and the OSS procedure (§§ 18j to 18k UStG; the EUR 10,000 cross-border threshold) | A **Merchant of Record** (map #212) takes over VAT collection and remittance, issues the invoices to consumers and pays the operator a net amount. That reduces the operator's VAT work, but the operator's own income then comes from the MoR relationship: its VAT status, invoicing duties to the MoR (B2B), and who is "seller" in the Impressum and withdrawal notice are for the tax advisor and lawyer |
| Income and trade tax | Income tax on profit; **Gewerbesteuer** with an allowance of EUR 24,500 for sole traders (§ 11(1) GewStG) | Small side income usually pays no Gewerbesteuer. Bookkeeping: Einnahmenüberschussrechnung (§ 4(3) EStG) is enough below the limits for double-entry bookkeeping (§ 141 AO) |
| Liability | A sole trader is personally liable with all private assets (§ 823, § 280 BGB, Art. 82 GDPR). | AGB can narrow contractual liability within § 309 Nr. 7 and § 307, but not liability for intent, health damage or GDPR claims of data subjects. Options for the lawyer: business liability and cyber insurance (price is market data, not a legal rule) and a later UG (haftungsbeschränkt) or GmbH once revenue justifies it |

## 8. What the operator must have in place, as a checklist

Before the first paying Family:

1. Gewerbeanmeldung, tax registration, decision on Kleinunternehmer vs VAT, MoR contract.
2. Impressum and Datenschutzerklärung on the website.
3. AGB, price information, withdrawal notice and the express-start consent step, Kündigungsbutton and confirmation page, § 312j button text.
4. AVV (or role clause as the lawyer decides) with sub-processor list, TOMs annex and deletion/export sequence.
5. Contracts with every sub-processor (host, backup, LLM provider, mailer), EU region, no-training terms for the LLM.
6. Records of processing (Art. 30(1) and (2)), breach procedure with a stand-in, support-access policy and log.
7. A deletion procedure for a whole Instance including backups, and a written backup rotation window.
8. A statement of what the operator can read (key custody) that is true.

Costs to ask the lawyer and tax advisor to quote (not established here): AGB, Widerrufsbelehrung and Datenschutzerklärung drafting or a maintained template subscription; AVV template and review; tax advisor setup and annual statements; Gewerbeanmeldung fee; Impressum address service if the home address is to be avoided; liability and cyber insurance; sub-processor fees that rise with the number of Families (per-Instance infrastructure cost is a product question, not a legal one).

## 9. Open questions for the lawyer and tax advisor

1. Processor or controller for a purely private household (1.2), and the exact form of the AVV or role clause.
2. Whether Art. 9 data in school mail needs a documented condition on the operator's side, and whether a DPIA is expected (3, 4.1).
3. Third-party notice duties if the operator counts as controller (4.2).
4. Key custody and how the contract may describe operator access (3).
5. Data Act switching rules for a micro operator, and how they fit the export promise (6.4).
6. Merchant of Record: who is the seller towards the consumer, who carries withdrawal and cancellation duties, who appears in the Impressum, and the operator's VAT position with the MoR (7).
7. Kündigungsbutton design against the July 2026 case law, and the withdrawal flow for an immediately started service (6.3).
8. Austria and Switzerland within DACH: consumer-law and data-protection law differ (Swiss FADP; Austrian ABGB/KSchG/FAGG). This research covers Germany and the EU only.
9. Entity form: when to move from Einzelunternehmen to a limited-liability form.

## How to verify (primary sources to open)

- GDPR: https://eur-lex.europa.eu/eli/reg/2016/679/oj (Arts. 2, 4, 5, 8, 9, 13, 14, 25, 28, 30, 32 to 37, 44 to 46, 82, 83; Recitals 18, 38, 75).
- Commission SCCs for controller-processor: https://eur-lex.europa.eu/eli/dec_impl/2021/915/oj
- EDPB Guidelines 07/2020 (controller and processor): https://www.edpb.europa.eu (Guidelines section).
- DSK Kurzpapiere (Nr. 1 records, Nr. 13 Auftragsverarbeitung, Muss-Liste for DPIA): https://www.datenschutzkonferenz-online.de
- BDSG § 38: https://www.gesetze-im-internet.de/bdsg_2018/__38.html
- BGB §§ 305 to 310, 312g, 312i, 312j, 312k, 314, 327 ff., 355 to 357a: https://www.gesetze-im-internet.de/bgb/
- EGBGB Art. 246a and Anlage 1: https://www.gesetze-im-internet.de/bgbeg/
- DDG § 5: https://www.gesetze-im-internet.de/ddg/__5.html; TDDDG § 25: https://www.gesetze-im-internet.de/ttdsg/
- UWG §§ 5, 5a, 7; PAngV; VSBG § 36; GewO § 14; AO §§ 138, 147; HGB §§ 1, 257; UStG §§ 14b, 19, 27a: all under https://www.gesetze-im-internet.de/
- Data Act: https://eur-lex.europa.eu/eli/reg/2023/2854/oj; AI Act: https://eur-lex.europa.eu/eli/reg/2024/1689/oj
- Repo context: [ADR-0004](../adr/0004-self-hosted-only-with-paid-agenda-cloud-services.md), [ADR-0006](../adr/0006-encrypted-secrets-and-file-based-blobs.md), [ADR-0013](../adr/0013-an-instance-is-one-family-without-family-ids.md).
