import type {
  AdminAccess,
  AgendaAccess,
  CatalogueAccess,
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
  /** Removes the secrets nothing refers to any more; the worker does when it starts. */
  secretSweep: SecretSweep;
  /** Deletes messages' text and attachments after their retention; the worker does it in the background. */
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
  /** Runs the Sources that are due; the worker does on each tick. */
  polling: SourcePolling;
  /** Starts and stops the programs of Source Types, such as a homeserver; only the worker does. */
  services: ServiceSupervision;
  llmEndpoint: LlmEndpointAccess;
  /** Signing in through the Identity Provider, alongside the password. */
  singleSignOn: SingleSignOn;
  /** Extracts Items from the raw messages that wait for it; the worker does on each tick. */
  extraction: ExtractionAccess;
  messages: MessageAccess;
  close(): Promise<void>;
};
