# A `.local` name for the Instance on Docker Desktop for Mac

Question: the Linux install gets a name like `family-agenda.local` from an `mdns` Compose service with `network_mode: host` that answers multicast DNS. That cannot work when the Instance runs in Docker Desktop on a Mac, because containers live in a Linux VM. How can a Mac user still give family devices on the home LAN a `.local` name, as with `homeassistant.local`?

Research date: 2026-10-30. Method: Apple man pages (`dns-sd`, `scutil`, `launchd.plist`, `launchctl`, `ipconfig`) read on macOS 26.6.2 (mDNSResponder 2881.160.4); the open-source `dns-sd.c` from the mDNSResponder repo; Docker, Apple and OrbStack docs fetched from their own hosts; RFC 6762. Behaviours marked *verified here* were also run on a Mac with Docker Desktop 4.74.0 (the Mac itself only, **no second LAN device was available**, so "reachable from LAN devices" is documented, not observed). Items marked *unverified* need checking before they go into user-facing docs.

## The options at a glance

| | A. Rename the Mac (`LocalHostName`) | B. Extra name via `dns-sd -P` | C. Compose `mdns` service (`network_mode: host`) | D. OrbStack `*.orb.local` |
|---|---|---|---|---|
| Name | `<LocalHostName>.local`, e.g. `family-agenda.local` if the Mac is renamed | any, e.g. `family-agenda.local` | any | `service.project.orb.local` or a `dev.orbstack.domains` label |
| Who answers mDNS | macOS `mDNSResponder` (already running) | macOS `mDNSResponder`, fed by a `dns-sd` process | a container | OrbStack (resolver on the Mac) |
| Works on Docker Desktop for Mac | yes | yes | **no**: "host" is the VM, not the Mac | n/a (different runtime) |
| Follows DHCP IP changes | yes (system-managed) | **no**: IP is fixed at start | n/a | n/a |
| Reachable from other LAN devices | yes, via published port | yes, via published port | n/a | **not documented**; third-party report says Mac only |
| Extra moving parts | none | a process kept alive at login | n/a | OrbStack instead of Docker Desktop |

## Findings

### 1. The Mac already announces `<LocalHostName>.local`

