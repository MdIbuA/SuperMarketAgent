import * as khataService from '../domain/khata.service';
import { DomainError, toolSuccess, type ToolResult } from '../utils/errors';
import { paiseToRupees, rupeesToPaise, formatPaise } from '../utils/money';

// ─── Tool Schemas ───────────────────────────────────────────────────

export const addCreditSchema = {
  name: 'add_khata_credit',
  description: 'Add credit to a customer\'s khata (the customer owes this amount). Creates the customer if they don\'t exist. Use this for "put ₹500 on Ramesh\'s credit" type requests.',
  input_schema: {
    type: 'object' as const,
    properties: {
      customerName: { type: 'string', description: 'Customer name (e.g., "Ramesh")' },
      amount: { type: 'number', description: 'Amount in rupees (e.g., 500 for ₹500)' },
      telegramUserId: { type: 'string', description: 'Telegram user ID of the owner' },
      notes: { type: 'string', description: 'Optional notes' },
      billId: { type: 'string', description: 'Optional bill ID if this credit is from a bill' },
    },
    required: ['customerName', 'amount', 'telegramUserId'],
  },
};

export const recordPaymentSchema = {
  name: 'record_khata_payment',
  description: 'Record a payment from a customer settling their khata balance. Use this for "Ramesh paid ₹300" type requests.',
  input_schema: {
    type: 'object' as const,
    properties: {
      customerName: { type: 'string', description: 'Customer name' },
      amount: { type: 'number', description: 'Payment amount in rupees' },
      telegramUserId: { type: 'string', description: 'Telegram user ID of the owner' },
      notes: { type: 'string', description: 'Optional notes' },
    },
    required: ['customerName', 'amount', 'telegramUserId'],
  },
};

export const getBalanceSchema = {
  name: 'get_khata_balance',
  description: 'Get a customer\'s outstanding khata balance. Use this for "Ramesh\'s balance?" type requests.',
  input_schema: {
    type: 'object' as const,
    properties: {
      customerName: { type: 'string', description: 'Customer name' },
      telegramUserId: { type: 'string', description: 'Telegram user ID of the owner' },
    },
    required: ['customerName', 'telegramUserId'],
  },
};

export const getKhataHistorySchema = {
  name: 'get_khata_history',
  description: 'Get transaction history for a customer\'s khata account.',
  input_schema: {
    type: 'object' as const,
    properties: {
      customerName: { type: 'string', description: 'Customer name' },
      telegramUserId: { type: 'string', description: 'Telegram user ID of the owner' },
      limit: { type: 'number', description: 'Max entries (default 20)' },
    },
    required: ['customerName', 'telegramUserId'],
  },
};

export const getOutstandingBalancesSchema = {
  name: 'get_all_outstanding_balances',
  description: 'Get all customers with outstanding balances (who owe money).',
  input_schema: {
    type: 'object' as const,
    properties: {
      telegramUserId: { type: 'string', description: 'Telegram user ID of the owner' },
    },
    required: ['telegramUserId'],
  },
};

// ─── Tool Implementations ───────────────────────────────────────────

async function findOrCreateCustomer(name: string, telegramUserId: string) {
  return khataService.findOrCreateCustomer(name, telegramUserId);
}

export async function executeAddCredit(args: {
  customerName: string;
  amount: number;
  telegramUserId: string;
  notes?: string;
  billId?: string;
}): Promise<ToolResult> {
  try {
    const customer = await findOrCreateCustomer(args.customerName, args.telegramUserId);
    const amountPaise = rupeesToPaise(args.amount);
    const result = await khataService.addCredit(customer.id, amountPaise, undefined, args.billId, args.notes);

    return toolSuccess({
      customer: {
        id: result.customer.id,
        name: result.customer.name,
        balance: paiseToRupees(result.customer.balance),
      },
      entry: {
        type: result.entry.type,
        amount: paiseToRupees(result.entry.amount),
        balance: paiseToRupees(result.entry.balance),
      },
      message: `₹${args.amount} credit added to ${args.customerName}'s khata. Outstanding balance: ₹${paiseToRupees(result.customer.balance)}`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeRecordPayment(args: {
  customerName: string;
  amount: number;
  telegramUserId: string;
  notes?: string;
}): Promise<ToolResult> {
  try {
    const customers = await khataService.searchCustomers(args.customerName, args.telegramUserId);
    if (customers.length === 0) {
      return {
        success: false,
        errorCode: 'CUSTOMER_NOT_FOUND',
        message: `Customer "${args.customerName}" not found. Cannot record payment for nonexistent customer.`,
        details: { customerName: args.customerName },
      };
    }

    const customer = customers[0]!;
    const amountPaise = rupeesToPaise(args.amount);
    const result = await khataService.recordPayment(customer.id, amountPaise, undefined, args.notes);

    return toolSuccess({
      customer: {
        id: result.customer.id,
        name: result.customer.name,
        balance: paiseToRupees(result.customer.balance),
      },
      entry: {
        type: result.entry.type,
        amount: paiseToRupees(result.entry.amount),
        balance: paiseToRupees(result.entry.balance),
      },
      message: `₹${args.amount} payment recorded from ${args.customerName}. Remaining balance: ₹${paiseToRupees(result.customer.balance)}`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGetBalance(args: {
  customerName: string;
  telegramUserId: string;
}): Promise<ToolResult> {
  try {
    const customers = await khataService.searchCustomers(args.customerName, args.telegramUserId);
    if (customers.length === 0) {
      return toolSuccess({
        found: false,
        message: `No customer named "${args.customerName}" found.`,
      });
    }

    const customer = customers[0]!;
    const balance = await khataService.getCustomerBalance(customer.id);

    return toolSuccess({
      customer: {
        id: balance.customer.id,
        name: balance.customer.name,
        balance: paiseToRupees(balance.balance),
        formattedBalance: balance.formattedBalance,
      },
      message: balance.balance > 0
        ? `${balance.customer.name} owes ${balance.formattedBalance}`
        : `${balance.customer.name} has no outstanding balance.`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGetKhataHistory(args: {
  customerName: string;
  telegramUserId: string;
  limit?: number;
}): Promise<ToolResult> {
  try {
    const customers = await khataService.searchCustomers(args.customerName, args.telegramUserId);
    if (customers.length === 0) {
      return toolSuccess({ found: false, message: `No customer named "${args.customerName}" found.` });
    }

    const history = await khataService.getKhataHistory(customers[0]!.id, args.limit);
    return toolSuccess({
      customerName: customers[0]!.name,
      history: history.map(h => ({
        type: h.type,
        amount: paiseToRupees(h.amount),
        balance: paiseToRupees(h.balance),
        notes: h.notes,
        date: h.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGetOutstandingBalances(args: { telegramUserId: string }): Promise<ToolResult> {
  try {
    const customers = await khataService.getOutstandingBalances(args.telegramUserId);
    return toolSuccess({
      customers: customers.map(c => ({
        name: c.name,
        balance: paiseToRupees(c.balance),
        formattedBalance: formatPaise(c.balance),
      })),
      totalOutstanding: paiseToRupees(customers.reduce((sum, c) => sum + c.balance, 0)),
      count: customers.length,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}
