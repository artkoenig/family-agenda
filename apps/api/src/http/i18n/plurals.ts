/**
 * Picks the form of a count by the language's plural rules, such as `one` for 1 in English, from
 * forms that each say the count themselves.
 */
export function plurals(locale: string) {
  const rules = new Intl.PluralRules(locale);
  return (count: number, forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }): string =>
    forms[rules.select(count)] ?? forms.other;
}
