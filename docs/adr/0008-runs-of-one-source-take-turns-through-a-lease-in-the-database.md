---
status: accepted
---

# Runs of one Source take turns through a lease row in the Family's database

Runs of one Source take turns: a poll and a pushed payload for the same Source never overlap, each reading the Source as the last one left it, so that none starts from a Sync Cursor another is about to replace and no Source Record is written twice. Several api containers serve one Family on one database, so the rule is kept there: the `source_run_turn` table holds one row per Source while a run holds its turn, naming the process (`holder`) and when the turn expires (`expires_at`).

A run takes the turn in one statement, inserting the row or taking over one whose expiry has passed, and asks again every 50 ms until it gets it. While the run lasts it renews the expiry every 20 s, a turn lasting 60 s unrenewed; after the run it deletes the row. A container that dies in a run stops renewing, and once the expiry has passed its run is known to be over and another container takes the turn. Within a process the runs of a Source still queue in memory first, so that only one of them at a time asks the database. Turns are per Source, so runs of different Sources never wait for each other. A poll that got the turn reads its Source afresh and runs only if it is still due: due work triggered on two containers at once polls each due Source once.

## Considered Options

- **Postgres advisory locks**, session- or transaction-scoped. Released by Postgres itself when a connection dies, which a lease only approximates by its expiry. But a session lock must stay on one connection of the pool for the whole run, and a transaction lock keeps a transaction open across the plugin's call, which can take as long as its timeout. The in-process Postgres (PGlite) the tests run on has one connection that every container of a test shares, and an advisory lock is re-entrant within a session, so two containers would never wait for each other there and the rule could not be tested. Rejected.
- **A column on `source_run`.** That row is written in the transaction that records a run; a lease beside it would mix what a run left with who runs now. Rejected for a table of its own.
- **Keeping the rule in memory, as before.** Holds only within one process. Rejected.

## Consequences

- A container that dies in a run blocks its Source for up to a minute.
- A run waiting for another container's run asks the database every 50 ms meanwhile.
- The expiry is compared with the Clock of the process taking the turn, so the containers of a Family need clocks that agree to within seconds.
