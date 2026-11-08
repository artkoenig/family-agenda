import type { PostgresConnection } from "@family-agenda/adapters";
import type { PluginHostConfig } from "./plugin-host-client";
import type {
  BlobStore,
  Clock,
  Extractor,
  IdentityProviderClient,
  OcrModelStore,
  PasswordHasher,
  SecretStore,
  TextExtractor,
} from "@family-agenda/application";

/**
 * Everything of an Instance that does I/O, handed to the boot functions ready to use. A process
 * builds them its own way: `selfHostedAdapters` from the environment, a test with fakes.
 */
export type Adapters = {
  /** The Instance's database; booting migrates it and closing the Application closes it. */
  postgres: PostgresConnection;
  /** The 32-byte key the Recovery Kit hands out; the Instance never creates one itself. */
  masterKey: Buffer;
  clock: Clock;
  passwordHasher: PasswordHasher;
  /** The OIDC client that talks to the Identity Provider. */
  identityProviderClient: IdentityProviderClient;
  secrets: SecretStore;
  blobs: BlobStore;
  /** The OpenAI-compatible Extractor. */
  extractor: Extractor;
  /** The poppler and Tesseract command-line tools. */
  textExtractor: TextExtractor;
  /** The Tesseract models, bundled, downloaded or put there by hand; where they live is its business. */
  ocrModels: OcrModelStore;
  /** Where the SourceRegistry finds Source plugins, first match wins: the shipped ones, then the `plugins/` volume. */
  pluginDirectories: string[];
  /** The Plugin Host and the Source Types it runs; without it, every plugin runs in this process. */
  pluginHost?: PluginHostConfig | null;
};
