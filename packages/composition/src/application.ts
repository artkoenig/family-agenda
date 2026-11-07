import type {
  AdminAccess,
  AgendaAccess,
  CatalogueAccess,
  Cleanup,
  DueWork,
  ExtractionAccess,
  FamilyMemberAccess,
  LanguageAccess,
  LlmEndpointAccess,
  MessageAccess,
  RecoveryKitAccess,
  Retention,
  SecretStore,
  SecretSweep,
  ServiceSupervision,
  SingleSignOn,
  SourceAccess,
  SourcePolling,
  SourceTypeAccess,
  TaskAccess,
} from "@family-agenda/application";

export type Application = {
  /** The IANA time zone the Family lives in. */
  timeZone: string;
  admins: AdminAccess;
  secrets: SecretStore;
  /** Removes the secrets nothing refers to any more; part of `cleanup`. */
  secretSweep: SecretSweep;
  /** Deletes messages' text and attachments after their retention; part of `cleanup`. */
  retention: Retention;
  recoveryKit: RecoveryKitAccess;
  familyMembers: FamilyMemberAccess;
  /** The Family Language and the OCR languages. */
  languages: LanguageAccess;
  agendas: AgendaAccess;
  /** Ticking Tasks done, from an Agenda or the Admin area. */
  tasks: TaskAccess;
  sourceTypes: SourceTypeAccess;
  /** What an Admin enables within a Source Type, such as Messengers. */
  catalogues: CatalogueAccess;
  sources: SourceAccess;
  /** Runs the Sources that are due; part of `dueWork`. */
  polling: SourcePolling;
  /** Starts and stops the programs of Source Types, such as a homeserver; only the worker does. */
  services: ServiceSupervision;
  llmEndpoint: LlmEndpointAccess;
  /** Signing in through the Identity Provider, alongside the password. */
  singleSignOn: SingleSignOn;
  /** Extracts Items from the raw messages that wait for it; part of `dueWork`. */
  extraction: ExtractionAccess;
  /** One round of polling and extraction, and when the next is due; a scheduler decides when to run it. */
  dueWork: DueWork;
  /** Retention and the secret sweep, which the worker runs once a day. */
  cleanup: Cleanup;
  messages: MessageAccess;
  close(): Promise<void>;
};
