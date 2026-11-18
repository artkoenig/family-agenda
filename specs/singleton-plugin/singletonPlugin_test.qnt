// Scenarios of the singleton plugin's redeploy and the instances of its model that `check.sh`
// checks (singletonPlugin.qnt).
module scenarios {
  import singletonPlugin.* from "./singletonPlugin"
  export singletonPlugin.*

  /**
   * A redeploy: Compose stops the old container, whose process exits and lets go of the sessions,
   * then starts the new one, which opens them. With start-first the new process opens them while
   * the old one still holds them: the counterexample.
   */
  run redeployKeepsOneHolder =
    init.then(open(0)).then(startRedeploy)
      .then(if (STOP_FIRST) stop.then(exitOrKill(false)).then(create) else create.then(stop))
      .then(open(1))
      .expect(if (STOP_FIRST) safety else not(oneHolder))

  /** An old process that ignores SIGTERM is killed after its grace; only then does the new one start. */
  run stuckProcessIsKilledFirst =
    init.then(open(0)).then(startRedeploy).then(stop)
      .then(GRACE.reps(_ => tick)).then(exitOrKill(true)).then(create).then(open(1)).then(finishRedeploy)
      .expect(redeployed and safety)

  /** A crashed process restarts in the same container and opens the sessions again. */
  run crashRestartsTheSameContainer =
    init.then(open(0)).then(crash(0)).then(restart(0)).then(open(0))
      .expect(containers.get(0).holds and safety)
}

/** Compose's recreate: stop first. */
module checked {
  import scenarios(CONTAINERS = 3, GRACE = 2, STOP_FIRST = true, MAX_TIME = 6, MAX_CRASHES = 2).*
  run redeployKeepsOneHolderTest = redeployKeepsOneHolder
  run stuckProcessIsKilledFirstTest = stuckProcessIsKilledFirst
  run crashRestartsTheSameContainerTest = crashRestartsTheSameContainer
}

/** A rolling update: start first. */
module startFirst {
  import scenarios(CONTAINERS = 3, GRACE = 2, STOP_FIRST = false, MAX_TIME = 6, MAX_CRASHES = 2).*
  run redeployKeepsOneHolderTest = redeployKeepsOneHolder
}

module exhaustive {
  import scenarios(CONTAINERS = 2, GRACE = 1, STOP_FIRST = true, MAX_TIME = 2, MAX_CRASHES = 1).*
}

module exhaustiveStartFirst {
  import scenarios(CONTAINERS = 2, GRACE = 1, STOP_FIRST = false, MAX_TIME = 2, MAX_CRASHES = 1).*
}
