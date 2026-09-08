import { prisma } from '../db/client';
import { DomainError } from '../utils/errors';
import { formatPaise } from '../utils/money';
import { logger } from '../utils/logger';
import type { Customer, KhataEntry } from '@prisma/client';

/**
 * Find or create a customer by name for a given owner.
 */
export async function findOrCreateCustomer(
  name: string,
  telegramUserId: string,
  phone?: string
): Promise<Customer> {
  const existing = await prisma.customer.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      telegramUserId,
    },
  });

  if (existing) return existing;

  const customer = await prisma.customer.create({
    data: { name, telegramUserId, phone },
  });

  logger.info('Customer created', { customerId: customer.id, name });
  return customer;
}

/**
 * Search customers by name.
 */
export async function searchCustomers(
  query: string,
  telegramUserId: string
): Promise<Customer[]> {
  return prisma.customer.findMany({
    where: {
      telegramUserId,
      name: { contains: query, mode: 'insensitive' },
    },
    orderBy: { name: 'asc' },
    take: 10,
  });
}

/**
 * Add credit to a customer's khata (customer owes more).
 */
export async function addCredit(
  customerId: string,
  amount: number, // in paise
  reference?: string,
  billId?: string,
  notes?: string
): Promise<{ entry: KhataEntry; customer: Customer }> {
  if (amount <= 0) {
    throw new DomainError('INVALID_AMOUNT', 'Credit amount must be positive', { amount });
  }

  return prisma.$transaction(async (tx) => {
    // Lock customer row
    const customers = await tx.$queryRaw<Customer[]>`
      SELECT * FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE
    `;
    const customer = customers[0];

    if (!customer) {
      throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found', { customerId });
    }

    const newBalance = customer.balance + amount;

    // Update balance
    await tx.customer.update({
      where: { id: customerId },
      data: { balance: newBalance },
    });

    // Record entry
    const entry = await tx.khataEntry.create({
      data: {
        customerId,
        type: 'CREDIT',
        amount,
        balance: newBalance,
        reference,
        billId,
        notes: notes || `Credit of ${formatPaise(amount)}`,
      },
    });

    const updatedCustomer = await tx.customer.findUnique({ where: { id: customerId } });

    logger.info('Khata credit added', {
      customerId,
      amount,
      newBalance,
      customerName: customer.name,
    });

    return { entry, customer: updatedCustomer! };
  });
}

/**
 * Record a payment (settlement) from a customer.
 */
export async function recordPayment(
  customerId: string,
  amount: number, // in paise
  reference?: string,
  notes?: string
): Promise<{ entry: KhataEntry; customer: Customer }> {
  if (amount <= 0) {
    throw new DomainError('INVALID_AMOUNT', 'Payment amount must be positive', { amount });
  }

  return prisma.$transaction(async (tx) => {
    // Lock customer row
    const customers = await tx.$queryRaw<Customer[]>`
      SELECT * FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE
    `;
    const customer = customers[0];

    if (!customer) {
      throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found', { customerId });
    }

    if (customer.balance <= 0) {
      throw new DomainError('INVALID_KHATA_OPERATION', `${customer.name} has no outstanding balance`, {
        customerName: customer.name,
        currentBalance: customer.balance,
      });
    }

    if (amount > customer.balance) {
      throw new DomainError('INVALID_KHATA_OPERATION',
        `Payment (${formatPaise(amount)}) exceeds outstanding balance (${formatPaise(customer.balance)})`,
        {
          paymentAmount: amount,
          outstandingBalance: customer.balance,
          customerName: customer.name,
        }
      );
    }

    const newBalance = customer.balance - amount;

    await tx.customer.update({
      where: { id: customerId },
      data: { balance: newBalance },
    });

    const entry = await tx.khataEntry.create({
      data: {
        customerId,
        type: 'PAYMENT',
        amount,
        balance: newBalance,
        reference,
        notes: notes || `Payment of ${formatPaise(amount)}`,
      },
    });

    const updatedCustomer = await tx.customer.findUnique({ where: { id: customerId } });

    logger.info('Khata payment recorded', {
      customerId,
      amount,
      newBalance,
      customerName: customer.name,
    });

    return { entry, customer: updatedCustomer! };
  });
}

/**
 * Get customer balance.
 */
export async function getCustomerBalance(customerId: string): Promise<{
  customer: Customer;
  balance: number;
  formattedBalance: string;
}> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });

  if (!customer) {
    throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found', { customerId });
  }

  return {
    customer,
    balance: customer.balance,
    formattedBalance: formatPaise(customer.balance),
  };
}

/**
 * Get khata transaction history for a customer.
 */
export async function getKhataHistory(
  customerId: string,
  limit: number = 20
): Promise<KhataEntry[]> {
  return prisma.khataEntry.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/**
 * Get all customers with outstanding balances for an owner.
 */
export async function getOutstandingBalances(telegramUserId: string): Promise<Customer[]> {
  return prisma.customer.findMany({
    where: {
      telegramUserId,
      balance: { gt: 0 },
    },
    orderBy: { balance: 'desc' },
  });
}
