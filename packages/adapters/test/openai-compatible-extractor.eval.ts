import type { LocalDate, LocalTime } from "@family-agenda/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { OpenAiCompatibleExtractor } from "../src/openai-compatible-extractor";

/**
 * Whether a real LLM reads the right Tasks out of a message, above all by who wrote it: what the
 * Family offers is a Task, what others offer is not; what it asks of others is one only with a date. Run with `pnpm eval`.
 */
const baseUrl = (process.env.EVAL_LLM_BASE_URL ?? "http://localhost:8765/v1").replace(/\/$/, "");
const apiKey = process.env.EVAL_LLM_API_KEY ?? null;
const runs = Number(process.env.EVAL_RUNS ?? 1);

type Writer = "family" | "someone else";
/** Each Task as a pattern its title or description matches, in any order; none for no Task. */
type Case = { text: string; tasks: Record<Writer, RegExp[]> };

/** The same Tasks, whoever wrote the message. */
const either = (...tasks: RegExp[]): Case["tasks"] => ({ family: tasks, "someone else": tasks });
/** Tasks only of a message the Family wrote. */
const onlyFamily = (...tasks: RegExp[]): Case["tasks"] => ({ family: tasks, "someone else": [] });
/** Tasks only of a message someone else wrote. */
const onlyElse = (...tasks: RegExp[]): Case["tasks"] => ({ family: [], "someone else": tasks });

const cases: Record<string, Case> = {
  "a hedged offer": { text: "Ich würde etwas Laugengebäck mitbringen", tasks: onlyFamily(/laugen/i) },
  "a promise": { text: "Ich bringe Saft mit", tasks: onlyFamily(/saft/i) },
  "a promise in the plural": { text: "Wir kümmern uns um die Getränke für das Sommerfest am Samstag 🙂", tasks: onlyFamily(/getränke/i) },
  "a promise with a date": { text: "Ich überweise das Geld für das Geschenk bis Freitag an Sabine.", tasks: onlyFamily(/geld|geschenk|überweis/i) },
  "a promise among chatter": {
    text: "Hallo zusammen, das klingt super! Wir freuen uns schon sehr. Ich backe dann einen Apfelkuchen. Liebe Grüße, Anna",
    tasks: onlyFamily(/kuchen/i),
  },
  "an offer to drive": { text: "Ich kann am Mittwoch vier Kinder zum Turnier fahren.", tasks: onlyFamily(/fahr|turnier/i) },
  "an offer in English": { text: "I can bring paper plates and napkins on Friday.", tasks: onlyFamily(/plates/i) },
  "an answer taking a job": { text: "Dann übernehme ich die Servietten!", tasks: onlyFamily(/serviett/i) },
  "what is already done": { text: "Ich habe den Kuchen schon gestern in der Kita abgegeben.", tasks: either() },
  "chatter": { text: "Danke euch allen, das war ein toller Nachmittag!", tasks: either() },
  "a refusal": { text: "Ich schaffe es leider nicht, etwas mitzubringen.", tasks: either() },
  "a request along with an offer": {
    text: "Ich bringe Saft mit, bringt bitte Becher mit.",
    tasks: { family: [/saft/i], "someone else": [/becher/i] },
  },
  "a request with a deadline along with an offer": {
    text: "Ich bringe Saft mit, bringt bitte bis Freitag Becher mit.",
    tasks: { family: [/saft/i, /becher/i], "someone else": [/becher/i] },
  },
  "a request with a deadline": { text: "Bitte überweist mir bis zum 27.11. die 10 Euro für das Geschenk.", tasks: either(/geschenk|10 euro|überweis/i) },
  "a request for a day": { text: "Kannst du morgen die Sportsachen einpacken?", tasks: either(/sport/i) },
  "a request without a date": { text: "Kannst du bitte die Sportsachen einpacken?", tasks: onlyElse(/sport/i) },
  "a polite request without a date": { text: "Könnte vielleicht jemand Servietten besorgen? Das wäre toll!", tasks: onlyElse(/serviett/i) },
  "an urgent request without a date": { text: "Schickt mir bitte alle noch eure Telefonnummern!", tasks: onlyElse(/telefon/i) },
};

/** What others ask of the Family, only read as they write it. */
const requests: Record<string, RegExp[]> = {
  "Bitte gebt den Kindern am Donnerstag Sportsachen mit.": [/sport/i],
  "Könnte vielleicht jeder eine Kleinigkeit fürs Buffet am Freitag mitbringen?": [/buffet|kleinigkeit/i],
  "Der unterschriebene Elternbrief muss bis zum 27.11. abgegeben werden.": [/elternbrief/i],
  "---------- Forwarded message ---------\nVon: Anna Muster\n\nIch bringe Saft mit. Bitte bringt Becher mit.": [/becher/i],
};

let model = process.env.EVAL_LLM_MODEL ?? "";

/** The Tasks one reading of the message gives, each as its texts. */
async function tasksOf(text: string, writer: Writer): Promise<string[]> {
  const result = await new OpenAiCompatibleExtractor({ timeoutMs: 5 * 60 * 1000 }).extract({
    endpoint: { baseUrl, model, apiKey },
    message: {
      text,
      own: writer === "family",
      sent: { date: "2026-11-23" as LocalDate, time: "18:30" as LocalTime, weekday: "monday" },
    },
  });
  if (!result.ok) throw new Error(`${result.problem}: ${result.message}`);
  return result.tasks.map((task) => [task.title, task.description].filter(Boolean).join(" | "));
}

/** Fails unless each expected Task is read, and no other one. */
function expectTasks(read: string[], expected: RegExp[], said: string) {
  expect(read.length, `${said}: read ${JSON.stringify(read)}`).toBe(expected.length);
  for (const pattern of expected) expect(read.some((task) => pattern.test(task)), `${said}: ${pattern} in ${JSON.stringify(read)}`).toBe(true);
}

beforeAll(async () => {
  const check = await new OpenAiCompatibleExtractor().check({ baseUrl, model, apiKey });
  if (!check.ok) throw new Error(`${check.message} Start a server at ${baseUrl}, or set EVAL_LLM_BASE_URL.`);
  model ||= check.models[0] ?? "";
  if (!model) throw new Error(`${baseUrl} lists no model; set EVAL_LLM_MODEL.`);
  console.log(`Reading with ${model} at ${baseUrl}, ${runs} time(s) each.`);
});

describe.each(["family", "someone else"] as const)("a message written by %s", (writer) => {
  const all = Object.entries(cases).map(([name, { text, tasks }]) => ({ name, text, tasks: tasks[writer] }));
  it.each(all)("$name: $text", async ({ text, tasks }) => {
    for (let run = 0; run < runs; run++) expectTasks(await tasksOf(text, writer), tasks, text);
  });
});

describe("a request by someone else", () => {
  it.each(Object.entries(requests))("%s", async (text, tasks) => {
    for (let run = 0; run < runs; run++) expectTasks(await tasksOf(text, "someone else"), tasks, text);
  });
});

describe("a mail the family forwarded", () => {
  it("is read as someone else's promise and request", async () => {
    const text = "Zur Info\n\n---------- Forwarded message ---------\nVon: Anna Muster\n\nIch bringe Saft mit. Bitte bringt Becher mit.";
    for (let run = 0; run < runs; run++) {
      const read = await tasksOf(text, "family");
      expectTasks(read, [/becher/i], text);
    }
  });
});
