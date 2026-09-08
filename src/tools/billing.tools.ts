import * as billingService from '../domain/billing.service';
import { DomainError, toolSuccess, toolFailure, type ToolResult } from '../utils/errors';
import { paiseToRupees } from '../utils/money';
import { Decimal } from 'decimal.js';
import type { PaymentMethod } from '@prisma/client';

// ─── Tool Schemas ───────────────────────────────────────────────────

export const createBillSchema = {
  name: 'create_bill',
  description: 'Create a new draft bill. Cancels any existing draft. Call this when the user wants to start a new bill.',
  input_schema: {
    type: 'object' as const,
    properties: {
      telegramUserId: { type: 'string', description: 'Telegram user ID of the owner' },
    },
    required: ['telegramUserId'],
  },
};

export const getCurrentBillSchema = {
  name: 'get_current_bill',
  description: 'Get the current active draft bill for the user, including all items and totals.',
  input_schema: {
    type: 'object' as const,
    properties: {
      telegramUserId: { type: 'string', description: 'Telegram user ID' },
    },
    required: ['telegramUserId'],
  },
};

export const addBillItemSchema = {
  name: 'add_bill_item',
  description: 'Add a product to the current bill or update quantity if product already exists. Use search_products first to find the product ID. Does NOT deduct stock yet — stock is deducted only on finalization.',
  input_schema: {
    type: 'object' as const,
    properties: {
      billId: { type: 'string', description: 'Bill ID' },
      productId: { type: 'string', description: 'Product ID (use search_products to find)' },
      quantity: { type: 'number', description: 'Quantity to add' },
    },
    required: ['billId', 'productId', 'quantity'],
  },
};

export const updateBillItemSchema = {
  name: 'update_bill_item',
  description: 'Update the quantity of an existing item in the bill.',
  input_schema: {
    type: 'object' as const,
    properties: {
      billId: { type: 'string', description: 'Bill ID' },
      billItemId: { type: 'string', description: 'Bill item ID to update' },
      newQuantity: { type: 'number', description: 'New quantity' },
    },
    required: ['billId', 'billItemId', 'newQuantity'],
  },
};

export const removeBillItemSchema = {
  name: 'remove_bill_item',
  description: 'Remove an item from the bill by bill item ID.',
  input_schema: {
    type: 'object' as const,
    properties: {
      billId: { type: 'string', description: 'Bill ID' },
      billItemId: { type: 'string', description: 'Bill item ID to remove' },
    },
    required: ['billId', 'billItemId'],
  },
};

export const removeBillItemByNameSchema = {
  name: 'remove_bill_item_by_name',
  description: 'Remove an item from the bill by searching for a product name (e.g., "drop the butter"). Useful for natural language requests.',
  input_schema: {
    type: 'object' as const,
    properties: {
      billId: { type: 'string', description: 'Bill ID' },
      productQuery: { type: 'string', description: 'Product name to search for and remove (e.g., "butter", "maggi")' },
    },
    required: ['billId', 'productQuery'],
  },
};

export const setPaymentMethodSchema = {
  name: 'set_payment_method',
  description: 'Set the payment method for a bill (CASH, UPI, CARD, or CREDIT for khata).',
  input_schema: {
    type: 'object' as const,
    properties: {
      billId: { type: 'string', description: 'Bill ID' },
      method: { type: 'string', enum: ['CASH', 'UPI', 'CARD', 'CREDIT'], description: 'Payment method' },
      reference: { type: 'string', description: 'Payment reference (UPI ref, card ref, etc.)' },
    },
    required: ['billId', 'method'],
  },
};

export const finalizeBillSchema = {
  name: 'finalize_bill',
  description: 'Finalize the bill — deducts stock, generates bill number, and makes it permanent. This is IRREVERSIBLE. Stock is deducted only at this point. Idempotent — re-finalizing returns the same result.',
  input_schema: {
    type: 'object' as const,
    properties: {
      billId: { type: 'string', description: 'Bill ID to finalize' },
    },
    required: ['billId'],
  },
};

export const cancelBillSchema = {
  name: 'cancel_bill',
  description: 'Cancel a draft bill. No stock changes occur.',
  input_schema: {
    type: 'object' as const,
    properties: {
      billId: { type: 'string', description: 'Bill ID to cancel' },
    },
    required: ['billId'],
  },
};

