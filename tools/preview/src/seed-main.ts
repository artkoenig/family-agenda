/**
 * Seeds the demo Family into the Instance this container belongs to. `pnpm preview up` runs it
 * with `docker compose exec api`, with the pull request's own `apps/api` under /app.
 */
import { seedDemoFamily } from "./seed";

const root = process.env.APP_ROOT ?? "/app";
const composition = (await import(`${root}/packages/composition/src/index.ts`)) as typeof import("@family-agenda/composition");

const application = await composition.bootSelfHosted();
try {
  const seeded = await seedDemoFamily(application);
  if (!seeded.ok) {
    console.error(`Seeding failed: ${seeded.problem}`);
    process.exitCode = 1;
  } else {
    console.log(`Seeded ${seeded.agendas.length} Agendas. Admin: ${seeded.admin.email} / ${seeded.admin.password}`);
  }
} finally {
  await application.close();
}
