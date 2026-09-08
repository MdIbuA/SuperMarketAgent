import { Decimal } from 'decimal.js';

// Configure Decimal.js for financial calculations
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/**
 * Convert paise (integer) to rupees string for display.
 * Example: 1250 → "12.50"
 */
export function paiseToRupees(paise: number): string {
  return new Decimal(paise).dividedBy(100).toFixed(2);
}

/**
 * Convert rupees (number) to paise (integer).
 * Example: 12.50 → 1250
 */
export function rupeesToPaise(rupees: number | string): number {
  return new Decimal(rupees).times(100).round().toNumber();
}

/**
 * Format paise as ₹ display string.
 * Example: 1250 → "₹12.50"
 */
export function formatPaise(paise: number): string {
  return `₹${paiseToRupees(paise)}`;
}

/**
 * Calculate GST components from a taxable value in paise.
 * Returns CGST and SGST (each is half of total GST) — intra-state.
 */
export function calculateGST(taxableValuePaise: number, gstRatePercent: Decimal | number): {
  cgst: number;
  sgst: number;
  totalTax: number;
} {
  const rate = new Decimal(gstRatePercent);
  const taxableValue = new Decimal(taxableValuePaise);
  
  const totalTax = taxableValue.times(rate).dividedBy(100);
  const halfTax = totalTax.dividedBy(2);
  
  // Round each component individually
  const cgst = halfTax.round().toNumber();
  const sgst = halfTax.round().toNumber();
  
  return {
    cgst,
    sgst,
    totalTax: cgst + sgst,
  };
}

/**
 * Calculate line total: taxableValue + CGST + SGST
 */
export function calculateLineTotal(
  quantity: Decimal | number,
  unitPricePaise: number,
  gstRatePercent: Decimal | number
): {
  taxableValue: number;
  cgst: number;
  sgst: number;
  lineTotal: number;
} {
  const qty = new Decimal(quantity);
  const price = new Decimal(unitPricePaise);
  
  const taxableValue = qty.times(price).round().toNumber();
  const gst = calculateGST(taxableValue, gstRatePercent);
  
  return {
    taxableValue,
    cgst: gst.cgst,
    sgst: gst.sgst,
    lineTotal: taxableValue + gst.totalTax,
  };
}

/**
 * Safe decimal comparison
 */
export function decimalGte(a: Decimal | number | string, b: Decimal | number | string): boolean {
  return new Decimal(a).gte(new Decimal(b));
}

export function decimalLt(a: Decimal | number | string, b: Decimal | number | string): boolean {
  return new Decimal(a).lt(new Decimal(b));
}
