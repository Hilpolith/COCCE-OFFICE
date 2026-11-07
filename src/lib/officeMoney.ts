/** Exact two-decimal monetary arithmetic. Server amounts must arrive as decimal strings. */
export function parseMinorUnits(value: string): bigint {
  if (typeof value !== 'string' || value.length > 260) throw new Error('Enter a plain decimal amount.');
  const plain = value.trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(plain)) throw new Error('Use a plain amount with no more than two decimal places.');
  const negative = plain.startsWith('-');
  const [whole, fraction = ''] = (negative ? plain.slice(1) : plain).split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -amount : amount;
}

export function minorUnitsToDecimal(value: bigint): string {
  if (typeof value !== 'bigint') throw new Error('Expected an exact minor-unit amount.');
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

export function normalizeMoney(value: string, allowNegative = false): string {
  const minor = parseMinorUnits(value);
  if (!allowNegative && minor < 0n) throw new Error('Amount cannot be negative.');
  return minorUnitsToDecimal(minor);
}

export function sumMoney(values: readonly string[]): string {
  return minorUnitsToDecimal(values.reduce((total, value) => total + parseMinorUnits(value), 0n));
}

export function formatMoney(value: string, currency = 'TZS', locale = 'en-TZ'): string {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Use a three-letter currency code.');
  const amount = parseMinorUnits(value);
  const absolute = amount < 0n ? -amount : amount;
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: true }).format(absolute / 100n);
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? '.';
  const fraction = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, maximumFractionDigits: 0, useGrouping: false }).format(absolute % 100n);
  return `${currency} ${amount < 0n ? '-' : ''}${whole}${decimal}${fraction}`;
}

export interface ExactJournalLine { debit: string; credit: string }
export function journalBalance(lines: readonly ExactJournalLine[]): { debit: string; credit: string; difference: string; balanced: boolean } {
  let debit = 0n; let credit = 0n;
  for (const line of lines) {
    const d = parseMinorUnits(line.debit); const c = parseMinorUnits(line.credit);
    if (d < 0n || c < 0n || (d > 0n && c > 0n) || (d === 0n && c === 0n)) throw new Error('Each journal line needs either a positive debit or a positive credit.');
    debit += d; credit += c;
  }
  return { debit: minorUnitsToDecimal(debit), credit: minorUnitsToDecimal(credit), difference: minorUnitsToDecimal(debit - credit), balanced: lines.length >= 2 && debit > 0n && debit === credit };
}
