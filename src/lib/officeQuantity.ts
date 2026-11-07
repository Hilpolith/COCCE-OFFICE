/** Exact six-decimal physical quantities. Never coerce operational values through Number. */
const SCALE = 1_000_000n;
const COLUMN_LIMIT = 10n ** 24n;

export function parseQuantity(value: string): bigint {
  if (typeof value !== "string" || value.length > 96)
    throw new Error("Enter a plain decimal quantity.");
  const plain = value.trim();
  if (!/^-?(?:0|[1-9]\d{0,59})(?:\.\d{1,6})?$/.test(plain)) {
    throw new Error(
      "Use a plain quantity with no more than six decimal places.",
    );
  }
  const negative = plain.startsWith("-");
  const [whole, fraction = ""] = (negative ? plain.slice(1) : plain).split(".");
  const exact = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"));
  return negative ? -exact : exact;
}

export function quantityToDecimal(value: bigint): string {
  if (typeof value !== "bigint")
    throw new Error("Expected an exact scaled quantity.");
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / SCALE}.${(absolute % SCALE).toString().padStart(6, "0")}`;
}

/** Normalize a stored numeric(24,6) input; aggregate display may be larger than a single row. */
export function normalizeQuantity(
  value: string,
  allowNegative = false,
): string {
  const exact = parseQuantity(value);
  if (!allowNegative && exact < 0n)
    throw new Error("Quantity cannot be negative.");
  if (exact >= COLUMN_LIMIT || exact <= -COLUMN_LIMIT)
    throw new Error("Quantity exceeds the supported item range.");
  return quantityToDecimal(exact);
}

export function sumQuantities(values: readonly string[]): string {
  return quantityToDecimal(
    values.reduce((total, value) => total + parseQuantity(value), 0n),
  );
}

export function subtractQuantities(left: string, right: string): string {
  return quantityToDecimal(parseQuantity(left) - parseQuantity(right));
}

export function hasSufficientQuantity(
  available: string,
  required: string,
): boolean {
  const requested = parseQuantity(required);
  if (requested < 0n) throw new Error("Required quantity cannot be negative.");
  return parseQuantity(available) >= requested;
}

export function formatQuantity(
  value: string,
  unit = "",
  locale = "en-TZ",
): string {
  const exact = parseQuantity(value);
  const absolute = exact < 0n ? -exact : exact;
  const whole = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(absolute / SCALE);
  const fraction = (absolute % SCALE)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  const separator =
    new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
  const localized = fraction
    ? new Intl.NumberFormat(locale, {
        minimumIntegerDigits: fraction.length,
        maximumFractionDigits: 0,
        useGrouping: false,
      }).format(BigInt(fraction))
    : "";
  return `${exact < 0n ? "-" : ""}${whole}${fraction ? separator + localized : ""}${unit ? ` ${unit}` : ""}`;
}
