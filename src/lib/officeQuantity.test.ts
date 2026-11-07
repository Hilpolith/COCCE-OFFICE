import { describe, expect, it } from "vitest";
import {
  formatQuantity,
  hasSufficientQuantity,
  normalizeQuantity,
  parseQuantity,
  quantityToDecimal,
  subtractQuantities,
  sumQuantities,
} from "./officeQuantity";

describe("exact Manufacturing quantities", () => {
  it("preserves six decimals and values larger than JavaScript safe integers", () => {
    expect(normalizeQuantity("9007199254740993.123456")).toBe(
      "9007199254740993.123456",
    );
    expect(parseQuantity("0.000001")).toBe(1n);
    expect(normalizeQuantity(" 2.4 ")).toBe("2.400000");
  });
  it("does not accumulate floating point error", () => {
    expect(sumQuantities(["0.1", "0.2"])).toBe("0.300000");
    expect(subtractQuantities("0.3", "0.2")).toBe("0.100000");
    expect(hasSufficientQuantity("0.300000", "0.3")).toBe(true);
    expect(hasSufficientQuantity("0.299999", "0.3")).toBe(false);
  });
  it("accepts maximum stored range but rejects overflow without rounding", () => {
    expect(normalizeQuantity("999999999999999999.999999")).toBe(
      "999999999999999999.999999",
    );
    expect(() => normalizeQuantity("1000000000000000000")).toThrow("range");
    expect(() => normalizeQuantity("0.0000001")).toThrow("six");
  });
  it("keeps signed computed deltas explicit and never uses negative operational inputs by default", () => {
    expect(subtractQuantities("0.000001", "0.000002")).toBe("-0.000001");
    expect(() => normalizeQuantity("-1")).toThrow("negative");
    expect(normalizeQuantity("-1.5", true)).toBe("-1.500000");
    expect(quantityToDecimal(0n)).toBe("0.000000");
    expect(() => hasSufficientQuantity("2", "-1")).toThrow("negative");
  });
  it.each([
    "1e3",
    "Infinity",
    "NaN",
    "+1",
    "01",
    "1,000",
    ".5",
    "2.",
    "1.1234567",
    "--1",
    "",
  ])("rejects noncanonical input %j", (value) => {
    expect(() => parseQuantity(value)).toThrow();
  });
  it("can sum and display aggregate totals larger than one stored row", () => {
    expect(sumQuantities(["999999999999999999.999999", "0.000001"])).toBe(
      "1000000000000000000.000000",
    );
    expect(formatQuantity("9007199254740993.123456", "kg", "en-US")).toBe(
      "9,007,199,254,740,993.123456 kg",
    );
    expect(formatQuantity("1234.000001", "kg", "de-DE")).toBe(
      "1.234,000001 kg",
    );
    expect(formatQuantity("-0.000001", "", "en-US")).toBe("-0.000001");
  });
});