export const getBillSchema = {
  name: 'get_bill',
  description: 'Get full details of a bill by ID, including all items and totals.',
  input_schema: {
    type: 'object' as const,
    properties: {
      billId: { type: 'string', description: 'Bill ID' },
    },
    required: ['billId'],
  },
};

// ─── Tool Implementations ───────────────────────────────────────────

function formatBill(bill: billingService.BillWithItems) {
  return {
    id: bill.id,
    billNumber: bill.billNumber,
    status: bill.status,
    paymentMethod: bill.paymentMethod,
    paymentRef: bill.paymentRef,
    items: bill.items.map(item => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      quantity: new Decimal(item.quantity).toString(),
      unit: (item as any).product?.unit || '',
      unitPrice: paiseToRupees(item.unitPrice),
      taxableValue: paiseToRupees(item.taxableValue),
      gstRate: new Decimal(item.gstRate).toString() + '%',
      hsnCode: item.hsnCode,
      cgst: paiseToRupees(item.cgst),
      sgst: paiseToRupees(item.sgst),
      lineTotal: paiseToRupees(item.lineTotal),
    })),
    subtotal: paiseToRupees(bill.subtotal),
    totalCgst: paiseToRupees(bill.totalCgst),
    totalSgst: paiseToRupees(bill.totalSgst),
    totalTax: paiseToRupees(bill.totalTax),
    grandTotal: paiseToRupees(bill.grandTotal),
    createdAt: bill.createdAt.toISOString(),
    finalizedAt: bill.finalizedAt?.toISOString(),
  };
}

export async function executeCreateBill(args: { telegramUserId: string }): Promise<ToolResult> {
  try {
    const bill = await billingService.createBill(args.telegramUserId);
    return toolSuccess({
      billId: bill.id,
      status: bill.status,
      message: 'New bill created. Add items using add_bill_item.',
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGetCurrentBill(args: { telegramUserId: string }): Promise<ToolResult> {
  try {
    const bill = await billingService.getCurrentBill(args.telegramUserId);
    if (!bill) {
      return toolSuccess({
        bill: null,
        message: 'No active draft bill. Use create_bill to start a new one.',
      });
    }
    return toolSuccess({ bill: formatBill(bill) });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeAddBillItem(args: { billId: string; productId: string; quantity: number }): Promise<ToolResult> {
  try {
    const bill = await billingService.addBillItem(args.billId, args.productId, args.quantity);
    return toolSuccess({
      bill: formatBill(bill),
      message: 'Item added to bill.',
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeUpdateBillItem(args: { billId: string; billItemId: string; newQuantity: number }): Promise<ToolResult> {
  try {
    const bill = await billingService.updateBillItem(args.billId, args.billItemId, args.newQuantity);
    return toolSuccess({
      bill: formatBill(bill),
      message: 'Bill item updated.',
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeRemoveBillItem(args: { billId: string; billItemId: string }): Promise<ToolResult> {
  try {
    const bill = await billingService.removeBillItem(args.billId, args.billItemId);
    return toolSuccess({
      bill: formatBill(bill),
      message: 'Item removed from bill.',
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeRemoveBillItemByName(args: { billId: string; productQuery: string }): Promise<ToolResult> {
  try {
    const bill = await billingService.removeBillItemByProduct(args.billId, args.productQuery);
    return toolSuccess({
      bill: formatBill(bill),
      message: `Item matching "${args.productQuery}" removed from bill.`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeSetPaymentMethod(args: { billId: string; method: string; reference?: string }): Promise<ToolResult> {
  try {
    const bill = await billingService.setPaymentMethod(args.billId, args.method as PaymentMethod, args.reference);
    return toolSuccess({
      billId: bill.id,
      paymentMethod: bill.paymentMethod,
      message: `Payment method set to ${args.method}.`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeFinalizeBill(args: { billId: string }): Promise<ToolResult> {
  try {
    const bill = await billingService.finalizeBill(args.billId);
    return toolSuccess({
      bill: formatBill(bill),
      message: `Bill ${bill.billNumber} finalized. Total: ₹${paiseToRupees(bill.grandTotal)} (${bill.paymentMethod}).`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeCancelBill(args: { billId: string }): Promise<ToolResult> {
  try {
    const bill = await billingService.cancelBill(args.billId);
    return toolSuccess({
      billId: bill.id,
      status: bill.status,
      message: 'Bill cancelled. No stock changes were made.',
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGetBill(args: { billId: string }): Promise<ToolResult> {
  try {
    const bill = await billingService.getBill(args.billId);
    return toolSuccess({ bill: formatBill(bill) });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}
