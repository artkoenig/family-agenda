/** A Task as a message once stated it, which extraction would have written. */
export type SeededTask = {
  /** The message's id within its Source. */
  key: string;
  /** When the message was sent. */
  sentAt: string;
  title: string;
  deadline?: string;
  description?: string;
  cancelled?: boolean;
};

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * Writes Tasks as extraction writes them, each on the Source Record of its own message of the first
 * Source: only messages state Tasks, and nothing changes them after (ADR-0005).
 */
export async function seedTasks(query: (sql: string) => Promise<unknown>, ...tasks: SeededTask[]): Promise<void> {
  for (const task of tasks) {
    await query(`
      WITH record AS (
        INSERT INTO source_record (source_id, external_id, occurred_at, body, processed_at, created_at)
        VALUES ((SELECT id FROM source ORDER BY position LIMIT 1), ${literal(task.key)}, ${literal(task.sentAt)}, '', ${literal(task.sentAt)}, ${literal(task.sentAt)})
        RETURNING id
      ), written AS (
        INSERT INTO item (kind, record_id, created_at) SELECT 'task', id, ${literal(task.sentAt)} FROM record RETURNING id
      )
      INSERT INTO task (item_id, title, deadline, description, cancelled)
      SELECT id, ${literal(task.title)}, ${task.deadline ? literal(task.deadline) : "NULL"}, ${task.description ? literal(task.description) : "NULL"}, ${task.cancelled === true} FROM written
    `);
  }
}
