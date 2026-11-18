---
status: accepted
---

# Concurrent protocols are model-checked with Quint

Several protocols of the core are run by many actors at once: api containers and workers on one database, renewals and expiries, crashes, retries, webhooks delivered again. Tests run one interleaving at a time and rarely hit the one where such a protocol breaks. We specify each of them in Quint and let its tools go through the interleavings, checking what must never happen (safety) and what must stay possible (liveness). The first, the Source turn (ADR-0008), found a write that checked no turn.

## Decision

- **Quint**, with its simulator and with Apalache. Its syntax is close to TypeScript, it installs from npm as a dev dependency, and it compiles to TLA+, so the specs can move to TLC or TLAPS if we need them.
- **One directory per protocol below `specs/`**, holding the spec and a `check.sh`. `pnpm specs` runs every `check.sh`; `pnpm specs <check>` runs one of its checks (scenarios, simulation, exhaustive, counterexample). It is not part of `pnpm check`, as Apalache needs Java 17+ and takes minutes, nor of CI: a spec's result changes only when the spec does, so whoever changes a spec runs its checks.
- **A spec models one protocol's design, not the app.** Its atomic actions are exactly the core's statements and transactions, named after the code they stand for, so that a reader can map each step to the code and back. Time is a counter the database's `now()` follows. Crashes, stalls and lost renewals are actions that may happen at any point.
- **Properties are invariants.** Safety is stated as invariants, with ghost variables where a property is about what a step did. Liveness is stated as what keeps it possible (a dead holder's turn expires, and the next asking takes it), plus a scenario that shows it happening. We do not check temporal formulas: the tools check them only in narrow cases, and a stalled container makes most guarantees about time false anyway.
- **Each spec is checked three ways:** its scenarios (`quint test`); random traces of a model at least as large as production uses, such as three containers and two Sources (`quint run`); and every trace of a smaller model to a depth that covers its known counterexamples (`quint verify`), where the actors' independence lets the model be smaller, such as one Source, since turns of different Sources never meet.
- **A counterexample becomes a test.** Before the code is fixed, the trace is reproduced by an integration test against the in-process Postgres. The spec keeps a module with the old behaviour, which its `check.sh` requires to fail, so that the spec cannot silently lose the counterexample. The fix, or the decision to accept the finding, is recorded in the ADR of the protocol, which links its spec.

## Considered Options

- **TLA+ with PlusCal and TLC.** The standard, with the largest body of examples, but a notation further from the code and a Java toolchain for every check. Quint keeps the way to it open.
- **Property-based tests of the real code** (random interleavings against PGlite). They test the code, not the design, but reach only the interleavings the test harness can force, and PGlite's single connection serialises what Postgres would interleave.
- **No model.** The interleavings stay untested.

## Consequences

- A spec does not prove the code follows it; the tests made from its counterexamples, and the mapping of actions to statements, are what tie the two together.
- The bounds of a check (actors, depth, clock) are a choice per spec, stated in its `check.sh`; a finding beyond them is not ruled out.
- Changing a protocol means changing its spec in the same change.
