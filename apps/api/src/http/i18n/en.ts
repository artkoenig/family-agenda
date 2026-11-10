import { pollIntervalRange, signInLimits } from "@family-agenda/application";
import {
  horizonDaysRange,
  maximumNameLength,
  maximumPhotoBytes,
  minimumPasswordLength,
  photoTypes,
  type FamilyLanguage,
  type AgendaLayout,
} from "@family-agenda/domain";
import type { Child } from "hono/jsx";
import { plurals } from "./plurals";

const plural = plurals("en");

/** Wraps part of a sentence in markup, such as a link, keeping the sentence's word order. */
type Wrap = (text: string) => Child;

const photoFormats = photoTypes.map((type) => type.replace("image/", "").toUpperCase()).join(", ");

const ordinals = ["first", "second", "third"];

/**
 * Every text the Admin area, the Agendas and their feeds show, in English. It is the source of
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
    "invalid-colour": "Choose one of the colours.",
    "invalid-photo": `The photo must be one of ${photoFormats}.`,
    "photo-too-large": `The photo must be at most ${maximumPhotoBytes / 1024 / 1024} MB.`,
    "unknown-member": "This Family Member does not exist.",
    "unknown-layout": "Choose what the Agenda shows: a timeline or a Task List.",
    "invalid-horizon": `The horizon must be between ${horizonDaysRange.min} and ${horizonDaysRange.max} days.`,
    "unknown-agenda": "This Agenda does not exist.",
    "unknown-source-type": "This Source Type is not installed.",
    "not-loadable": "This Source Type cannot be loaded.",
    "risk-not-acknowledged": "Confirm that you understand the risk.",
    "has-sources": "Remove the Sources of this Source Type before disabling it.",
    "source-type-not-enabled": "This Source Type is not enabled.",
    "unknown-source": "This Source does not exist.",
    "invalid-endpoint-url": "Enter the base URL as an http or https address, such as http://ollama:11434/v1.",
    "invalid-model": "Enter the name of the model.",
    "third-parties-not-acknowledged":
      "This server is outside your home network. Confirm that the text of third parties' messages is sent to it.",
    "no-ocr-language": "Keep at least one OCR language.",
    "unknown-ocr-language": "That OCR language does not exist, or is not in the list.",
    "unknown-attribute": "This part of the Source does not exist.",
    "unknown-entry": "This entry is not in the catalogue.",
    "not-installed": "This is not installed on the Instance. It needs an image of Family Agenda that includes it.",
    "entry-in-use": "Remove the Sources that use it before disabling it.",
    "sso-failed":
      "Signing in through the Identity Provider did not work. Try again.",
    "sso-not-in-group":
      "Your account at the Identity Provider is not in the group that may sign in here.",
    "sso-email-unverified":
      "The Identity Provider has not verified an email address for your account.",
    "sso-conflict":
      "An Admin with this email is already linked to another account at the Identity Provider.",
    "invalid-interval": `The polling interval must be between ${pollIntervalRange.minSeconds / 60} minute and ${pollIntervalRange.maxSeconds / 86_400} days.`,
  },
  /** Problems that name what went wrong. */
  problemsWith: {
    /** A Source that cannot be saved, naming the fields by their labels. */
    invalidConfig: (fields: string) => `Check ${fields}.`,
    /** The plugin could not prepare a Source being added. */
    setupFailed: (message: string) =>
      `The Source could not be set up: ${message}`,
    downloadFailed: (message: string) =>
      `The model could not be downloaded. ${message}`,
  },

  loading: {
    default: "Loading…",
    choices: (label: string) => `Loading ${label}…`,
    catalogue: (title: string) => `Loading ${title}…`,
    failed: "This could not be loaded.",
    failedMessage: "The page could not reach the server. Reload it to try again.",
    gone: "What this showed no longer exists. Reload the page.",
    slow: "This is taking longer than usual. Reload the page to try again.",
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
    singleSignOn: "Sign in with passkey",
  },


  settings: {
    title: "Settings",
    signOut: "Sign out",
    version: (version: string) => `Version ${version}`,
    groups: { family: "Family", sources: "Sources", instance: "Instance" },
    failingSource: "A Source is failing",
    failingSourceBody: "Some Items may be out of date until it is fixed.",
    lookAtSources: "Look at the Sources",
    failing: (count: number) => `${count} failing`,
    noneYet: "None yet",
    agendas: (count: number) =>
      plural(count, { one: `${count} Agenda on the home network`, other: `${count} Agendas on the home network` }),
    display: (family: string) => family,
    ocr: (languages: string) => `OCR in ${languages}`,
    ocrOff: "OCR off",
    sources: (count: number) => plural(count, { one: `${count} Source`, other: `${count} Sources` }),
    llmLocal: (model: string) => `${model}, on the home network`,
    llmRemote: (model: string) => `${model}, outside the home network`,
    llmFailing: "Connection problem",
    notSetUp: "Not set up",
    admins: (count: number) => plural(count, { one: `${count} Admin`, other: `${count} Admins` }),
    saved: "Saved",
    on: "On",
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
    confirmTitle: "Confirm",
    continue: "Continue",
  },

  members: {
    title: "Family Members",
    description: "Whom Items can concern. Each keeps an avatar colour; a photo replaces the initial.",
    add: "Add Family Member",
    eyebrow: "Family",
    dialogTitle: "Add a Family Member",
    name: "Name",
    nameHint: `How the Agendas call them, up to ${maximumNameLength} characters.`,
    photo: "Photo (optional)",
    photoHint: "Without one, the avatar shows the initial on a colour of its own.",
    none: "No Family Members yet.",
    withPhoto: "With a photo",
    withInitial: "Shows the initial",
    colour: "Colour",
    /** The name of a colour choice for screen readers. */
    colourNumber: (n: number) => `Colour ${n}`,
    replacePhoto: "Replace photo",
    removePhoto: "Remove photo",
    remove: (name: string) => `Remove ${name}`,
    /** Why they cannot be removed yet: `blocking` are their Source Attributes, each as "Source: Attribute". */
    soleAssignee: (name: string, blocking: string) =>
      `${name} is the only one assigned to ${blocking}. Assign them to someone else first, or to no one for the whole Family.`,
  },

  agendas: {
    title: "Agendas",
    description: "What the Family opens on the home network, without signing in. Anyone on your Wi-Fi can open them.",
    create: "Create Agenda",
    eyebrow: "Family",
    dialogTitle: "Create an Agenda",
    none: "No Agendas yet.",
    everyone: "Everyone",
    entry: (who: string, days: number) => plural(days, { one: `${who} · ${days} day`, other: `${who} · ${days} days` }),
    taskListEntry: (who: string) => `Task List · ${who}`,
    shows: (who: string | null) => `Shows ${who ?? "everyone"}`,
    remove: "Remove Agenda",
    address: "Address",
    feed: "Calendar feed",
    copy: "Copy",
    copied: "Copied",
    layout: "Shows",
    layouts: {
      timeline: { label: "Timeline", hint: "Events, school days and Tasks, day by day" },
      task_list: { label: "Task List", hint: "Only Tasks: to do, coming up, done" },
    } satisfies Record<AgendaLayout, { label: string; hint: string }>,
    memberIds: "Family Members",
    memberIdsHint: "The Agenda shows only them, and its quick filter offers only them; none means everyone.",
    noMembers: "No Family Members yet.",
    horizon: "Horizon in days",
    horizonHint: `How many days it shows at a time, today included: ${horizonDaysRange.min} to ${horizonDaysRange.max}.`,
  },

  sourceTypes: {
    use: (name: string) => `Use ${name}`,
    version: (version: string) => `Version ${version}`,
    needsLlm: ". Its Sources need the LLM endpoint.",
    notLoadable: (reason: string) => `Not loadable: ${reason}`,
    notReachable: (reason: string) => `Not reachable: ${reason}`,
    enabled: "Enabled",
    notEnabled: "Not enabled",
    lockedHint: (name: string) => `Locked while ${name} has Sources.`,
    riskTitle: "Read this before enabling it",
    acknowledgeRisk: "I understand the risk.",
    enable: (name: string) => `Enable ${name}`,
    catalogueIntro: "Enable the ones your Family uses, then add Sources at each of them.",
    catalogueFailed: "The plugin could not list them.",
    notInstalled: "Not installed on this Instance",
    entryLockedHint: (name: string) => `Locked while a Source uses ${name}.`,
    entryIntervalHint: (name: string, minutes: number) => `For all ${name} accounts. Empty for the suggested ${minutes}.`,
    accounts: "Accounts",
    noAccounts: "No accounts yet.",
  },

  sources: {
    title: "Sources",
    description:
      "The channels information arrives through, by Source Type. Each Source Type is provided by an installed plugin; open one to enable it and to add, fix or remove its Sources. Nothing is enabled without an Admin.",
    none: "No Source Types are installed.",
    count: (count: number) => plural(count, { one: `${count} Source`, other: `${count} Sources` }),
    noSources: "No Sources yet",
    failingCount: (count: number) => `${count} failing`,
    silentCount: (count: number) => `${count} silent`,
    allOk: "All OK",
    notEnabled: "Not enabled",
    breadcrumb: "Where you are",
    sourcesIntro: "Open a Source to change, hide or remove it.",
    addEyebrow: "Add a Source",
    addType: (name: string) => `Add ${name}`,
    addAccount: "Add account",
    addAccountOf: (name: string) => `Add a ${name} account`,
    notRead: "Its Source Type is not enabled or not installed, so it is not read.",
    settings: "Settings",
    name: "Name",
    nameHint: (derived: string) => `How it is listed in the settings. Empty for “${derived}”.`,
    polling: "Polling",
    timeline: "Timeline",
    management: "Management",
    hidden: "Hidden",
    show: "Show on the timeline",
    hiddenHint: "A hidden Source is still read, but its Items stay off the timeline.",
    concernsList: (names: string) => `Concerns ${names}`,
    attributes: "Concerns",
    attributesHint: "Tap the Family Members each part of this Source concerns, such as a mail folder or a child, also for Items it brought in before. With no one chosen, it concerns the whole Family.",
    attributesLoading: "Asking the Source for its parts…",
    attributesNone: "The Source names no parts it could concern.",
    attributesFailed: (message: string) => `Its parts could not be asked for, so those known so far show: ${message}`,
    attributesPending: "Reading the Source for the first time. Its parts appear here as soon as they are known.",
    attributeMembers: (name: string) => `Concerns, for ${name}`,
    attributeWholeFamily: "Concerns the whole Family",
    attributeArchived: "Gone from the Source",
    remove: "Remove this Source",
    removeHint: "Stops reading it and removes everything it has brought in.",
    removeButton: "Remove",
    waitingTitle: "Messages",
    noneChosen: "none yet",
    every: (minutes: number) => plural(minutes, { one: `every ${minutes} minute`, other: `every ${minutes} minutes` }),
    interval: "Polling interval (optional)",
    intervalUnit: "minutes",
    intervalHint: (minutes: number) => `Empty for the suggested ${minutes}.`,
    status: { ok: "OK", failing: "Failing", silent: "Silent" },
    silentHint: (days: number) => `Nothing new for ${days} days.`,
    lastError: (message: string) => `Last error: ${message}`,
    invalidRecords: (count: number) =>
      count === 1 ? "1 entry is not valid, so it is not shown." : `${count} entries are not valid, so they are not shown.`,
    unknownAttributes: (ids: string) => `The Source named parts it never reported (${ids}), so those records were left out.`,
    lastRead: (when: string) => `Last read ${when}`,
    notReadYet: "Not read successfully yet",
    notInstalled: "Source Type not installed",
    notLoadable: (reason: string) => `Source Type cannot be loaded: ${reason}`,
    cannotLoad: "Source Type cannot be loaded",
    notReachable: "Not reachable",
    fix: "Fix",
    fixEyebrow: "Fix a Source",
    saveAndRead: "Save and read again",
    noEntries: (link: Wrap): Child[] => ["None is enabled yet. ", link("Enable one"), " first."],
    choicesAfterSetup: "Offered once the Source is set up.",
    noChoices: "Nothing to choose from yet. Come back once the Source has been read.",
    choicesFailed: "The plugin could not offer anything to choose from.",
    setupEyebrow: "Set up a Source",
    setupWaiting: "Waiting …",
    settingUp: "Setting up …",
    setupDone: "Done.",
    qrCode: "QR code to scan",
    finish: "Finish",
  },


  llm: {
    connection: "Connection",
    options: "Options",
    title: "AI",
    description:
      "Sources such as mailboxes bring in messages, not Events. A language model reads the Events from each message. Family Agenda talks to any server with an OpenAI-compatible API: a local one such as Ollama, llama.cpp or LM Studio, or a cloud provider with an API key.",
    baseUrl: "Base URL of the OpenAI-compatible API",
    baseUrlHint: "Such as http://ollama:11434/v1 for Ollama in Compose, or https://api.openai.com/v1.",
    model: "Model",
    apiKey: "API key (optional)",
    removeApiKey: "Remove the stored API key",
    thirdParties:
      "If this server is outside my home network: I understand that the text of messages from third parties, such as teachers' mails, is sent to it.",
    waitingTitle: "Messages",
    waiting: (count: number) => plural(count, { one: `${count} message waits to be read.`, other: `${count} messages wait to be read.` }),
    statusOk: "OK",
    statusFailing: "Failing",
    connectionError: "Connection error",
    remove: "Switch AI off",
    testOk: "Test: connected",
    testFailing: "Test: failing",
    testConnection: "Test connection",
    testing: "Testing the connection…",
    loadingModels: "Loading the models of the endpoint…",
    connected: (count: number) =>
      plural(count, { one: `Connected: the endpoint lists ${count} model.`, other: `Connected: the endpoint lists ${count} models.` }),
    modelsAfterTest: "Test the connection to choose from the models of the endpoint.",
    noModels: "The endpoint lists no models; enter the name of one.",
    modelsFailed: "The models could not be loaded, as the connection error says; enter the name of one.",
    noAnswer: "The LLM endpoint did not answer in time.",
  },

  display: {
    title: "Display",
    description:
      "Family Agenda speaks the Family Language, on the Agendas and here, and writes dates in it. How the pages look is up to each browser.",
    familyLanguage: "Family Language",
    familyLanguageHint: "Applies to the whole Instance. Changing it leaves the OCR languages as they are.",
    theme: "Appearance",
    themeHint: "Kept in this browser only; every device and browser chooses its own.",
    themeOptions: { system: "As the device", light: "Light", dark: "Dark" },
  },

  ocr: {
    title: "OCR",
    ocrIntro:
      "The LLM only ever receives text from PDFs, so that large files cannot overrun its context. Tesseract reads scanned pages without text on this Instance, whatever model the LLM endpoint uses.",
    enable: "Switch OCR on",
    enableHint:
      "Switched off, scanned pages stay unread; their mails say so. Tesseract reads in the languages below together, the first one first. A new language is downloaded where needed, and a removed one deleted.",
    tried: (position: number) => `Tried ${ordinals[position - 1] ?? `${position}th`}`,
    notInstalled: "Model missing",
    moveUp: "Move up",
    remove: "Remove",
    missingModel: "Scanned letters are not read while a model is missing; their mails say so. Download it, or remove the language.",
    addLanguage: "Add an OCR language",
    add: "Add",
    addHint: (code: Wrap): Child[] => [
      "The model is a few megabytes, is downloaded from tesseract-ocr/tessdata_fast and checked against the checksums shipped with Family Agenda. Without internet access, put a ",
      code(".traineddata"),
      " file into the ",
      code("tessdata"),
      " volume.",
    ],
    downloadLanguage: (name: string) => `Download ${name}`,
  },

  message: {
    title: "Message",
    description: "The original its Items were read from. Only Admins open it.",
    sent: "Sent",
    purged: "The content of this message is no longer kept.",
    sender: "From",
    subject: "Subject",
    attributes: "Concerns",
    attachments: "Attachments",
    attachment: (contentType: string, kilobytes: number) => `(${contentType}, ${kilobytes} KB)`,
    unreadable: (problem: string) => `Could not be read for extraction: ${problem}`,
    items: "Items read from it",
    noItems: "No Items were read from it.",
    itemsHint: "A wrong Item can only be deleted; the message is not read again.",
    event: "Event",
    task: "Task",
    lesson: "Lesson",
    deleteItem: "Delete",
  },

  agenda: {
    title: "Agenda",
    today: "Today",
    quickFilter: "Quick filter",
    theme: {
      system: "Appearance: as the device. Switch to light.",
      light: "Appearance: light. Switch to dark.",
      dark: "Appearance: dark. Switch to as the device.",
    },
    all: "All",
    activity: { polling: "Checking Sources", extracting: "Reading messages" },
    earlierDays: "Earlier days",
    loadingLaterDays: "Loading later days…",
    /** How days near today are called, by how many days they lie after it. */
    relativeDays: { "-1": "Yesterday", "0": "Today", "1": "Tomorrow" } as Record<string, string>,
    nothingPlanned: "Nothing planned.",
    cancelled: "Cancelled",
    where: "Where",
    source: "Source",
    openMessage: "Open the message",
    from: (time: string) => `from ${time}`,
    until: (time: string) => `until ${time}`,
    allDay: "All day",
    onAllDay: (date: string) => `${date}, all day`,
    /** The last day of an Event that goes on after the day it shows on. */
    untilDay: (date: string) => `Until ${date}`,
    outOfDate: "Some of this may be out of date.",
    school: "School",
    schoolUntil: (time: string) => `School until ${time}`,
    lessons: "Lessons",
    running: "Now",
    timetableChange: "Timetable change",
    teacher: "Teacher",
    note: "Note",
    /** What a Timetable Change did to its Lesson, after the Lesson's subject. */
    changed: {
      cancellation: "cancelled",
      substitution: (teacher: string | null) => (teacher ? `substituted by ${teacher}` : "substitution"),
      "room-change": (room: string | null) => (room ? `moved to room ${room}` : "room change"),
    },
    instead: (previous: string) => `instead of ${previous}`,
    /** The pinned Tasks at the top of an Agenda. */
    toDo: "To do",
    by: (date: string) => `By ${date}`,
    due: "Due",
    overdue: "Overdue",
    overdueBy: (date: string) => `Overdue · by ${date}`,
    done: "Done",
    bring: "Bring",
    markDone: (title: string) => `Mark “${title}” done`,
    markNotDone: (title: string) => `Mark “${title}” not done`,
    taskList: {
      title: "Task List",
      upcoming: "Coming up",
      done: "Done · last 30 days",
      none: "Nothing to do.",
    },
  },
};

export type Catalogue = typeof en;
