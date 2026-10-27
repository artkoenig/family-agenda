import { pollIntervalRange, signInLimits } from "@family-agenda/application";
import {
  horizonDaysRange,
  maximumNameLength,
  maximumPhotoBytes,
  minimumPasswordLength,
  photoTypes,
  type FamilyLanguage,
} from "@family-agenda/domain";
import type { Child } from "hono/jsx";
import { plurals } from "./plurals";

const plural = plurals("en");

/** Wraps part of a sentence in markup, such as a link, keeping the sentence's word order. */
type Wrap = (text: string) => Child;

const photoFormats = photoTypes.map((type) => type.replace("image/", "").toUpperCase()).join(", ");

const ordinals = ["first", "second", "third"];

/**
 * Every text the Admin area, the Views and their feeds show, in English. It is the source of
 * truth: each other language's catalogue has the type of this one.
 */
export const en = {
  /** How the setup and the settings offer each Family Language: in itself, and in the Family Language. */
  familyLanguageOptions: { en: "English", de: "Deutsch (German)" } satisfies Record<FamilyLanguage, string>,
  /** Each Family Language named in the Family Language. */
  familyLanguageNames: { en: "English", de: "German" } satisfies Record<FamilyLanguage, string>,
  ocrLanguages: {
    /** Tesseract models that are no ISO 639 language, or that `Intl.DisplayNames` does not know. */
    special: { chi: "Chinese", frk: "German Fraktur", equ: "Math equations" } as Record<string, string>,
    /** What the suffix of a Tesseract code says about its model, such as the script it reads. */
    variants: {
      sim: "Simplified",
      tra: "Traditional",
      vert: "vertical",
      latn: "Latin",
      cyrl: "Cyrillic",
      latf: "Fraktur",
      old: "old",
    } as Record<string, string>,
  },

  problems: {
    "invalid-email": "Enter a valid email address.",
    "password-too-short": `The password must have at least ${minimumPasswordLength} characters.`,
    "email-taken": "This email already has an Admin account.",
    "invalid-credentials": "Wrong email or password.",
    "rate-limited": `Too many failed sign-ins. Wait ${signInLimits.windowMs / 60_000} minutes and try again.`,
    "own-account": "You cannot reset your own password here.",
    "unknown-admin": "This Admin does not exist.",
    "invalid-language": "Choose English or German as the Family Language.",
    "kit-not-saved": "Confirm that you have saved the Recovery Kit.",
    "invalid-name": `Enter a name of at most ${maximumNameLength} characters.`,
    "invalid-photo": `The photo must be one of ${photoFormats}.`,
    "photo-too-large": `The photo must be at most ${maximumPhotoBytes / 1024 / 1024} MB.`,
    "unknown-member": "This Family Member does not exist.",
    "invalid-horizon": `The horizon must be between ${horizonDaysRange.min} and ${horizonDaysRange.max} days.`,
    "unknown-view": "This View does not exist.",
    "unknown-source-type": "This Source Type is not installed.",
    "not-loadable": "This Source Type cannot be loaded.",
    "risk-not-acknowledged": "Confirm that you understand the risk of this Source Type.",
    "has-sources": "Remove the Sources of this Source Type before disabling it.",
    "source-type-not-enabled": "This Source Type is not enabled.",
    "unknown-source": "This Source does not exist.",
    "invalid-endpoint-url": "Enter the base URL as an http or https address, such as http://ollama:11434/v1.",
    "invalid-model": "Enter the name of the model.",
    "third-parties-not-acknowledged":
      "This server is outside your home network. Confirm that the text of third parties' messages is sent to it.",
    "no-ocr-language": "Keep at least one OCR language.",
    "ocr-language-not-installed": "The model of that OCR language is not installed. Download its model first.",
    "unknown-ocr-language": "No model can be downloaded for that language.",
    "ocr-language-selected": "OCR reads in this language. Remove it from the OCR languages first.",
    "ocr-language-bundled": "This model comes with Family Agenda and cannot be removed.",
    "invalid-interval": `The polling interval must be between ${pollIntervalRange.minSeconds / 60} minute and ${pollIntervalRange.maxSeconds / 86_400} days.`,
  },
  /** Problems that name what went wrong. */
  problemsWith: {
    /** A Source that cannot be saved, naming the fields by their labels. */
    invalidConfig: (fields: string) => `Check ${fields}.`,
    downloadFailed: (message: string) => `The model could not be downloaded. ${message}`,
  },

  common: {
    email: "Email",
    password: "Password",
    save: "Save",
    cancel: "Cancel",
    back: "Back",
    close: "Close",
    edit: "Edit",
    optional: (label: string) => `${label} (optional)`,
    storedSecret: "Stored; leave empty to keep it",
  },

  setup: {
    title: "Create the first Admin",
    intro: "This Instance has no Admin yet. Create your Admin account to protect the Admin area.",
    password: `Password (at least ${minimumPasswordLength} characters)`,
    familyLanguage: "Family Language",
    familyLanguageHint:
      "Family Agenda speaks it, writes dates in it, and reads scanned letters in it. You can change it in the settings.",
    submit: "Create Admin",
  },

  signIn: {
    title: "Sign in",
    submit: "Sign in",
  },

  settings: {
    title: "Settings",
    signOut: "Sign out",
    groups: { family: "Family", sources: "Sources", instance: "Instance" },
    newSourceTypes: "New Source Types are available",
    lookAtThem: "Look at them",
    noneYet: "None yet",
    views: (count: number) =>
      plural(count, { one: `${count} View on the home network`, other: `${count} Views on the home network` }),
    language: (family: string, ocr: string) => `${family}; OCR in ${ocr}`,
    sources: (count: number) => plural(count, { one: `${count} Source`, other: `${count} Sources` }),
    newOnes: "New ones are available",
    enabled: (count: number) => `${count} enabled`,
    llmLocal: (model: string) => `${model}, on the home network`,
    llmRemote: (model: string) => `${model}, outside the home network`,
    notSetUp: "Not set up",
    admins: (count: number) => plural(count, { one: `${count} Admin`, other: `${count} Admins` }),
    saved: "Saved",
    notSavedYet: "Not saved yet",
  },

  admins: {
    title: "Admins",
    description: "Parents who sign in to manage settings and Sources. A forgotten password is reset by another Admin.",
    add: "Add Admin",
    eyebrow: "Instance",
    dialogTitle: "Add an Admin",
    passwordHint: `At least ${minimumPasswordLength} characters. Tell it to them in person.`,
    you: "You",
    admin: "Admin",
    newPassword: "New password",
    resetPassword: "Reset password",
  },

  recoveryKit: {
    title: "Recovery Kit",
    description: "Restoring a Backup needs it to read the Source credentials. Keep it offline, away from the Instance.",
    purpose: [
      "Keep this kit offline, printed or saved away from the Instance.",
      "Restoring a Backup needs it to read the Source credentials, and Backups are encrypted with a key derived from it.",
      "Anyone with this kit and a Backup can read the Source credentials.",
    ],
    fileTitle: "Family Agenda Recovery Kit",
    masterKeyLine: "Master key:",
    print: "Print",
    download: "Download as a text file",
    saved: "Saved",
    savedBody: "An Admin confirmed it was printed or saved.",
    showMasterKey: "Show master key",
    hideMasterKey: "Hide master key",
    saveFirst: "Save it before you continue",
    saveFirstBody: "Print it or download it. Any Admin can show it again later.",
    masterKey: "Master key",
    confirm: "I have printed or saved the Recovery Kit.",
    continue: "Continue",
  },

  members: {
    title: "Family Members",
    description: "Whom Items can concern. Each keeps an avatar colour; a photo replaces the initial.",
    add: "Add Family Member",
    eyebrow: "Family",
    dialogTitle: "Add a Family Member",
    name: "Name",
    nameHint: `How the Views call them, up to ${maximumNameLength} characters.`,
    photo: "Photo (optional)",
    photoHint: "Without one, the avatar shows the initial on a colour of its own.",
    none: "No Family Members yet.",
    withPhoto: "With a photo",
    withInitial: "Shows the initial",
    replacePhoto: "Replace photo",
    removePhoto: "Remove photo",
    remove: (name: string) => `Remove ${name}`,
  },

  views: {
    title: "Views",
    description: "What the Family opens on the home network, without signing in. Anyone on your Wi-Fi can open them.",
    create: "Create View",
    eyebrow: "Family",
    dialogTitle: "Create a View",
    none: "No Views yet.",
    everyone: "Everyone",
    entry: (who: string, days: number) => plural(days, { one: `${who} · ${days} day`, other: `${who} · ${days} days` }),
    startsWith: (who: string | null) => `The quick filter starts with ${who ?? "everyone"}`,
    remove: "Remove View",
    address: "Address",
    feed: "Calendar feed",
    preselected: "Preselected Family Members",
    preselectedHint: "The quick filter starts with them; none means everyone.",
    noMembers: "No Family Members yet.",
    horizon: "Horizon in days",
    horizonHint: `How many days it shows at a time, today included: ${horizonDaysRange.min} to ${horizonDaysRange.max}.`,
  },

  sourceTypes: {
    title: "Source Types",
    description:
      "Each Source Type is provided by an installed plugin. Enable the ones your Family uses: only their code is loaded, and only they are offered when adding a Source. Nothing is enabled without an Admin.",
    none: "No Source Types are installed.",
    newIn: (version: string) => `New in ${version}`,
    version: (version: string) => `Version ${version}`,
    needsLlm: ". Its Sources need the LLM endpoint.",
    notLoadable: (reason: string) => `Not loadable: ${reason}`,
    enabled: "Enabled",
    disable: (name: string) => `Disable ${name}`,
    disableHint: "It can be disabled once it has no Sources.",
    acknowledgeRisk: "I understand the risk.",
    enable: (name: string) => `Enable ${name}`,
  },

  sources: {
    title: "Sources",
    description:
      "The channels information arrives through. A hidden Source is still read, but its Items stay off the timeline until it is shown again. Removing a Source stops reading it and removes everything it has brought in.",
    add: "Add Source",
    chooseEyebrow: "Add a Source · 1 of 2",
    formEyebrow: "Add a Source · 2 of 2",
    onlyFormEyebrow: "Add a Source",
    chooseTitle: "Choose a Source Type",
    chooseIntro: "Which kind of channel? Only enabled Source Types are offered.",
    missingOne: (link: Wrap): Child[] => ["Missing one? Enable it under ", link("Source Types"), "."],
    addType: (name: string) => `Add ${name}`,
    noneEnabled: (link: Wrap): Child[] => ["No Source Type is enabled. ", link("Enable one"), " to add a Source."],
    notRead: "Its Source Type is not enabled or not installed, so it is not read.",
    shown: "Shown on the timeline",
    hidden: "Hidden from the timeline",
    hide: "Hide from the timeline",
    show: "Show on the timeline",
    hiddenHint: "A hidden Source is still read.",
    remove: (name: string) => `Remove this ${name}`,
    secretStored: "secret stored",
    every: (minutes: number) => plural(minutes, { one: `every ${minutes} minute`, other: `every ${minutes} minutes` }),
    hiddenMeta: "hidden from the timeline",
    interval: "Check every … minutes (optional)",
    intervalHint: (minutes: number) => `Empty for the suggested ${minutes}.`,
  },

  llm: {
    title: "LLM endpoint",
    description:
      "Sources such as mailboxes bring in messages, not Events. A language model reads the Events from each message. Family Agenda talks to any server with an OpenAI-compatible API: a local one such as Ollama, llama.cpp or LM Studio, or a cloud provider with an API key.",
    readBy: (model: Child, baseUrl: string, local: boolean): Child[] => [
      "Messages are read by ",
      model,
      ` at ${baseUrl}, ${local ? "on your home network." : "outside your home network."}`,
    ],
    none: "No LLM endpoint is configured yet. Messages wait until one is.",
    baseUrl: "Base URL of the OpenAI-compatible API",
    baseUrlHint: "Such as http://ollama:11434/v1 for Ollama in Compose, or https://api.openai.com/v1.",
    model: "Model",
    apiKey: "API key (optional)",
    removeApiKey: "Remove the stored API key",
    vision:
      "The model reads images. Scanned PDF letters are sent to it as images of their pages; otherwise Tesseract reads them on this Instance.",
    thirdParties:
      "If this server is outside my home network: I understand that the text of messages from third parties, such as teachers' mails, is sent to it.",
  },

  language: {
    title: "Language",
    description:
      "Family Agenda speaks the Family Language, on the Views and here, and writes dates in it. Scanned letters are read in the OCR languages.",
    familyLanguage: "Family Language",
    familyLanguageHint: "Changing it leaves the OCR languages as they are.",
    ocrLanguages: "OCR languages",
    ocrIntro:
      "Without an LLM endpoint that reads images, Tesseract reads scanned pages on this Instance, in these languages together, the first one first. Only languages whose model is installed can be chosen.",
    tried: (position: number) => `Tried ${ordinals[position - 1] ?? `${position}th`}`,
    notInstalled: "Not installed",
    moveUp: "Move up",
    remove: "Remove",
    missingModel: "Scanned letters are not read while a model is missing; their mails say so. Download it, or remove the language.",
    addOcrLanguage: "Add an OCR language",
    add: "Add",
    models: "Language models",
    modelsIntro: (code: Wrap): Child[] => [
      "The models Tesseract reads with, in the ",
      code("tessdata"),
      " volume. Others are downloaded from tesseract-ocr/tessdata_fast and checked against the checksums shipped with Family Agenda. Without internet access, put a ",
      code(".traineddata"),
      " file into the volume.",
    ],
    bundled: "Comes with Family Agenda",
    downloaded: "Downloaded",
    usedForOcr: " · used for OCR",
    removeModel: (name: string) => `Remove ${name}`,
    downloadModel: "Download a model",
    downloadHint: "A model is a few megabytes and takes a moment to download.",
    download: "Download",
    downloadLanguage: (name: string) => `Download ${name}`,
  },

  message: {
    title: "Message",
    description: "The original an Event was read from. Only Admins open it.",
    sent: "Sent",
    deleted: "The text of this message has been deleted.",
    attachments: "Attachments",
    attachment: (contentType: string, kilobytes: number) => `(${contentType}, ${kilobytes} KB)`,
    unreadable: (problem: string) => `Could not be read for extraction: ${problem}`,
  },

  view: {
    title: "View",
    today: "Today",
    quickFilter: "Quick filter",
    all: "All",
    activity: { polling: "Checking Sources", extracting: "Reading messages" },
    earlierDays: "Earlier days",
    loadingLaterDays: "Loading later days…",
    /** How days near today are called, by how many days they lie after it. */
    relativeDays: { "-1": "Yesterday", "0": "Today", "1": "Tomorrow" } as Record<string, string>,
    now: (time: string) => `Now ${time}`,
    nothingPlanned: "Nothing planned.",
    cancelled: "Cancelled",
    when: "When",
    where: "Where",
    status: "Status",
    original: "Original",
    openOriginal: "Open the original",
    openMessage: "Open the message",
    adminsOnly: " (Admins only)",
    from: (time: string) => `from ${time}`,
    until: (time: string) => `until ${time}`,
    allDay: "All day",
    onAllDay: (date: string) => `${date}, all day`,
  },
};

export type Catalogue = typeof en;
