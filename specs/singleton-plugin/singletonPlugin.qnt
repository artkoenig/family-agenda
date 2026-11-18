// A singleton plugin runs as exactly one replica per Instance, including while it is redeployed
// (ADR-0001, ADR-0002).
//
// The Matrix plugin and its bridges hold Messenger sessions: a Messenger links each session as one
// device, and two processes using it at once make the Messenger end it, or both lose messages.
// Nothing in the core or the plugin locks the sessions; what keeps them to one process is how the
// deployment runs the service. This spec models that: a Compose service of the generated
// `compose.plugins.yaml`, its containers, their processes, a redeploy with a new image, crashes
// with `restart: unless-stopped`, and the stop's grace period after which the container is killed.
//
// Actions and what they stand for (Docker Compose, `docker compose up -d` after the image changed):
//   redeploy       `up` deciding to recreate the service's container
//   stop           SIGTERM to the old container; its process goes on until it exits
//   exit, kill     the process ending on its own, or SIGKILL once the grace period is over
//   create         the new container created and started from the new image
//   open           a started process opening the Messenger sessions from its volume
//   crash          a process dying; `restart: unless-stopped` starts the same container again
//   restart        that restart
//   tick           time, for the grace period
//
// Not covered: an operator starting a second copy by hand (`docker compose up --scale`, a second
// project), a host whose Docker daemon loses track of a container, and the Messenger's own handling
// of a device used twice. Companions (the bridges) follow the same service rules as the plugin.
module singletonPlugin {
  // ---- Parameters -----------------------------------------------------------------------------

  /** How many containers one execution may create, one per redeploy: the first runs at the start. */
  const CONTAINERS: int
  /** How long a stopped container's process may go on before it is killed (stop_grace_period). */
  const GRACE: int
  /**
   * Whether a redeploy stops the old container, and waits for it to exit, before it starts the
   * new one: Compose's recreate. False starts the new one first, as a rolling update does
   * (Swarm's `order: start-first`, a Kubernetes Deployment's RollingUpdate): the counterexample.
   */
  const STOP_FIRST: bool
  const MAX_TIME: int
  const MAX_CRASHES: int

  // ---- State ----------------------------------------------------------------------------------

  /**
   * A container: Absent (not yet created), Running (its process up), Stopping (SIGTERM sent, the
   * process still up), Exited (no process; a crashed one restarts), Removed.
   */
  type Status = Absent | Running | Stopping | Exited | Removed

  type Container = {
    status: Status,
    /** Whether its process holds the Messenger sessions: opened them, and has not exited. */
    holds: bool,
    /** When it was asked to stop, for the grace period. */
    stoppedAt: int,
    /** Whether it exited by a crash, and so restarts. */
    crashed: bool,
  }

  /** A redeploy under way: the container it replaces and the one it creates. */
  type Redeploy = { active: bool, old: int, new: int }

  type Did = DidInit | DidTick | DidRedeploy | DidStop | DidExit | DidKill | DidCreate | DidOpen | DidCrash | DidRestart

  var now: int
  var containers: int -> Container
  var redeploy: Redeploy
  var crashes: int
  var lastAction: Did

  // ---- Functional logic -----------------------------------------------------------------------

  /** Whether a container has a process: running, or stopping and not yet exited. */
  pure def hasProcess(c: Container): bool = c.status == Running or c.status == Stopping

  /** A container whose process ended: it holds nothing. */
  pure def ended(c: Container, byCrash: bool): Container = { ...c, status: Exited, holds: false, crashed: byCrash }

  // ---- Helpers --------------------------------------------------------------------------------

  val slots: Set[int] = 0.to(CONTAINERS - 1)
  val absent: Container = { status: Absent, holds: false, stoppedAt: 0, crashed: false }

  /** The container that runs the service: the last one created and not yet replaced. */
  val current: int = slots.filter(i => containers.get(i).status != Absent).fold(0, (a, i) => if (i > a) i else a)

  action setContainer(i: int, c: Container): bool = containers' = containers.set(i, c)

  action keep: bool = all { redeploy' = redeploy, crashes' = crashes }

  // ---- Actions --------------------------------------------------------------------------------

  action init = all {
    now' = 0,
    containers' = slots.mapBy(i => if (i == 0) { ...absent, status: Running } else absent),
    redeploy' = { active: false, old: 0, new: 0 },
    crashes' = 0,
    lastAction' = DidInit,
  }

