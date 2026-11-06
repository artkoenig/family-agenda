# What hosting a Family's data obliges the operator to do

> **Not legal or tax advice.** This is research material for the operator to take to a lawyer (IT and data-protection law) and a tax advisor (Steuerberater). It names provisions and quotes their text; it does not decide how they apply to Family Agenda.
>
> **Verification status.** Research date 2026-11-06 (issue #217, map #222). A first version was written from recall because the primary-source hosts were unreachable. This version re-reads the primary texts. Every citation is marked:
> - **[read]**: the text was fetched and read in this session, from the URL given;
> - **[secondary]**: read, but not a primary source (commentary, trade-body guidance);
> - **[unverified]**: not read (from recall or a pointer only); check before relying on it.
>
> How the texts were obtained: German statutes from `www.gesetze-im-internet.de`; GDPR, Data Act, Directive (EU) 2023/2673 and Decision (EU) 2021/915 as the Official Journal XHTML from the Publications Office (`publications.europa.eu/resource/cellar/...`) because `eur-lex.europa.eu` answers scripts with a bot challenge (not circumvented); Swiss federal law from `www.fedlex.admin.ch`; BGH press releases from `www.bundesgerichtshof.de`; Paddle terms from `www.paddle.com`; EDPB and DSK pages from their sites. `ris.bka.gv.at` (Austrian law) also answers with a bot check, so Austrian statutes were **not** read.

## Short answer

For the Family's data in an Instance the operator is, on the available guidance, a **processor (Art. 28 GDPR)**. It needs an AVV, a sub-processor list, records of processing (Art. 30(2)), appropriate security (Art. 32), breach notice to the customer (Art. 33(2)) and deletion or return at the end (Art. 28(3)(g)). For its own customer, billing and website data it is a **controller** (Datenschutzerklärung, Art. 13). As a seller to consumers it also needs an Impressum (§ 5 DDG), terms (AGB), the withdrawal notice and, new since 19 June 2026, a **withdrawal function** (§ 356a BGB), the **Kündigungsbutton** (§ 312k BGB), and renewal terms within § 309 Nr. 9 BGB. As an Einzelunternehmen it needs a Gewerbeanmeldung (§ 14 GewO) and tax registration (§ 138 AO), with VAT either charged or waived under § 19 UStG, and it is personally liable without limit.

**"Nothing blocks a one-person operation" still holds.** Nothing read creates a headcount, capital, licence or registration threshold that a sole trader cannot meet. Four things raise the cost or change the design, and are the questions for the lawyer:

1. **DPO.** § 38(1) sentence 2 BDSG requires a Datenschutzbeauftragter regardless of headcount if the processing is subject to a DPIA under Art. 35. Whether processing children's data and school-mail content with an LLM needs a DPIA is therefore not a side question (section 3).
2. **Key custody.** With the operator running the volume, ADR-0006's master key does not protect Family data from the operator (section 3).
3. **EU Data Act switching rules** may apply to the promised export, with no micro-enterprise carve-out in the switching chapter (section 6.4).
4. **Merchant of Record.** Paddle's terms make Paddle the seller of record, but the Supplier keeps the service, support and cancellation duties (section 6.6).

## 1. Role under GDPR

### 1.1 Processor, in the usual reading

- **[read]** Art. 28(10) GDPR: "if a processor infringes this Regulation by determining the purposes and means of processing, the processor shall be considered to be a controller in respect of that processing." So the operator must not use Family data or message text for its own purposes: no content analytics, no model training, no product telemetry derived from content. https://eur-lex.europa.eu/eli/reg/2016/679/oj
- **[read]** EDPB Guidelines 07/2020 on the concepts of controller and processor, version 2.1 (20 September 2022): https://www.edpb.europa.eu/system/files/documents/2023-10/EDPB_guidelines_202007_controllerprocessor_final_en.pdf . They contain **no** discussion of the household exemption or of providers serving private users (a text search for "household" and "provide the means" finds nothing).

### 1.2 The household exemption and the operator's role (authority guidance found)

- **[read]** Art. 2(2)(c): the Regulation does not apply to processing "by a natural person in the course of a purely personal or household activity".
- **[read]** Recital 18: "However, this Regulation applies to controllers or processors which provide the means for processing personal data for such personal or household activities." So the Family may be outside the GDPR, the operator is not.
- **[read] Authority guidance.** The Landesbeauftragte für Datenschutz und Informationsfreiheit NRW publishes the AUDITOR criteria catalogue for cloud-service certification (version 1.0, 5 June 2024): https://www.ldi.nrw.de/system/files/media/document/file/kriterienkatalog_v1.0_de_final_pub.pdf . It addresses exactly this case. Key sentences (translated from German): the provider keeps its processor duties either way ("Während die Anwendbarkeit der Haushaltsausnahme die Verpflichtungen des Cloud-Anbieters als Auftragsverarbeiter nicht berührt, unterliegt der Cloud-Nutzer nicht den Verpflichtungen der Datenschutz-Grundverordnung"). The duties of Art. 28(3)(a), (b), (c), (d) and (h) are addressed to the processor and stay unchanged. For (e), (f) and (g), which depend on a controller's duties, "there is no point of attachment" ("keinen Anknüpfungspunkt") when the household exemption applies. The catalogue also says a consumer does not automatically fall under the exemption, and that cloud providers in practice do not check, but build a service that is fully GDPR-compliant without relying on the exemption.
- **Reading for Family Agenda:** act as a processor and meet Art. 28(3) in full, including (e) to (g), by contract. For (g) this costs nothing and § 327p(3) BGB (section 6.2) demands the same return of content anyway. Caveats: AUDITOR is a certification catalogue by one state authority, not an EDPB or DSK opinion; it assumes a cloud service, and a hosted Instance for one Family may be closer to a managed application. **[unverified]** The catalogue cites CJEU C-101/01 (Lindqvist), C-212/13 (Ryneš) and C-25/17 (Jehovan todistajat) for a narrow reading of the exemption; those judgments were not read. If a customer is not a purely private household (a small business, a class parent group), the exemption does not apply and the Family is a controller, so the terms can limit the offer to private households.
- **Still open for the lawyer:** whether the operator is also a controller for some processing (Art. 28(10)), and what the AVV says about third parties' rights (4.2).

### 1.3 The AVV (Art. 28)

**[read]** Art. 28(3) lists what the contract must stipulate. Art. 28(9): "in writing, including in electronic form". Points and their use here:

| Art. 28 | Requirement (wording abridged) | Product note |
|---|---|---|
| 28(3) intro | subject-matter, duration, nature, purpose, type of data, categories of data subjects, obligations and rights of the controller | Data subjects: Family Members including children, and third parties in mail. Data: Items, raw messages and attachments (ADR-0006 blobs), Source credentials |
| 28(3)(a) | only on documented instructions | the Admin's configuration of Sources, Agendas, deletion |
| 28(3)(b) | persons authorised have committed themselves to confidentiality | the operator's own support access |
| 28(3)(c) | takes all measures required pursuant to Article 32 | section 3 |
| 28(2), (4) | no other processor without prior specific or general written authorisation; with general authorisation the processor informs of intended changes, "giving the controller the opportunity to object"; the same obligations flow down and the initial processor "shall remain fully liable" | host, backup storage, LLM provider, mail sender |
| 28(3)(e), (f) | assist with data-subject requests and Articles 32 to 36 | export, deletion of an Item or a Member's data |
| 28(3)(g) | "at the choice of the controller, deletes or returns all the personal data ... after the end of the provision of services ... and deletes existing copies unless Union or Member State law requires storage" | section 5 |
| 28(3)(h) | information and audits | questionnaire plus documentation; scope of on-site audits by contract |

- **[read]** The Commission's standard contractual clauses for controller-processor contracts are Implementing Decision (EU) 2021/915 of 4 June 2021 (Art. 28(7)); Art. 28(6) allows the contract to be based on them in whole or in part: https://eur-lex.europa.eu/eli/dec_impl/2021/915/oj . They include a sub-processor clause (Clause 7.7) and assistance (Clause 8).
- **Sub-processors to list:** hosting provider, backup storage, LLM provider, transactional mail. Each needs its own contract with the operator, and a Chapter V basis if outside the EU/EEA. **[unverified]** The EU-US Data Privacy Framework adequacy decision (July 2023) and its court challenge were not re-read; prefer EU hosting for all of them, as ADR-0004 already required for the LLM.

### 1.4 Operator as controller for its own data

Customer account, contact, billing and website data serve the operator's own purposes: it is controller (Art. 4(7), **[unverified]** wording not re-read). A **Datenschutzerklärung** with the Art. 13 content is needed. **[unverified]** § 25 TDDDG (consent for non-essential cookies) was not re-read; a site without trackers avoids it.

## 2. Records, breaches, liability

- **[read]** Art. 30(2): "Each processor ... shall maintain a record of all categories of processing activities carried out on behalf of a controller". Art. 30(5): the obligations "shall not apply to an enterprise or an organisation employing fewer than 250 persons unless the processing it carries out is likely to result in a risk to the rights and freedoms of data subjects, the processing is not occasional, or the processing includes special categories of data". A continuous hosted service is "not occasional", so the exemption is lost. DSK Kurzpapier Nr. 1 covers the records: https://www.datenschutzkonferenz-online.de/kurzpapiere.html **[read]** (list page; the paper itself not read).
- **[read]** Art. 33(2): "The processor shall notify the controller without undue delay after becoming aware of a personal data breach." Art. 33(1) gives the controller 72 hours to the authority, so the AVV should set a short notice time (a number is the lawyer's call). The operator needs an incident log and a stand-in for absences.
- **[read]** Art. 82(2): a processor "shall be liable for the damage caused by processing only where it has not complied with obligations of this Regulation specifically directed to processors or where it has acted outside or contrary to lawful instructions of the controller". Art. 83(4): fines up to EUR 10 000 000 or 2 % of worldwide turnover for infringements of "Articles 8, 11, 25 to 39 and 42 and 43" (this covers Arts. 28, 30, 32, 33, 37).

## 3. Security, DPO and key custody

- **[read]** Art. 32(1): "the controller and the processor shall implement appropriate technical and organisational measures to ensure a level of security appropriate to the risk, including inter alia as appropriate: (a) the pseudonymisation and encryption of personal data". A leak would expose children's schedules, schools, possible sick notes and Source credentials that open the parents' mailboxes.
- **DPO. Corrected from the first version.** **[read]** Art. 37(1) covers public bodies, large-scale regular and systematic monitoring, and large-scale special-category processing as a core activity. **[read]** § 38(1) BDSG: a DPO is needed where at least 20 persons are constantly engaged in automated processing, and "Nehmen der Verantwortliche oder der Auftragsverarbeiter Verarbeitungen vor, die einer Datenschutz-Folgenabschätzung nach Artikel 35 ... unterliegen, ... haben sie unabhängig von der Anzahl der mit der Verarbeitung beschäftigten Personen" a DPO. https://www.gesetze-im-internet.de/bdsg_2018/__38.html . So a one-person operator needs a DPO (external is possible) if its processing is subject to a DPIA. Whether it is, is for the lawyer, using the DSK Kurzpapier Nr. 5 on DPIAs and the DSK "Muss-Liste" **[unverified]** (Kurzpapier Nr. 5 is listed on the DSK page; the Muss-Liste was not read). DSK Kurzpapier Nr. 12 covers DPOs of processors.
- **Key custody and ADR-0006.** The master key is a file in its own volume, and backups exclude it. When the operator runs the machine, the operator can read the key and the blobs, so encryption protects against dump leaks and a stolen backup, not against the operator. ADR-0004's statement that backup storage "stores only ciphertext" holds only if the backup key stays out of the operator's reach, which conflicts with operating restores for a non-technical Family. The contract and privacy notice must not promise that the operator cannot read Family data unless the architecture makes that true. **[unverified]** UWG §§ 5 and 5a on misleading statements were not re-read. Operator support access is itself processing: log and restrict it.

## 4. Special points

### 4.1 Children's data

- **[read]** Art. 8(1): the age rule applies "in relation to the offer of information society services directly to a child" where consent is the basis. The Admin is a parent, so Art. 8 is probably not triggered; lawyer to confirm, especially if Agenda Links are ever opened by children.
- **[read]** Recital 38: "Children merit specific protection with regard to their personal data". Recital 75 names the processing of data of "vulnerable natural persons, in particular of children" as a risk factor **[read]** (located by text search; the surrounding recital was not read in full).
- **[unverified]** Art. 9 special categories (health in sick notes, religion): Art. 9 was not re-read. Whether the processor needs its own Art. 9(2) condition when acting for a household is for the lawyer.

### 4.2 Third parties' data inside mails

- **[read]** Art. 14(5)(b): the information duty does not apply where "the provision of such information proves impossible or would involve a disproportionate effort". Art. 14 is the controller's duty. A Family inside the household exemption owes no notice; the operator as processor owes none directly. If the operator were a controller for some processing (1.2), the question reappears for every teacher or parent named in a mail. Lawyer question.
- Operating line: no use of message content beyond running the service (Art. 28(10)); no training by the LLM provider (contract and provider setting).
- Data-subject requests from third parties go to the controller. Under AUDITOR (1.2) the processor's duty to assist has no anchor for a household customer, so the AVV should say what the operator does anyway.

## 5. Retention and deletion on cancellation

- **[read]** Art. 28(3)(g) as quoted above: the controller chooses between deletion and return, and copies are deleted "unless Union or Member State law requires storage".
- **[read]** § 327p(3) BGB: the operator must, on the consumer's request, make content (other than personal data) available "unentgeltlich, ohne Behinderung durch den Unternehmer, innerhalb einer angemessenen Frist und in einem gängigen und maschinenlesbaren Format". § 327p(2): the operator may not keep using such content after the contract ends (with exceptions). https://www.gesetze-im-internet.de/bgb/__327p.html (**corrected:** the first version cited § 327q for this; § 327q concerns the effect of the consumer's data-protection declarations on the contract.)
- **Backups.** Art. 28(3)(g) gives no grace period for copies; state a fixed rotation window as part of the security measures rather than promise instant deletion. **[unverified]** no authority text on backup retention was found.
- **Sequence to design:** termination effective, read-only export window, deletion of the Instance, volumes and key, backups gone after the next rotation. Under the Data Act (6.4) the export window may need to be at least 30 days.
- **Operator's own records.** **[read]** § 14b(1) UStG: invoices "acht Jahre aufzubewahren", from the end of the calendar year of issue. **[read]** § 147(3) AO: books, inventories and annual accounts ten years, accounting vouchers (Buchungsbelege) eight years, other tax-relevant documents six years. https://www.gesetze-im-internet.de/ustg_1980/__14b.html , https://www.gesetze-im-internet.de/ao_1977/__147.html (**corrected:** the first version said the ten-year invoice period was "shortened to eight from 2025 (check)"; the current text gives eight years for vouchers and invoices and keeps ten for books and annual accounts.) These records are the operator's controller data, kept separately from Family data. **[unverified]** Art. 17(3)(b) was not re-read.

## 6. Consumer-facing duties (Germany)

### 6.1 Impressum

**[read]** § 5(1) DDG: providers of "geschäftsmäßige, in der Regel gegen Entgelt angebotene digitale Dienste" must keep available, "leicht erkennbar und unmittelbar erreichbar" and permanently: (1) name and address where established; (2) "Angaben, die eine schnelle elektronische Kontaktaufnahme und eine unmittelbare Kommunikation mit ihnen ermöglichen, einschließlich der Adresse für die elektronische Post"; (4) trade register entry if any; (6) VAT identification number under § 27a UStG, or Wirtschafts-Identifikationsnummer under § 139c AO, "in Fällen, in denen sie [eine] ... besitzen". https://www.gesetze-im-internet.de/ddg/__5.html . **Corrected:** the first version spoke of "a second means such as a form or phone"; the statute text says only "schnelle elektronische Kontaktaufnahme und ... unmittelbare Kommunikation" with the email address. Whether a phone number is also needed is case law, not read here. A Kleinunternehmer without a VAT ID omits the VAT number, but a Wirtschafts-Identifikationsnummer, once issued, is also listed. The address is the home address unless a business address is rented. **[unverified]** the date on which the DDG replaced the TMG (recall: 14 May 2024).

### 6.2 Contract formation, information, AGB, digital products

- **[read]** § 312j(3) BGB: the order must be designed so that the consumer "ausdrücklich bestätigt, dass er sich zu einer Zahlung verpflichtet"; a button must be labelled "mit nichts anderem als den Wörtern 'zahlungspflichtig bestellen' oder mit einer entsprechenden eindeutigen Formulierung". § 312j(4): "Ein Vertrag ... kommt nur zustande, wenn der Unternehmer seine Pflicht aus Absatz 3 erfüllt." https://www.gesetze-im-internet.de/bgb/__312j.html . Art. 246a EGBGB information duties and the PAngV are **[unverified]**.
- **[read]** § 309 Nr. 7 BGB: no exclusion or limitation of liability in AGB for injury to life, body or health (negligence included) or for gross negligence and intent. § 309 Nr. 9: in a continuing contract for regular services, the following are void: a binding term of "länger als zwei Jahre", a binding tacit renewal "es sei denn das Vertragsverhältnis wird nur auf unbestimmte Zeit verlängert und dem anderen Vertragsteil wird das Recht eingeräumt, das verlängerte Vertragsverhältnis jederzeit mit einer Frist von höchstens einem Monat zu kündigen", and a notice period longer than one month before the end of the initial term. https://www.gesetze-im-internet.de/bgb/__309.html . A monthly plan with monthly notice fits. §§ 305 to 308 and 310 are **[unverified]**.
- **Digital products, [read]** § 327(1) and (2) BGB: the subtitle applies to consumer contracts on "digitale Inhalte oder digitale Dienstleistungen ... gegen Zahlung eines Preises", and digital services include those that enable "die Erstellung, die Verarbeitung oder die Speicherung von Daten in digitaler Form oder den Zugang zu solchen Daten". A hosted Instance fits. https://www.gesetze-im-internet.de/bgb/__327.html . § 327f(1): updates "die für den Erhalt der Vertragsmäßigkeit ... erforderlich sind", security updates included, for the whole provision period. § 327r(1): changes beyond what is needed to keep conformity only if "der Vertrag diese Möglichkeit vorsieht und einen triftigen Grund dafür enthält", at no extra cost and with clear information; § 327r(2) and (3): notice on a durable medium and a free 30-day termination right where access or usability is impaired more than slightly. https://www.gesetze-im-internet.de/bgb/__327f.html , https://www.gesetze-im-internet.de/bgb/__327r.html . §§ 327d, 327e and 327i ff. are **[unverified]**.
- **[read]** § 36 VSBG: a trader with a website or AGB must state "inwieweit er bereit ist oder verpflichtet ist, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen"; § 36(3) exempts from that statement "ein Unternehmer, der am 31. Dezember des vorangegangenen Jahres zehn oder weniger Personen beschäftigt hat". A sole trader is exempt from the duty to state willingness. https://www.gesetze-im-internet.de/vsbg/__36.html . **[unverified]** The first version's remark that the EU ODR platform closed in July 2025 was not re-checked; no link to it is needed given the exemption in any case.

### 6.3 Withdrawal, withdrawal function, and cancellation

- **[read]** § 312g(1) and § 355(1), (2) BGB: distance contracts carry a withdrawal right; "Die Widerrufsfrist beträgt 14 Tage. Sie beginnt mit Vertragsschluss, soweit nichts anderes bestimmt ist." https://www.gesetze-im-internet.de/bgb/__312g.html , https://www.gesetze-im-internet.de/bgb/__355.html .
- **Corrected citation.** **[read]** The early expiry for services is **§ 356(5) BGB**, not § 356(4) as the first version said ((4) is the outer limit of twelve months and 14 days). For a service with a price, the right expires on full performance if the consumer, before the start, "ausdrücklich zugestimmt hat, dass der Unternehmer mit der Erbringung der Dienstleistung vor Ablauf der Widerrufsfrist beginnt" and "seine Kenntnis davon bestätigt hat, dass sein Widerrufsrecht mit vollständiger Vertragserfüllung durch den Unternehmer erlischt". A continuing service is never "fully performed" within 14 days, so for it the relevant rule is **§ 357a(2)**: the consumer owes value for services rendered until withdrawal only if they "ausdrücklich verlangt hat, dass mit der Leistung vor Ablauf der Widerrufsfrist begonnen werden soll" and the operator informed them properly. For "nicht auf einem körperlichen Datenträger befindliche digitale Inhalte", § 356(6) and § 357a(3) (no value to pay) apply. Whether a hosted Instance is a service or digital content for these rules is for the lawyer. https://www.gesetze-im-internet.de/bgb/__356.html , https://www.gesetze-im-internet.de/bgb/__357a.html . Sign-up must capture the express request and acknowledgement.
- **New gap closed: electronic withdrawal function, § 356a BGB [read].** "Bei Fernabsatzverträgen, die über eine Online-Benutzeroberfläche geschlossen werden, hat der Unternehmer sicherzustellen, dass der Verbraucher ... durch das Nutzen einer Widerrufsfunktion eine Widerrufserklärung abgeben kann." The function must be labelled "Vertrag widerrufen" or an equivalent, be "während des Laufs der Widerrufsfrist ... ständig verfügbar, hervorgehoben platziert und ... leicht zugänglich", be followed by a confirmation function labelled "Widerruf bestätigen", and the operator must send an acknowledgement on a durable medium at once (§ 356a(1) to (4)). https://www.gesetze-im-internet.de/bgb/__356a.html . **[read]** It implements Art. 11a of Directive 2011/83/EU as inserted by Directive (EU) 2023/2673, whose national measures apply "from 19 June 2026": https://eur-lex.europa.eu/eli/dir/2023/2673/oj . The first version did not mention it.
- **[read] Kündigungsbutton, § 312k BGB** (https://www.gesetze-im-internet.de/bgb/__312k.html). Scope (1): consumer contracts concluded on a website that create a continuing obligation for payment (not financial services). (2): the consumer must be able to declare termination "über eine Kündigungsschaltfläche", labelled "mit nichts anderem als den Wörtern 'Verträge hier kündigen' oder mit einer entsprechenden eindeutigen Formulierung", leading "unmittelbar zu einer Bestätigungsseite" where the consumer states the type of termination, identity, contract, time and how to receive the confirmation, and a confirmation button labelled "jetzt kündigen" or equivalent; "Die Schaltflächen und die Bestätigungsseite müssen ständig verfügbar sowie unmittelbar und leicht zugänglich sein." (4): the operator confirms content, date and time of receipt "sofort auf elektronischem Wege in Textform". (6): without compliant buttons the consumer "jederzeit und ohne Einhaltung einer Kündigungsfrist" may terminate. **Corrected:** the first version left it open whether the buttons must work without login; the statute text has no explicit login rule, only the availability sentence above (see the open BGH cases below).
- **[read] BGH, 16 July 2026, I ZR 200/25** (press release 128/2026, https://www.bundesgerichtshof.de/SharedDocs/Pressemitteilungen/DE/2026/2026128.html ): the confirmation page must not carry "Informationen zu Kündigungsalternativen, wie zum Beispiel das Pausierenlassen des Vertrags"; "Die Ausgestaltung der Bestätigungsseite ist in § 312k Abs. 2 Satz 3 BGB abschließend geregelt." Confirmed against the court's own release; the full reasons were not read. Consequence: no pause or downgrade offer on that page.
- **[read] Open:** the BGH heard on 5 November 2026 (press release 133/2026, https://www.bundesgerichtshof.de/SharedDocs/Pressemitteilungen/DE/2026/2026133.html ) two cases on whether login data may be required during cancellation (I ZR 272/25, a web-hosting contract, and I ZR 275/25). No decision was found; design the button and page so that no login is needed.
- **[read]** UWG §§ 5, 5a, 7 and the PAngV were not re-read **[unverified]**.

### 6.4 EU Data Act: switching and export

**[read]** Regulation (EU) 2023/2854, https://eur-lex.europa.eu/eli/reg/2023/2854/oj (Official Journal text):
- Art. 50: "It shall apply from 12 September 2025." The chapter on switching (Chapter VI, Arts. 23 to 31) has no later date; Art. 50's later dates concern other chapters.
- Art. 2: a "data processing service" is "a digital service that is provided to a customer and that enables ubiquitous and on-demand network access to a shared pool of configurable, scalable and elastic computing resources"; a "customer" is "a natural or legal person that has entered into a contractual relationship with a provider of data processing services"; "exportable data" is "the input and output data, including metadata, directly or indirectly generated, or cogenerated, by the customer's use of the data processing service", excluding IP- or trade-secret-protected assets.
- Art. 25(2): the contract must allow switching or porting "not after the mandatory maximum transitional period of 30 calendar days", set a maximum notice period "which shall not exceed two months", specify exportable data exhaustively, give "a minimum period for data retrieval of at least 30 calendar days" and "guarantee full erasure" afterwards.
- Art. 29: "From 12 January 2027, providers ... shall not impose any switching charges"; until then only reduced charges not above the provider's direct costs.
- Art. 30(5): where no common specifications exist, the provider shall "export all exportable data in a structured, commonly used and machine-readable format".
- Art. 31(1) and (2): the only carve-outs are services custom-built for one customer and test versions. **No exemption for micro or small providers appears in these articles.**
- **Open for the lawyer:** whether one managed single-tenant application Instance is a "data processing service" at all (the definition speaks of a shared pool of elastic computing resources, which better fits infrastructure and platform services). If it is, the export promise becomes a legal contract term, and consumers count as customers.

### 6.5 AI

Regulation (EU) 2024/1689 was **[unverified]**: not read. The extraction uses a third-party LLM on Family text and does not look like a high-risk use or a chatbot. Check Art. 50 transparency once so the operator can state in one line why it does not apply.

### 6.6 Merchant of Record (Paddle terms)

Primary source: Paddle Master Services Agreement (last updated 6 October 2026), https://www.paddle.com/legal/terms , and the buyer terms, https://www.paddle.com/legal/buyer-terms **[read]**. This describes one provider's contract, not the law; the legal consequences for the Impressum and withdrawal notice are for the lawyer.
- Seller: cl. 2.1 "You appoint Paddle as your non-exclusive reseller of the Product"; cl. 4.1 "Paddle is the reseller of the Product. This structure allows Paddle to handle Sales Tax collection, reporting and remittance". Buyer terms: "you purchase the Product from Paddle using our Services, and the Product is made available to you by the Supplier under the terms of their Supplier Agreement". So the consumer has a sales contract with Paddle and the service terms with the operator.
- Price and fee: cl. 3.4 "Paddle reserves the right to set the price or licence fee"; cl. 3.2(i) the Paddle Discount for Checkout is "5% of SRP plus $0.50" (a rate from this version of the terms, subject to change under cl. 3.5).
- Withdrawal and refunds: buyer terms, EU/EEA consumers: "You have the right to withdraw from the Agreement for any reason within 14 days of completing a Transaction in accordance with our Refund Policy", with the exception where the buyer "started ... using or benefiting from the Product" after agreeing to early availability. Cl. 6.1: Paddle gives "first tier after-sales support ... including invoicing, handling requests for refunds, payment".
- What stays with the operator: cl. 6.4 the Supplier provides "technical and/or delivery level support"; cl. 11.1(iii) the Supplier must give buyers "access to Paddle's after sales support ... including by way of a direct link to enable cancellation of a Product, if it is required"; cl. 9.2 the Supplier URLs must "clearly reflect Paddle's status as a reseller"; cl. 9.3 Paddle may demand changes to the terms shown there.
- Data: cl. 14.2 "each party acts as an independent Controller" for buyers' personal data, with a Data Sharing Addendum; this is separate from the processor role for Family data.
- Open for the lawyer: whether the § 312k and § 356a duties then rest on Paddle, the operator or both; who is named in the Impressum; the operator's VAT position towards Paddle (a B2B supply of the licence).

## 7. Business formalities for an Einzelunternehmen

| Topic | Rule | Status |
|---|---|---|
| Gewerbeanmeldung | **[read]** § 14(1) GewO: "Wer den selbständigen Betrieb eines stehenden Gewerbes ... anfängt, muss dies der zuständigen Behörde gleichzeitig anzeigen." https://www.gesetze-im-internet.de/gewo/__14.html . The fee is not in § 14 (set locally) | fee **[unverified]**. Whether software hosting is a trade (not a freelance activity) is for the tax advisor |
| Tax registration | **[read]** § 138(1) AO: opening a trade is notified on the official form to the municipality, which informs the Finanzamt; § 138(1b): further information goes to the Finanzamt electronically. https://www.gesetze-im-internet.de/ao_1977/__138.html | the Fragebogen zur steuerlichen Erfassung via ELSTER follows from (1b); form details **[unverified]** |
| Kleinunternehmer | **[read]** § 19(1) UStG: the supply is tax-exempt if the total turnover "im vorangegangenen Kalenderjahr 25 000 Euro nicht überschritten hat und im laufenden Kalenderjahr 100 000 Euro nicht überschreitet". https://www.gesetze-im-internet.de/ustg_1980/__19.html . So the figures I gave in the first version (25,000 and 100,000) were correct | The exemption excludes tax-free intra-Community supplies, waiver of exemptions, VAT-ID on invoices and the VAT return duties (§ 19(1) sentence 2) |
| Opting out | **Corrected citation: § 19(3), not § 19(2).** **[read]** § 19(3) UStG: the operator may "unwiderruflich" declare a waiver by the end of February of the second year after the tax period; it binds "mindestens für fünf Kalenderjahre", and can be revoked from the start of a following calendar year | |
| Cross-border EU | **[read]** § 19(4), (5) UStG concern small businesses established in *other* member states. For a German operator selling to Austrian or other EU consumers, the rules of their VAT regime apply, including OSS | OSS thresholds and § 18j etc. **[unverified]**. With a Merchant of Record this falls to the MoR |
| Invoice note for Kleinunternehmer | **[unverified]** | |
| Gewerbesteuer | **[read]** § 11(1) sentence 3 Nr. 1 GewStG: for natural persons the trade income is reduced by "einen Freibetrag in Höhe von 24 500 Euro". https://www.gesetze-im-internet.de/gewstg/__11.html | |
| Trade register, IHK, income-tax bookkeeping (§ 1 HGB, IHKG, § 4(3) EStG, § 141 AO) | **[unverified]** | for the tax advisor |
| Liability | Unlimited personal liability of a sole trader is general civil law (**[unverified]**, §§ 280, 823 BGB not re-read); GDPR damages Art. 82 **[read]** above. AGB limits are restricted by § 309 Nr. 7 **[read]** | insurance and later change of legal form are lawyer questions |

## 8. Austria and Switzerland (DACH): pointers

The offer is DACH first (map #212). Germany and EU law above are read; for the other two countries only the items below were read, and national counsel is needed.

### 8.1 Switzerland

- **Data protection, [read]** Federal Act on Data Protection (FADP/nDSG, SR 235.1), as in force on 1 September 2023, https://www.fedlex.admin.ch/eli/cc/2022/491/de :
  - Art. 2(2)(a): not applicable to data "von einer natürlichen Person ausschliesslich zum persönlichen Gebrauch bearbeitet", the Swiss counterpart of the household exemption.
  - Art. 9: processing may be delegated by contract if "die Daten so bearbeitet werden, wie der Verantwortliche selbst es tun dürfte"; the processor needs prior authorisation to delegate to a third party (Art. 9(3)); the controller must make sure the processor can ensure data security (Art. 9(2)).
  - Art. 12(1): "Die Verantwortlichen und Auftragsbearbeiter führen je ein Verzeichnis ihrer Bearbeitungstätigkeiten" (Art. 12(5): exceptions for under 250 staff and low risk, set by the Federal Council).
  - Art. 24(3): the processor reports a data-security breach to the controller "so rasch als möglich".
  - Art. 14: a representative in Switzerland is needed for private controllers abroad if they process data of persons in Switzerland with offering link and large-scale, regular, high-risk processing; whether the operator is such a controller is **[unverified]**. EU transfers to and from Switzerland (adequacy) not read.
- **Unfair competition and e-commerce, [read]** UWG Art. 3(1)(s), https://www.fedlex.admin.ch/eli/cc/1988/223_223_223/de (version of 1 January 2025): it is unfair to offer goods or services in e-commerce without giving "klare und vollständige Angaben über seine Identität und seine Kontaktadresse einschliesslich derjenigen der elektronischen Post", pointing out the technical steps to contract, giving means to correct input errors, and confirming the order "unverzüglich auf elektronischem Wege". This is the Swiss Impressum-style duty.
- **Withdrawal, [read]** There is no general withdrawal right for online contracts. OR Art. 40a applies to contracts for movables and services for personal or family use above CHF 100, and Art. 40b grants revocation only where the offer was made at the workplace or in or near living quarters, in public transport or on public streets, at an advertising event with an excursion, or "am Telefon oder über vergleichbare Mittel der gleichzeitigen mündlichen Telekommunikation". https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de . An online sign-up is not on that list. Swiss counterparts of a Kündigungsbutton and of AGB control (UWG Art. 8) **[unverified]**.
- Swiss VAT, liability and company forms: **[unverified]**, not researched.

### 8.2 Austria

Not read: `ris.bka.gv.at` blocks scripted access, and `www.dsb.gv.at` reset the connection. The following are pointers, with **[secondary]** support from the Wirtschaftskammer Österreich (WKO) and the official portal USP, which restate the law:
- **Data protection:** the GDPR applies directly; the national Datenschutzgesetz (DSG) supplements it and the Datenschutzbehörde supervises: https://www.ris.bka.gv.at (Bundesrecht, DSG) and https://www.dsb.gv.at **[unverified]**.
- **Impressum:** § 5 E-Commerce-Gesetz (ECG), § 63 Gewerbeordnung, and the Mediengesetz disclosure rules. **[secondary]** WKO: the ECG duties apply to commercial websites and ask for a full geographic address and "mindestens zwei Kontaktmöglichkeiten" (for example email and phone or web form); https://www.wko.at/internetrecht/informationspflichten-nach-dem-e-commerce-gesetz--dem-unte and https://www.wko.at/oe/internetrecht/das-korrekte-website-impressum.pdf (as of August 2025).
- **Withdrawal:** Fern- und Auswärtsgeschäfte-Gesetz (FAGG). **[secondary]** WKO and USP: 14 calendar days, starting with the contract for services; twelve months and 14 days if the consumer was not informed; exceptions in § 18 FAGG, including full performance after express consent; no payment for services during the period if the information was missing (§ 16(2) FAGG). https://www.wko.at/internetrecht/ruecktrittsrecht-bei-dienstleistungen-im-internet and https://www.usp.gv.at/gruendung/gruendung-eines-online-shops/ruecktrittsrecht/allgemeines-zum-ruecktrittsrecht.html . Austria must also implement the EU withdrawal function (Directive (EU) 2023/2673, from 19 June 2026, **[read]** above); WKO mentions it with a caveat about the date of the national amendment, not confirmed.
- **Cancellation button, AGB control, VAT (Kleinunternehmer limits), trade licence:** no Austrian equivalent of § 312k was verified; the Austrian KSchG and ABGB for unfair terms, the UStG small-business rule and the Gewerbeordnung licence for the activity are **[unverified]** pointers only.

## 9. Checklist before the first paying Family

1. Gewerbeanmeldung (§ 14 GewO), tax registration (§ 138 AO), decision on Kleinunternehmer vs VAT, contract with the Merchant of Record.
2. Impressum (§ 5 DDG) and Datenschutzerklärung.
3. AGB within §§ 305 ff., § 309 Nr. 7 and 9, § 327 ff. BGB; price information; § 312j(3) order button; withdrawal notice with the express-start request (§§ 356(5), 357a(2) BGB); **withdrawal function (§ 356a BGB)**; **Kündigungsbutton and confirmation page without alternatives (§ 312k BGB, BGH I ZR 200/25) and without a login requirement**.
4. AVV with sub-processor list, TOMs annex, breach notice time, export and deletion sequence (Art. 28(3); Decision (EU) 2021/915 as template).
5. Contracts with every sub-processor, EU region, no-training terms for the LLM.
6. Records of processing (Art. 30(1), (2)), incident procedure with a stand-in, support-access log.
7. A decision on the DPIA and the DPO (§ 38(1) BDSG).
8. A deletion procedure for a whole Instance including backups and a stated backup rotation window; an export sequence that meets Art. 25 Data Act if it applies.
9. A statement of what the operator can read (key custody) that is true.

Costs to ask for (not established from primary sources): AGB, withdrawal notice and Datenschutzerklärung drafting or a maintained template subscription; AVV template and review; DPIA and, if required, an external DPO; tax advisor setup and annual statements; Gewerbeanmeldung fee; Impressum address service; liability and cyber insurance. The only figures read from the law are the Kleinunternehmer limits, the Gewerbesteuer allowance and the Paddle rate above.

## 10. Open questions for the lawyer and tax advisor

1. Is a DPIA required (and therefore a DPO under § 38(1) BDSG) for processing children's data and school mail with an LLM?
2. Processor-only reading under AUDITOR, and whether the operator is a controller for any processing (1.2, 4.2); Art. 9 condition on the operator's side.
3. Key custody and what the contract may say about operator access (3).
4. Whether a hosted Instance is a "data processing service" under the Data Act, and the export window (6.4).
5. Merchant of Record: who carries § 312k and § 356a duties, who is in the Impressum, the operator's VAT status towards Paddle (6.6).
6. Withdrawal for a continuing service that starts at once: service or digital content, and the sign-up flow (6.3).
7. Outcome of the BGH login cases (I ZR 272/25, 275/25) after the 5 November 2026 hearing.
8. Austria and Switzerland: national counsel for consumer law, Impressum, data protection and tax (8).
9. When to move from Einzelunternehmen to a limited-liability form.

## Still unverified

Art. 4(7), 9, 13, 17(3), 25, 35, 44 to 46 GDPR; the DPF adequacy decision; CJEU C-101/01, C-212/13, C-25/17; TDDDG § 25; UWG (German) and PAngV; Art. 246a EGBGB; §§ 305 to 308, 327d, 327e, 327i ff. BGB; AI Act; DSK Muss-Liste and the Kurzpapiere themselves; HGB, IHKG, EStG, OSS rules; the Gewerbeanmeldung fee; the DDG commencement date; the Austrian statutes; Swiss VAT and company law; the outcome of the BGH login cases.

## Sources used

- GDPR: https://eur-lex.europa.eu/eli/reg/2016/679/oj (read as Official Journal text via the Publications Office)
- Decision (EU) 2021/915: https://eur-lex.europa.eu/eli/dec_impl/2021/915/oj
- Data Act: https://eur-lex.europa.eu/eli/reg/2023/2854/oj ; Directive (EU) 2023/2673: https://eur-lex.europa.eu/eli/dir/2023/2673/oj
- German statutes: https://www.gesetze-im-internet.de (DDG § 5; BGB §§ 309, 312g, 312j, 312k, 327, 327f, 327p, 327q, 327r, 355, 356, 356a, 357a; BDSG § 38; VSBG § 36; GewO § 14; AO §§ 138, 147; UStG §§ 14b, 19; GewStG § 11)
- BGH: https://www.bundesgerichtshof.de/SharedDocs/Pressemitteilungen/DE/2026/2026128.html and .../2026133.html
- EDPB Guidelines 07/2020 v2.1; LDI NRW AUDITOR catalogue; DSK Kurzpapiere list
- Paddle: https://www.paddle.com/legal/terms , https://www.paddle.com/legal/buyer-terms
- Switzerland: FADP, UWG, OR on https://www.fedlex.admin.ch
- Austria (secondary): WKO and USP pages linked in 8.2
- Repo context: [ADR-0004](../adr/0004-self-hosted-only-with-paid-agenda-cloud-services.md), [ADR-0006](../adr/0006-encrypted-secrets-and-file-based-blobs.md), [ADR-0013](../adr/0013-an-instance-is-one-family-without-family-ids.md)
