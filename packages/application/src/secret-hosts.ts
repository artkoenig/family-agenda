/**
 * The hosts of a Source's secret host fields, such as a calendar address with a token in it, kept
 * in the clear so that the plugin's egress proxy allows them without reading the secrets. Each is
 * taken as the Admin enters the value: a value left empty keeps the host it had.
 */
export function secretHostsOf(
  fields: readonly { key: string; secret: boolean; host?: boolean }[],
  entered: Record<string, string>,
  previous: Record<string, string>,
): Record<string, string> {
  const hosts: Record<string, string> = {};
  for (const { key } of fields.filter((field) => field.secret && field.host)) {
    const value = entered[key];
    const host = value === undefined || value.trim() === "" ? previous[key] : hostOf(value);
    if (host) hosts[key] = host;
  }
  return hosts;
}

/**
 * The host, with its port, of an address such as `webcal://user:token@example.org:443/cal.ics`:
 * no scheme, no user or password, nothing from the first `/`, `?` or `#`, lowercase. Empty for a
 * value without one.
 */
export function hostOf(value: string): string {
  const unschemed = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const end = unschemed.search(/[/?#]/);
  const authority = end === -1 ? unschemed : unschemed.slice(0, end);
  return authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
}