- `scutil` has three separate names: `ComputerName` ("the user-friendly name for the system"), `LocalHostName` ("the local (Bonjour) host name") and `HostName` (what `hostname(1)`/`gethostname(3)` return). Read with `scutil --get LocalHostName`, change with `sudo scutil --set LocalHostName <name>`; `--set` "requires super-user access" (`man scutil`).
- Apple's UI route: System Settings > General > Sharing > "Local hostname" > Edit. The local hostname is the computer name with `.local` added, spaces become hyphens, and it is not case sensitive. If another Mac on the network has the same name, "a number is added to the local network name" ([Apple Support: change computer name and local hostname](https://support.apple.com/guide/mac-help/change-computer-name-and-local-hostname-mchlp2322/mac)). RFC 6762 §9 describes the same conflict handling and suggests appending a digit such as "2" ([RFC 6762](https://www.rfc-editor.org/rfc/rfc6762)).
- *Verified here:* `scutil --get LocalHostName` returned the short name set on this Mac, and `dns-sd -G v4v6 <LocalHostName>.local` returned its current IPv4 and IPv6 addresses. Apple's pages do not spell out the exact allowed characters; the usual DNS-label rule (letters, digits, hyphens, at most 63 characters) is *unverified* from a primary source, so keep the name to lowercase letters, digits and hyphens.
- Consequence: the lowest-effort `family-agenda.local` is to set `LocalHostName` to `family-agenda` on a Mac that is a dedicated host. The old `<oldname>.local` stops working (other apps/SSH/file-sharing bookmarks that use it break).
- Published ports: Docker Desktop's backend (`com.docker.backend`) listens for published ports. "By default, `docker run -p` listens on all network interfaces (`0.0.0.0`)", and this default can be changed to localhost-only in Docker Desktop's network settings ([Docker Desktop networking](https://docs.docker.com/desktop/features/networking/)). So `ports: "8080:3000"` makes the Instance reachable at `http://<LocalHostName>.local:8080` from other devices, provided that setting was not switched to localhost-only. *Verified here:* `docker ps` shows `0.0.0.0:8080->3000/tcp`, the listener is `*:8080` owned by `com.docker.backend`, and `curl http://192.168.2.34:8080/` (the Mac's LAN IP) and `curl http://<LocalHostName>.local:8080/` both answered from the Mac itself.
- Port number stays in the URL: DNS (mDNS) maps names to addresses only. Browsers do not read the SRV record of a Bonjour service, so `:8080` must be typed or bookmarked. (Publishing on host port 80 would avoid it; whether Docker Desktop for Mac can bind port 80 without extra privileges was not checked, *unverified*.)

#### macOS firewall and Local Network prompts

- Inbound TCP to published ports passes through `com.docker.backend`: "Host firewalls can permit or deny inbound connections by filtering on `com.docker.backend`" ([Docker Desktop networking](https://docs.docker.com/desktop/features/networking/), [networking how-tos](https://docs.docker.com/desktop/features/networking/networking-how-tos/)). Apple's application firewall automatically allows built-in and validly signed software ([Apple Support: firewall settings](https://support.apple.com/guide/mac-help/change-firewall-settings-on-mac-mh11783/mac)). *Verified here:* the application firewall was enabled (`socketfilterfw --getglobalstate`: State = 1) and the published port still answered locally. Whether macOS shows an "accept incoming connections" prompt for Docker on first use, and what happens if someone clicks Deny, is *unverified* from Docker's docs (they do not mention it).
- macOS 15+ Local Network privacy ([TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)): "Listening for and accepting incoming TCP connections" does **not** require local network access, so LAN devices connecting to the published port are not gated by it. Operations that do require it include Bonjour registration, resolving a `.local` name, and sending or receiving UDP multicast.
- Same note, macOS section: local network access is automatically allowed for "any daemon started by `launchd`", "any program running as root" and "command-line tools run from Terminal or over SSH". The `launchd` exception "doesn't apply to `launchd` agents"; an agent that is not an app may be blocked until the user grants Local Network, unless `AssociatedBundleIdentifiers` ties it to a responsible app. This matters for option B (see 2).
- A sleeping Mac is not reachable: Docker Desktop and `mDNSResponder` stop answering. Apple's "wake for network access" with a Bonjour Sleep Proxy only helps for Macs that register services with a proxy device (Apple TV, base station); the only primary page found was an archived copy ([Apple HT201960, archived](https://nrs.preservation.mirrorweb.com/public/20170610164455mp_/https://support.apple.com/el-gr/HT201960)). Treat "keep the Mac awake" as a requirement for an always-available Instance. *Unverified* for current macOS.

### 2. An extra name with `dns-sd -P` (proxy registration)

What the primary sources say:

- `man dns-sd` synopsis and text: `dns-sd -P name type domain port host IP [key=value ...]` "create a proxy advertisement for a service running on (offered by) some other machine. The two new options are Host, a name for the device and IP, the address of it." The man page's own example is `dns-sd -P apple _http._tcp "" 80 apple.local 17.149.160.49`, and says "The same IP address can be reached by entering apple.local in the web browser."
- Argument mapping, from [`Clients/dns-sd.c`](https://github.com/apple-oss-distributions/mDNSResponder/blob/main/Clients/dns-sd.c) (repo `main` branch; usage string `-P <Name> <Type> <Domain> <Port> <Host> <IP> [<TXT>...]`): `argv[0]` Name, `argv[1]` Type, `argv[2]` Domain, `argv[3]` Port, `argv[4]` Host, `argv[5]` IP, the rest TXT strings.
- It does create an address record for the host: `-P` first calls `RegisterProxyAddressRecord(host, ip)`, which uses `DNSServiceRegisterRecord` to register an **A** record (or **AAAA** for an IPv6 argument) named `<host>` with `kDNSServiceFlagsUnique` and a hard-coded TTL of 240 s. It then registers the service (PTR/SRV/TXT) with `DNSServiceRegister`, passing `<host>` as the SRV target.
- *Verified here* (macOS 26.6.2): `dns-sd -t 12 -P "FA research test" _http._tcp local 8080 fa-research-test.local 192.168.2.34` printed "Name now registered and active" for both the record and the service. While it ran, `dns-sd -G v4 fa-research-test.local` returned `192.168.2.34` (TTL 240) and `ping fa-research-test.local` resolved to it. The name disappeared when the process exited. (This only proves the Mac resolves its own proxy name, not other devices.)
- Name form: the host argument must carry the full name, `family-agenda.local`. The "name" argument is the human-readable service instance name (any text up to 63 bytes, `man dns-sd`) and can differ, e.g. `"Family Agenda"`. Domain: "In current implementations, only the local multicast domain `local` is supported" (`man dns-sd`).
- Lifetime = process lifetime. There is no signal handler in `dns-sd.c`, so Ctrl-C/SIGTERM terminates it; without `-t <seconds>` the event loop blocks indefinitely. The man page calls the tool "primarily intended for interactive use" and warns that scripting around its output is "fragile"; we only run it, we do not parse it.
- The IP is fixed at start-up (a literal argument). It is the Mac's LAN address, since the published port lives on the Mac.

Running it at login with launchd (`man launchd.plist`, `man launchctl`):

- A per-user job goes in `~/Library/LaunchAgents/<label>.plist`; load with `launchctl bootstrap gui/$(id -u) <plist>`, unload with `launchctl bootout gui/$(id -u)/<label>`. Relevant keys: `ProgramArguments`, `RunAtLoad`, `KeepAlive` (restart when the process exits), `ThrottleInterval` (jobs are not spawned more than once per 10 s by default).
- Because the address is a literal argument, wrap the command so the IP is looked up at each start. `ipconfig getifaddr <interface>` prints the interface's IPv4 address, and is empty if the interface has no address (`man ipconfig`). The interface name must not be hard-coded as `en0` ([TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy) warns against that); `route -n get default` reports the default route's `interface:`. (Both commands *verified here*.)

Sketch (untested as a launchd job, the wrapper logic is untested end to end):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.family-agenda.mdns</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>IF=$(/sbin/route -n get default | /usr/bin/awk '/interface:/{print $2}'); IP=$(/usr/sbin/ipconfig getifaddr "$IF"); [ -n "$IP" ] || exit 1; exec /usr/bin/dns-sd -P "Family Agenda" _http._tcp local 8080 family-agenda.local "$IP"</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
```

Caveats to flag:

- *Unverified:* whether `dns-sd -P` started from a **LaunchAgent** is allowed to register Bonjour records under Local Network privacy. TN3179 lists "Registering a service with Bonjour" as requiring local network access and says `launchd` agents are not auto-allowed, while `launchd` daemons and root programs are. A system-wide LaunchDaemon in `/Library/LaunchDaemons/` (root-owned plist, loaded with `sudo launchctl bootstrap system <plist>`) falls under the auto-allowed rule and also starts at boot rather than at login. Test the agent first; if the record never appears, use the daemon.
- Name conflicts: the A record is registered "unique", so if another device already owns `family-agenda.local`, registration fails or renames (RFC 6762 §9). Do not combine option A and B with the same name.
- The Mac itself resolves the name too (*verified here*), so the Admin can test from the Mac, but the real test is one phone/laptop on the same Wi-Fi.

### 3. Why the Compose `mdns` service cannot be used on Docker Desktop for Mac

- Containers run in a Linux VM. "You won't find a `docker0` interface on the host" (it lives in the VM), the Docker bridge network "isn't reachable from the host", and only published ports (through `com.docker.backend`) cross the boundary ([networking how-tos](https://docs.docker.com/desktop/features/networking/networking-how-tos/), [networking](https://docs.docker.com/desktop/features/networking/)).
- Host networking exists in Docker Desktop only from 4.34 and must be enabled (Settings > Resources > Network > "Enable host networking"). It works "in both directions" for TCP and UDP between container and host services, but "containers can't bind to the host's IP addresses" because "the container has no direct access to the interfaces of the host"; it is layer 4 only, Linux containers only, and incompatible with Enhanced Container Isolation ([Docker: host network driver](https://docs.docker.com/engine/network/drivers/host/)). The page does not say it reaches the LAN.
- *Verified here* (Docker Desktop 4.74.0): `docker run --rm --network host alpine ip -4 addr` listed `eth0 192.168.65.3`, `docker0 172.17.0.1` and other VM bridges and the hostname `docker-desktop`; the Mac's LAN address `192.168.2.34` was absent. So a container in "host" mode sits on the VM's network, not on the Mac's Wi-Fi/Ethernet, and mDNS multicast sent from there never reaches the LAN.

### 4. OrbStack

- Names: "Each container in OrbStack has a domain name, `container-name.orb.local`." Compose services are `service.project.orb.local`; custom `.local` names are set with the `dev.orbstack.domains` label ("Only domains under the `.local` TLD are supported at this time"). Container domains "currently depend on the direct IP access feature" (Settings > Network > "Allow access to container domains & IPs") ([OrbStack: container domains](https://docs.orbstack.dev/docker/domains)).
- LAN reachability of the **names**: the official docs do not say. They describe the names as OrbStack-local. A community post says the `.orb.local` resolver is configured only on the Mac itself and other devices need a hosts-file entry ([Supabase discussion #34686](https://github.com/orgs/supabase/discussions/34686), third-party, ~19 months old) *unverified*.
- LAN reachability of **published ports**: "By default, forwarded ports are also reachable from other devices on your network"; this is switched off with "Expose ports to LAN" (`docker.expose_ports_to_lan`) ([OrbStack: container networking](https://docs.orbstack.dev/docker/network)). So with OrbStack, option A or B still gives family devices a name; `orb.local` is a Mac-only convenience.
- Host networking: OrbStack supports `--net=host`, and its docs describe "host" as the Mac (servers in such a container are reachable on the Mac's `localhost`) ([OrbStack: host networking](https://docs.orbstack.dev/docker/host-networking)). The docs say nothing about multicast or mDNS, so whether the Compose `mdns` service would announce on the real LAN under OrbStack is *unverified* and not worth relying on, given that `dns-sd` is simpler.

### 5. DHCP / IP changes and option B

- A `dns-sd -P` record carries the IP literal given at start-up (`dns-sd.c`); nothing updates it when the Mac's address changes (router reboot, lease expiry, switching Wi-Fi/Ethernet). Clients then resolve to a stale address for up to the record TTL (240 s, `dns-sd.c`) or until the process is restarted. Inferred from the source, not observed.
- Remedies, in order of preference:
  1. Option A (system-managed `LocalHostName`): no IP is ever typed, `mDNSResponder` publishes the interface addresses itself (*verified here* that the Mac's own name resolves to its current addresses; that it re-announces after a change is *unverified*).
  2. Give the Mac a **DHCP reservation** (fixed lease) in the router, so the literal IP stays correct. Router-specific and not in a primary source here; it is general network practice.
  3. Make the launchd job restart on change: the wrapper above re-reads the IP at each start, and `KeepAlive` restarts after exit. A watcher that exits when `ipconfig getifaddr "$IF"` differs from the registered IP would trigger the restart (own code; the `launchd.plist` man page discourages `WatchPaths` as "highly race-prone", so a polling loop is the safer trigger). Untested.
- IPv6: the proxy accepts either family, but the example registers only IPv4. Devices that prefer IPv6 simply fall back to the A record. *Unverified* on mixed networks.

## Implications for Family Agenda

**Recommendation for a Mac user: use `LocalHostName` (option A) when the Mac is a dedicated host; add `dns-sd -P` (option B) only when the Mac's own name must stay.**

1. **Simplest setup (A):** `sudo scutil --set LocalHostName family-agenda` (or System Settings > General > Sharing > Local hostname). The Instance is then at `http://family-agenda.local:8080`, using the existing `ports: "8080:3000"`. No new process, no IP handling, survives DHCP changes. Check from the Mac with `dns-sd -G v4 family-agenda.local`, then from a phone on the same Wi-Fi.
2. **When the Mac keeps its name (B):** run `dns-sd -P "Family Agenda" _http._tcp local 8080 family-agenda.local <Mac LAN IP>` kept alive by launchd with the wrapper above, and reserve the Mac's IP in the router. Prefer a LaunchDaemon if the LaunchAgent is blocked by Local Network privacy.
3. **Do not ship the Compose `mdns` service for Mac.** Docker Desktop's "host" is the VM, so it cannot answer on the LAN. The Compose file/README should say the `mdns` service is Linux-only and point Mac users to this note.
4. **OrbStack users:** `orb.local` names are a local-Mac convenience; use A or B for family devices.

## Verified vs. unverified

Verified (primary source read and/or run on macOS 26.6.2 with Docker Desktop 4.74.0):
- `scutil` preference names and `--get/--set` (man page); `--set` needs root.
- `dns-sd -P` argument order, A-record registration with TTL 240 and `unique` flag (source), working registration and Mac-local resolution of the proxy name, lifetime tied to the process.
- Docker Desktop publishes on `0.0.0.0` by default; published port answered on `localhost`, the Mac's LAN IP and `<LocalHostName>.local` from the Mac itself.
- Docker Desktop "host" networking is the VM's network (docs plus the `ip addr` check).
- TN3179: incoming TCP needs no Local Network permission; Bonjour registration does; launchd daemons/root/Terminal tools are auto-allowed, launchd agents are not.
- OrbStack naming scheme, LAN exposure of forwarded ports (docs).

Unverified (check before documenting as fact):
- Access from a real second device on the LAN (no second device used).
- Whether `dns-sd -P` works from a LaunchAgent under Local Network privacy; the daemon alternative is derived from TN3179, not tested.
- Whether macOS shows an incoming-connection prompt for `com.docker.backend` and behaviour on Deny.
- Exact allowed characters/length of `LocalHostName`; whether `mDNSResponder` re-announces promptly after an IP change.
- Whether `.orb.local` names resolve from other LAN devices (only a third-party report says no); mDNS under OrbStack host networking.
- Stale-record behaviour after an IP change under option B (inferred from source).
- Binding host port 80 on Docker Desktop for Mac without extra privileges; Mac sleep / wake-for-network-access behaviour on current macOS.
