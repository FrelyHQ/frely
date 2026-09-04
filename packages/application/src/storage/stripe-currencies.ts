import { RelayError } from "@frely/core";

export const STRIPE_PRESENTMENT_CURRENCIES = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BIF", "BMD", "BND", "BOB", "BRL", "BSD",
  "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC",
  "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ETB", "EUR", "FJD",
  "FKP", "GBP", "GEL", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL",
  "HTG", "HUF", "IDR", "ILS", "INR", "ISK", "JMD", "JPY", "KES", "KGS",
  "KHR", "KMF", "KRW", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
  "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MUR", "MVR", "MWK",
  "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "PAB",
  "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB",
  "RWF", "SAR", "SBD", "SCR", "SEK", "SGD", "SHP", "SLE", "SOS",
  "SRD", "STD", "SZL", "THB", "TJS", "TOP", "TRY", "TTD", "TWD",
  "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VND", "VUV", "WST", "XAF",
  "XCD", "XCG", "XOF", "XPF", "YER", "ZAR", "ZMW"
]);

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
  "VND", "VUV", "XAF", "XOF", "XPF"
]);

const SPECIAL_ZERO_DECIMAL_CURRENCIES = new Set(["ISK", "UGX"]);
const UNITS_PER_MAJOR = 1_000_000;
const UNITS_PER_CENT = 10_000;

export function normalizeStripeCurrency(value: unknown): string {
  const currency = String(value ?? "").trim().toUpperCase();
  if (!STRIPE_PRESENTMENT_CURRENCIES.has(currency)) {
    throw new RelayError("stripe_currency_not_supported", "Currency is not supported by Stripe Checkout", 400);
  }
  return currency;
}

export function stripeMinorAmountFromUnits(value: unknown, currencyValue: unknown): number {
  const currency = normalizeStripeCurrency(currencyValue);
  const units = Number(value);
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new RelayError("invalid_payment_units", "Stripe amount must be a positive safe integer", 400);
  }
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    if (units % UNITS_PER_MAJOR !== 0) {
      throw new RelayError("invalid_payment_units", `Stripe ${currency} amount must use whole major units`, 400);
    }
    return units / UNITS_PER_MAJOR;
  }
  if (units % UNITS_PER_CENT !== 0) {
    throw new RelayError("invalid_payment_units", `Stripe ${currency} amount must align to minor units`, 400);
  }
  const minor = units / UNITS_PER_CENT;
  if (SPECIAL_ZERO_DECIMAL_CURRENCIES.has(currency) && minor % 100 !== 0) {
    throw new RelayError("invalid_payment_units", `Stripe ${currency} amount must use whole major units`, 400);
  }
  return minor;
}

export function stripeUnitsFromMinorAmount(value: unknown, currencyValue: unknown): number {
  const currency = normalizeStripeCurrency(currencyValue);
  const minor = Number(value);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new RelayError("invalid_stripe_minor_amount", "Stripe minor amount must be a positive safe integer", 400);
  }
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    const units = minor * UNITS_PER_MAJOR;
    if (!Number.isSafeInteger(units)) {
      throw new RelayError("invalid_stripe_minor_amount", "Stripe amount is outside supported precision", 400);
    }
    return units;
  }
  if (SPECIAL_ZERO_DECIMAL_CURRENCIES.has(currency) && minor % 100 !== 0) {
    throw new RelayError("invalid_stripe_minor_amount", `Stripe ${currency} amount must use whole major units`, 400);
  }
  const units = minor * UNITS_PER_CENT;
  if (!Number.isSafeInteger(units)) {
    throw new RelayError("invalid_stripe_minor_amount", "Stripe amount is outside supported precision", 400);
  }
  return units;
}
