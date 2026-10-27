/**
 * Whether a host is on the home network: a loopback, private or link-local address, or a name
 * that only resolves there, such as a Compose service's.
 */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (name.includes(":")) return name === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(name) || /^fe[89ab][0-9a-f]?:/.test(name);
  if (!name.includes(".")) return name !== "";
  return ["localhost", "local", "lan", "internal", "home.arpa"].some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}
