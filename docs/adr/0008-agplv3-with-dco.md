---
status: proposed
---

# AGPLv3 for the Instance, contributions under the DCO

Family Butler moves from GPLv3 to AGPLv3. Under the GPL, anyone could run a modified Family Butler as a hosted service without sharing their changes, because offering a service is not distribution. That is the business Butler Cloud deliberately leaves out (ADR-0004), and the AGPL's network clause closes it for others too. The project is relicensed while it has a single copyright holder, before any external contributions exist.

Contributions are licensed inbound as outbound, under AGPLv3, and each commit carries a `Signed-off-by` line under the Developer Certificate of Origin. There is no CLA.

## Consequences

- Butler Cloud is a separate program that talks to the Instance over a network protocol, so it is not covered by the Instance's licence and may stay proprietary. The client side of that protocol lives in the Instance and is AGPLv3.
- Without a CLA, the project cannot be relicensed or dual-licensed later without every contributor's consent.
- Dependencies must be AGPL-compatible. whatsmeow (MPL-2.0) and the usual MIT, BSD and Apache-2.0 libraries are.

## Considered Options

- **Keep GPLv3**: leaves the hosted-service loophole open.
- **AGPLv3 with a CLA**: keeps relicensing and dual licensing possible, but deters contributors. That is too high a price while Butler Cloud needs neither.

_Since ADR-0011 the WhatsApp library is Baileys (MIT) instead of whatsmeow (MPL-2.0); both are AGPL-compatible._
