---
status: accepted
---

# AGPLv3, contributions under the DCO

Family Agenda is licensed under AGPLv3. Under the GPL, anyone could run a modified Family Agenda as a hosted service without sharing their changes, because offering a service is not distribution; the AGPL's network clause closes that. Contributions are licensed inbound as outbound, and each commit carries a `Signed-off-by` line under the Developer Certificate of Origin. There is no CLA.

## Consequences

- Hosting Family Agenda as a service is allowed for anyone, the project's owner included, who shares the source of what they run. Without a CLA, the owner cannot relicense contributions, so proprietary additions cannot go into the core. A proprietary service must be a separate program that talks to Instances over a network protocol.
- The official plugins (ADR-0001) are AGPLv3 with the DCO too. A plugin talks to the core only over the REST contract and is a separate program, so third-party plugins choose their own licence.