  action tick = all {
    now < MAX_TIME, now' = now + 1, containers' = containers, keep, lastAction' = DidTick,
  }

  /** `up` with a new image: the current container is to be replaced by the next one. */
  action startRedeploy = all {
    not(redeploy.active), current + 1 < CONTAINERS,
    redeploy' = { active: true, old: current, new: current + 1 },
    now' = now, containers' = containers, crashes' = crashes, lastAction' = DidRedeploy,
  }

  action stop = {
    val c = containers.get(redeploy.old)
    all {
      redeploy.active, c.status == Running or c.status == Exited,
      // With start-first, the new container must already run.
      STOP_FIRST or containers.get(redeploy.new).status == Running,
      setContainer(redeploy.old, if (c.status == Running) { ...c, status: Stopping, stoppedAt: now } else { ...c, status: Removed }),
      now' = now, keep, lastAction' = DidStop,
    }
  }

  /** The stopping process exits on SIGTERM, or is killed once its grace is over; Compose removes it. */
  action exitOrKill(kill: bool): bool = {
    val c = containers.get(redeploy.old)
    all {
      redeploy.active, c.status == Stopping,
      not(kill) or now - c.stoppedAt >= GRACE,
      setContainer(redeploy.old, { ...c, status: Removed, holds: false }),
      now' = now, keep, lastAction' = if (kill) DidKill else DidExit,
    }
  }

  /** The new container is created and started: after the old one is gone, or at once with start-first. */
  action create = all {
    redeploy.active, containers.get(redeploy.new).status == Absent,
    not(STOP_FIRST) or containers.get(redeploy.old).status == Removed,
    setContainer(redeploy.new, { ...absent, status: Running }),
    now' = now, keep, lastAction' = DidCreate,
  }

  /** The redeploy is done once the old container is removed and the new one created. */
  action finishRedeploy = all {
    redeploy.active, containers.get(redeploy.old).status == Removed, containers.get(redeploy.new).status != Absent,
    redeploy' = { ...redeploy, active: false },
    now' = now, containers' = containers, crashes' = crashes, lastAction' = DidRedeploy,
  }

  /** A process opens the Messenger sessions; even a stopping one may, until it exits. */
  action open(i: int): bool = {
    val c = containers.get(i)
    all {
      hasProcess(c), not(c.holds),
      setContainer(i, { ...c, holds: true }),
      now' = now, keep, lastAction' = DidOpen,
    }
  }

  action crash(i: int): bool = {
    val c = containers.get(i)
    all {
      crashes < MAX_CRASHES, hasProcess(c),
      setContainer(i, if (c.status == Stopping) { ...c, status: Removed, holds: false } else c.ended(true)),
      now' = now, redeploy' = redeploy, crashes' = crashes + 1, lastAction' = DidCrash,
    }
  }

  /** `restart: unless-stopped` starts a crashed container again, unless it was stopped meanwhile. */
  action restart(i: int): bool = {
    val c = containers.get(i)
    all {
      c.status == Exited, c.crashed,
      setContainer(i, { ...c, status: Running, crashed: false }),
      now' = now, keep, lastAction' = DidRestart,
    }
  }

  action step = any {
    tick, startRedeploy, stop, exitOrKill(false), exitOrKill(true), create, finishRedeploy,
    nondet i = slots.oneOf()
    any { open(i), crash(i), restart(i) },
  }

  // ---- Properties -----------------------------------------------------------------------------

  /** At most one process holds the Messenger sessions at any time. */
  val oneHolder: bool = slots.filter(i => containers.get(i).holds).size() <= 1

  /** At most one container of the service has a process at any time: what makes oneHolder hold. */
  val oneProcess: bool = slots.filter(i => hasProcess(containers.get(i))).size() <= 1

  val safety: bool = oneHolder and oneProcess

  // ---- Witnesses ------------------------------------------------------------------------------

  val redeployed: bool = not(redeploy.active) and current > 0 and containers.get(current).holds
  val killed: bool = lastAction == DidKill
  val restarted: bool = lastAction == DidRestart
  val stoppingHolds: bool = slots.exists(i => containers.get(i).status == Stopping and containers.get(i).holds)
}
