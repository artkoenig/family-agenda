# Upgrading and backups

How to back up an Instance, move it to another release, switch between `latest` and `main`, and start over when a release needs it. It assumes the stack is named `family-agenda`, which gives the volumes below their `family-agenda_` prefix. In Portainer, name the stack that, see [portainer.md](portainer.md).

> [!NOTE]
> The backup and restore commands below have not been rehearsed on a running Instance yet. Version 1.0.0 will not be released before they have been.

## Before you upgrade: what the release says

Every GitHub Release has an **Upgrading** section that is written from the changes since the release before it:

- **Data is kept.** The database is migrated when the Instance starts, if the release has new migrations.
- **This migration removes data**, with the name of the migration file. Make a backup first and read the release.
- **Start over required.** The data model changed in a way that cannot be migrated, or Source Types moved from in-process plugins to plugin containers listed in `plugins.yml`. See [Start over](#start-over).
- **Postgres major upgrade: dump and restore required.** The Postgres version of the compose file changed. See [Restore](#restore).

Releases before 1.0.0 may ask you to start over. Read the section before every upgrade.

## Back up

Do this before every upgrade, and before switching between `main` and a release. The backup is a dump of all Postgres databases plus the volumes below. Run the commands in the folder of your `compose.yaml`.

1. Dump Postgres. Use `pg_dumpall`, not a dump of one database: plugin companions with `database: true`, such as the Messengers' Synapse, keep their own databases on the same Postgres server.

   ```bash
   docker compose exec -T postgres pg_dumpall -U family_agenda > family-agenda-postgres.sql
   ```

2. Stop the application, so that no file changes while it is copied.

   ```bash
   docker compose stop api worker mdns
   ```

3. Copy the volumes that hold data: `blobs` and the plugin volumes (`plugin-<id>-<name>`, see [Plugins](configuration.md#plugins)), and keep `plugins.yml`. `tessdata` is left out: Tesseract models can be downloaded again.

   ```bash
   for volume in blobs $(docker volume ls -q --filter name=family-agenda_plugin- | sed s/^family-agenda_//); do
     docker run --rm -v "family-agenda_${volume}:/data:ro" -v "$PWD:/backup" alpine \
       tar czf "/backup/family-agenda-${volume}.tar.gz" -C /data .
   done
   ```

4. Start the application again.

   ```bash
   docker compose start api worker mdns
   ```

Keep your **Recovery Kit**. Without it the Source credentials in a restored backup cannot be read (ADR-0003). The `master-key` volume is not part of the commands above on purpose. If you copy it as well, store that copy apart from the other backup files, because together they open every stored credential.

Keep the backup files somewhere other than the host that runs the Instance.

## Upgrade to another release

1. Read the **Upgrading** section of the release you move to, and make a [backup](#back-up).
2. Name the release. Either set `FAMILY_AGENDA_VERSION` to it (in `.env` next to `compose.yaml`, or in the variables of your stack tool), or download the `compose.yaml` of the release, which has it as its default.
3. Pull the new image and start the Instance.

   ```bash
   docker compose pull
   docker compose up -d
   ```

An Instance runs the release you named. `latest` is the newest release; it moves when a new release is published, and only after you pull. An exact version such as `0.3.1` never changes under you.

Check the running version in the Admin area, below the settings list, or at `/api/health`.

## Switching between `main` and a release

`main` is the current state of the main branch. It may have a different data model than the last release and **has no guarantee that it keeps your data**. It is for trying changes.

- Make a [backup](#back-up) before you switch to `main`.
- Do not switch back to a release without restoring that backup. If `main` changed the database, the older release refuses to start and says so ("migrated by a newer version"), instead of running on a schema it does not know. Restore the backup taken before you switched, then start the release.

## Start over

When a release says **Start over required**, or an Instance refuses to start because its database comes from before the data model was rebuilt (ADR-0005), the data cannot be carried over. Make a backup first if you want to keep a copy. Then stop the Instance, remove the volumes that hold data of the old model, and start it again.

```bash
docker compose down
docker volume rm family-agenda_postgres-data family-agenda_blobs
docker compose up -d
```

Remove the volumes of plugins you start over with too (`docker volume ls`, those named `family-agenda_plugin-*`); coming from in-process plugins, also remove the old `plugins`, `matrix-data` and `matrix-instance` volumes, and set up `plugins.yml` (see [Plugins](configuration.md#plugins)). A custom plugin you kept in the `plugins` volume no longer loads: build it as a container image that answers the plugin contract ([plugin-kit.md](plugin-kit.md)) and list it in `plugins.yml`. The `master-key` and `tessdata` volumes can stay. Keep the `master-key` volume if you want the Recovery Kit you saved to stay valid for the credentials you enter again. If you remove it, the first start creates a new master key and a new Recovery Kit, and the old kit opens nothing.

Then open the Instance, create the first Admin, keep the Recovery Kit it shows, and add Family Members, Agendas and Sources again.

## Restore

To restore a [backup](#back-up), on a stopped Instance with its Postgres volume removed:

```bash
docker compose down
docker volume rm family-agenda_postgres-data
docker compose up -d postgres
docker compose exec -T postgres psql -U family_agenda -d postgres < family-agenda-postgres.sql
```

Messages that something exists already (the `family_agenda` role and database are created on the first start) can be ignored. Then put the volumes back, each from its archive, and start the rest:

```bash
for archive in family-agenda-*.tar.gz; do volume="${archive#family-agenda-}"; volume="${volume%.tar.gz}"
  docker run --rm -v "family-agenda_${volume}:/data" -v "$PWD:/backup" alpine \
    sh -c "cd /data && tar xzf /backup/family-agenda-${volume}.tar.gz"
done
docker compose up -d
```

For a **Postgres major upgrade** the new Postgres starts with an empty data directory. Make the backup with the old version running, change the version, and restore as above. Then enter your Recovery Kit if the `master-key` volume was not kept.
