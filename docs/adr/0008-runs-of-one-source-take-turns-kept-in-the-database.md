---
status: accepted
---

# Runs of one Source take turns, kept in the Family's database

Runs of one Source take turns: a poll and a pushed payload for the same Source never overlap, each reading the Source as the last one left it, so that none starts from a Sync Cursor another is about to replace and no Source Record is written twice. Several api containers serve one Family on one database, so the turn is kept there: the `source_run_turn` table holds one row per Source while a run holds its turn, naming the process (`holder`) and when the turn expires (`expires_at`).

A run takes the turn in one statement, inserting the row or taking over one whose expiry has passed. While the run lasts it renews the turn every 20 s, a turn lasting 60 s unrenewed; after the run it deletes the row. A container that dies in a run stops renewing, and once the expiry has passed its run is known to be over and another container takes the turn. Expiry is set and compared by the database's `now()`, so the containers' clocks need not agree.

A run records nothing unless it still holds its turn: the transaction that writes its Source Records and Sync Cursor first locks the turn's row, and rolls back if another holder has it or it has expired. A renewal that finds the turn lost stops the run before it records anything. Either way the run is reported as lost.

Due work asks for a Source's turn once and leaves a Source another container runs to the next round, so that it never waits behind one run and delays the Sources after it. A poll that got the turn reads its Source afresh and runs only if it is still due: due work triggered on two containers at once polls each due Source once. A pushed payload waits for the turn, asking every 50 ms, for at most two minutes, then fails temporarily. Within a process the runs of a Source still queue in memory first, so that only one of them at a time asks the database. Turns are per Source, so runs of different Sources never wait for each other.

## Considered Options

- **Postgres advisory locks**, session- or transaction-scoped. Released by Postgres itself when a connection dies, which a turn only approximates by its expiry. But a session lock must stay on one connection of the pool for the whole run, and a transaction lock keeps a transaction open across the plugin's call, which can take as long as its timeout. The in-process Postgres (PGlite) the tests run on has one connection that every container of a test shares, and an advisory lock is re-entrant within a session, so two containers would never wait for each other there and the rule could not be tested. Rejected.
- **A column on `source_run`.** That row is written in the transaction that records a run; the turn beside it would mix what a run left with who runs now. Rejected for a table of its own.
- **Expiry by each process's Clock.** Containers whose clocks disagree would take each other's turns early or late. Rejected for the database's clock.
- **Keeping the turn in memory, as before.** Holds only within one process. Rejected.

## Consequences

- A container that dies in a run blocks its Source for up to a minute.
- What a run does before it records, such as declaring Source Attributes, is not undone when its turn is lost.

## Amendment: every write of a run checks its turn

The model of this protocol ([`specs/source-turn`](../../specs/source-turn), ADR-0012) found that a run's other writes, storing a plugin's changed secrets and recording a failed run, checked only the `lost` flag a renewal sets, which is as old as the last renewal. A run that stalled past its expiry could, after another container had taken the turn, refreshed the secrets and recorded, replace that container's newer secrets with its own, and so leave the Source with a token the plugin had already rotated.

Both writes now lock the turn's row, as recording does, and write nothing unless the run still holds it unexpired; the run is then reported as lost, and the secrets it stored for nothing are removed. Secrets stored while the turn was held stay even if the run loses its turn before it records: they were read afresh in the turn, and the plugin may have rotated the old ones. Declaring Source Attributes still happens during the plugin's call and is not checked.
