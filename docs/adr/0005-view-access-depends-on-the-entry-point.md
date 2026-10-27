---
status: proposed
---

# View access depends on how the request reached the Instance

ADR-0003 makes the home network the access control for Views. Remote Access (ADR-0004) breaks that assumption, because it lets requests from the internet reach the Instance. The tunnel client runs inside the Instance, so a remote request looks like it came from localhost. Its source IP and its headers therefore cannot tell local from remote. So the Instance serves two listeners. The local listener is bound to the home network. The remote listener is reachable only through the tunnel and is never published on the LAN. Each listener comes with its own access policy, behind a `ViewAccessPolicy` port:

- **Local listener**: Views open without a secret, exactly as in ADR-0003.
- **Remote listener**: a View opens only through its View Link, a secret, revocable URL. An Admin creates a View Link per View and can rotate it, which invalidates the old one. Without a valid View Link the remote listener serves only the Admin sign-in.

Admins always sign in, on both listeners. On the remote listener, password sign-in is rate-limited per account and per client.

## Consequences

- The policy is chosen by which listener accepted the connection. It is never decided from the `Host` header, `X-Forwarded-For` or the client IP.
- An operator who exposes the Instance without Agenda Cloud, through their own reverse proxy, points it at the remote listener and gets the same protection.
- Ticking a Task done through a View Link is allowed, as it is locally ([artkoenig/family-buttler#13](https://github.com/artkoenig/family-buttler/issues/13)).
- The ICS feed follows the same rule. Over Remote Access it needs its own secret URL, and then external calendars such as Google Calendar can subscribe to it.
- With Remote Access the Instance has a secure context, so a PWA with Web Push becomes possible for Agenda Cloud subscribers. ADR-0003's reasons for having no PWA still hold for a LAN-only Instance.

## Considered Options

- **Trust the client IP or a header set by the tunnel**: simpler, but any bug or misconfiguration in the forwarding chain turns every View public.
- **Require Admin sign-in for every remote request**: safe, but it turns family wall tablets and children's phones into accounts, which ADR-0003 rejected.
