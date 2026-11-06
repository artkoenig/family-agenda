/**
 * Seeds the demo Family into the Instance this container belongs to. `pnpm preview up` runs it
 * with `docker compose exec api`, with the pull request's own `apps/api` under /app.
 */
import { seedDemoFamily } from "./seed";

type Api = {
  composition: typeof import("@family-agenda/api/composition-root");
  config: typeof import("@family-agenda/api/config");
};

const root = process.env.APP_ROOT ?? "/app";
const api: Api = {
  composition: (await import(`${root}/apps/api/src/composition-root.ts`)) as Api["composition"],
  config: (await import(`${root}/apps/api/src/config.ts`)) as Api["config"],
};

const application = await api.composition.bootApplication(api.config.readConfig());
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
