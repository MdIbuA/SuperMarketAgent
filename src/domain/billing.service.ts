import { prisma } from '../db/client';
import { Decimal } from 'decimal.js';
import { DomainError, withRetry } from '../utils/errors';
import { calculateLineTotal, formatPaise } from '../utils/money';
import { decrementStock, getProduct } from './inventory.service';
import { logger } from '../utils/logger';
import type { Bill, BillItem, BillStatus, PaymentMethod } from '@prisma/client';

export type BillWithItems = Bill & { items: (BillItem & { product: { name: string; unit: string } })[] };

/**
 * Create a new draft bill.
 */
export async function createBill(telegramUserId: string): Promise<Bill> {
  // Cancel any existing draft bills for this user
  await prisma.bill.updateMany({
    where: { telegramUserId, status: 'DRAFT' },
    data: { status: 'CANCELLED' },
  });

  const bill = await prisma.bill.create({
    data: {
      telegramUserId,
      status: 'DRAFT',
    },
  });

  // Update conversation state
  await prisma.conversationState.upsert({
    where: { telegramUserId },
    update: { currentBillId: bill.id, lastActivity: new Date() },
    create: { telegramUserId, currentBillId: bill.id },
  });

  logger.info('Bill created', { billId: bill.id, telegramUserId });
  return bill;
}

/**
 * Get the current draft bill for a user.
 */
export async function getCurrentBill(telegramUserId: string): Promise<BillWithItems | null> {
  const state = await prisma.conversationState.findUnique({
    where: { telegramUserId },
  });

  if (!state?.currentBillId) return null;

  const bill = await prisma.bill.findUnique({
    where: { id: state.currentBillId },
    include: {
      items: {
        include: { product: { select: { name: true, unit: true } } },
      },
    },
  });

  if (!bill || bill.status !== 'DRAFT') return null;
  return bill;
}

/**
 * Get a bill by ID.
 */
export async function getBill(billId: string): Promise<BillWithItems> {
  const bill = await prisma.bill.findUnique({
    where: { id: billId },
    include: {
      items: {
        include: { product: { select: { name: true, unit: true } } },
      },
      customer: true,
    },
  });

  if (!bill) {
    throw new DomainError('BILL_NOT_FOUND', `Bill not found: ${billId}`, { billId });
  }

  return bill;
}

/**
 * Add an item to a draft bill.
 * Does NOT decrement stock — only validates stock availability.
 */
export async function addBillItem(
  billId: string,
  productId: string,
  quantity: number
): Promise<BillWithItems> {
  if (quantity <= 0) {
    throw new DomainError('INVALID_QUANTITY', 'Quantity must be positive', { quantity });
  }

  return prisma.$transaction(async (tx) => {
    const bill = await tx.bill.findUnique({
      where: { id: billId },
      include: { items: true },
    });

    if (!bill) throw new DomainError('BILL_NOT_FOUND', 'Bill not found', { billId });
    if (bill.status !== 'DRAFT') {
      throw new DomainError('INVALID_BILL_STATE', `Cannot modify a ${bill.status} bill`, { status: bill.status });
    }

    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product || !product.isActive) {
      throw new DomainError('PRODUCT_NOT_FOUND', 'Product not found', { productId });
    }

    // Check if product already in bill — update quantity instead
    const existingItem = bill.items.find(item => item.productId === productId);
    if (existingItem) {
      const newQuantity = new Decimal(existingItem.quantity).plus(quantity);
      return updateBillItemInternal(tx, billId, existingItem.id, newQuantity.toNumber());
    }

    // Validate stock availability (soft check — hard check at finalization)
    const availableStock = new Decimal(product.quantity);
    if (availableStock.lt(quantity)) {
      throw new DomainError('INSUFFICIENT_STOCK', `Only ${availableStock} ${product.unit.toLowerCase()} available`, {
        requested: quantity,
        available: availableStock.toNumber(),
        product: product.name,
      });
    }

    // Below-cost guard
    if (product.sellPrice < product.costPrice) {
      throw new DomainError('BELOW_COST_PRICE', `Sell price (${formatPaise(product.sellPrice)}) is below cost (${formatPaise(product.costPrice)})`, {
        sellPrice: product.sellPrice,
        costPrice: product.costPrice,
      });
    }

    // Calculate line totals
    const lineCalc = calculateLineTotal(quantity, product.sellPrice, product.gstRate);

    await tx.billItem.create({
      data: {
        billId,
        productId,
        productName: product.name,
        quantity,
        unitPrice: product.sellPrice,
        costPrice: product.costPrice,
        taxableValue: lineCalc.taxableValue,
        gstRate: product.gstRate,
        hsnCode: product.hsnCode,
        cgst: lineCalc.cgst,
        sgst: lineCalc.sgst,
        lineTotal: lineCalc.lineTotal,
      },
    });

    // Recalculate bill totals
    return recalculateBillTotals(tx, billId);
  });
}

/**
 * Update a bill item's quantity.
 */
export async function updateBillItem(
  billId: string,
  billItemId: string,
  newQuantity: number
): Promise<BillWithItems> {
  if (newQuantity <= 0) {
    throw new DomainError('INVALID_QUANTITY', 'Quantity must be positive. Use remove to delete an item.', { quantity: newQuantity });
  }

  return prisma.$transaction(async (tx) => {
    return updateBillItemInternal(tx, billId, billItemId, newQuantity);
  });
}

async function updateBillItemInternal(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  billId: string,
  billItemId: string,
  newQuantity: number
): Promise<BillWithItems> {
  const bill = await tx.bill.findUnique({ where: { id: billId } });
  if (!bill) throw new DomainError('BILL_NOT_FOUND', 'Bill not found', { billId });
  if (bill.status !== 'DRAFT') {
    throw new DomainError('INVALID_BILL_STATE', `Cannot modify a ${bill.status} bill`, { status: bill.status });
  }

  const item = await tx.billItem.findUnique({
    where: { id: billItemId },
    include: { product: true },
  });
  if (!item) throw new DomainError('BILL_ITEM_NOT_FOUND', 'Bill item not found', { billItemId });

  // Stock check
  const product = item.product;
  if (new Decimal(product.quantity).lt(newQuantity)) {
    throw new DomainError('INSUFFICIENT_STOCK', `Only ${product.quantity} ${product.unit.toLowerCase()} available`, {
      requested: newQuantity,
      available: new Decimal(product.quantity).toNumber(),
      product: product.name,
    });
  }

  // Recalculate
  const lineCalc = calculateLineTotal(newQuantity, item.unitPrice, item.gstRate);

  await tx.billItem.update({
    where: { id: billItemId },
    data: {
      quantity: newQuantity,
      taxableValue: lineCalc.taxableValue,
      cgst: lineCalc.cgst,
      sgst: lineCalc.sgst,
      lineTotal: lineCalc.lineTotal,
    },
  });

  return recalculateBillTotals(tx, billId);
}

/**
 * Remove an item from a draft bill.
 */
export async function removeBillItem(
  billId: string,
  billItemId: string
): Promise<BillWithItems> {
  return prisma.$transaction(async (tx) => {
    const bill = await tx.bill.findUnique({ where: { id: billId } });
    if (!bill) throw new DomainError('BILL_NOT_FOUND', 'Bill not found', { billId });
    if (bill.status !== 'DRAFT') {
      throw new DomainError('INVALID_BILL_STATE', `Cannot modify a ${bill.status} bill`, { status: bill.status });
    }

    const item = await tx.billItem.findUnique({ where: { id: billItemId } });
    if (!item) throw new DomainError('BILL_ITEM_NOT_FOUND', 'Bill item not found', { billItemId });

    await tx.billItem.delete({ where: { id: billItemId } });

    return recalculateBillTotals(tx, billId);
  });
}

/**
 * Remove a bill item by product name search (for natural language: "drop the butter").
 */
export async function removeBillItemByProduct(
  billId: string,
  productQuery: string
): Promise<BillWithItems> {
  const bill = await prisma.bill.findUnique({
    where: { id: billId },
    include: { items: true },
  });

  if (!bill) throw new DomainError('BILL_NOT_FOUND', 'Bill not found', { billId });

  const matchingItems = bill.items.filter(item =>
    item.productName.toLowerCase().includes(productQuery.toLowerCase())
  );

  if (matchingItems.length === 0) {
    throw new DomainError('BILL_ITEM_NOT_FOUND', `No item matching "${productQuery}" in the bill`, { query: productQuery });
  }

  if (matchingItems.length > 1) {
    throw new DomainError('AMBIGUOUS_PRODUCT', `Multiple items match "${productQuery}"`, {
      matches: matchingItems.map(i => ({ id: i.id, name: i.productName })),
    });
  }

  return removeBillItem(billId, matchingItems[0]!.id);
}

/**
 * Set payment method on a bill.
 */
export async function setPaymentMethod(
  billId: string,
  method: PaymentMethod,
  reference?: string
): Promise<Bill> {
  const bill = await prisma.bill.findUnique({ where: { id: billId } });
  if (!bill) throw new DomainError('BILL_NOT_FOUND', 'Bill not found', { billId });
  if (bill.status !== 'DRAFT') {
    throw new DomainError('INVALID_BILL_STATE', `Cannot modify a ${bill.status} bill`, { status: bill.status });
  }

  return prisma.bill.update({
    where: { id: billId },
    data: { paymentMethod: method, paymentRef: reference },
  });
}

/**
 * Finalize a bill — the critical transaction.
 * 
 * This is the ONLY place stock is decremented.
 * Uses atomic conditional updates for concurrency safety.
 * Idempotent: re-finalizing an already-finalized bill returns the existing result.
 */
export async function finalizeBill(billId: string): Promise<BillWithItems> {
  return withRetry(async () => {
    return prisma.$transaction(async (tx) => {
      // Lock the bill row
      const bills = await tx.$queryRaw<Bill[]>`
        SELECT * FROM "Bill" WHERE "id" = ${billId} FOR UPDATE
      `;
      const bill = bills[0];

    if (!bill) throw new DomainError('BILL_NOT_FOUND', 'Bill not found', { billId });

    // Idempotency: already finalized — return existing result
    if (bill.status === 'FINALIZED') {
      logger.warn('Duplicate finalization attempt', { billId });
      return getBillWithinTx(tx, billId);
    }

    if (bill.status !== 'DRAFT') {
      throw new DomainError('INVALID_BILL_STATE', `Cannot finalize a ${bill.status} bill`, { status: bill.status });
    }

    if (!bill.paymentMethod) {
      throw new DomainError('INVALID_BILL_STATE', 'Payment method must be set before finalizing', { billId });
    }

    // Get all items
    const items = await tx.billItem.findMany({
      where: { billId },
      include: { product: true },
    });

    if (items.length === 0) {
      throw new DomainError('INVALID_BILL_STATE', 'Cannot finalize an empty bill', { billId });
    }

    // Decrement stock for each item — atomic, fails if insufficient
    for (const item of items) {
      const success = await decrementStock(tx, item.productId, item.quantity);
      if (!success) {
        // Get current stock for error message
        const product = await tx.product.findUnique({ where: { id: item.productId } });
        throw new DomainError('INSUFFICIENT_STOCK', 
          `Insufficient stock for ${item.productName}. Available: ${product?.quantity ?? 0}`,
          {
            product: item.productName,
            requested: new Decimal(item.quantity).toNumber(),
            available: product ? new Decimal(product.quantity).toNumber() : 0,
          }
        );
      }
    }

    // Generate bill number
    const sequence = await tx.$queryRaw<[{ current: number }]>`
      UPDATE "BillSequence" SET "current" = "current" + 1
      WHERE "id" = 'singleton'
      RETURNING "current"
    `;
    
    let billNumber: string;
    if (sequence.length > 0) {
      billNumber = `INV-${String(sequence[0]!.current).padStart(6, '0')}`;
    } else {
      // Initialize sequence
      await tx.$executeRaw`INSERT INTO "BillSequence" ("id", "current") VALUES ('singleton', 1) ON CONFLICT DO NOTHING`;
      billNumber = 'INV-000001';
    }

    // Finalize
    await tx.bill.update({
      where: { id: billId },
      data: {
        status: 'FINALIZED',
        billNumber,
        finalizedAt: new Date(),
        idempotencyKey: `finalize-${billId}`,
      },
    });

    // Clear current bill from conversation state
    await tx.conversationState.updateMany({
      where: { currentBillId: billId },
      data: { currentBillId: null },
    });

    logger.info('Bill finalized', {
      billId,
      billNumber,
      grandTotal: bill.grandTotal,
      paymentMethod: bill.paymentMethod,
      itemCount: items.length,
    });

    return getBillWithinTx(tx, billId);
  }, {
    isolationLevel: 'Serializable', // Highest isolation for financial transactions
    timeout: 15000,
  });
  });
}

/**
 * Cancel a draft bill.
 */
export async function cancelBill(billId: string): Promise<Bill> {
  const bill = await prisma.bill.findUnique({ where: { id: billId } });
  if (!bill) throw new DomainError('BILL_NOT_FOUND', 'Bill not found', { billId });
  if (bill.status !== 'DRAFT') {
    throw new DomainError('INVALID_BILL_STATE', `Cannot cancel a ${bill.status} bill`, { status: bill.status });
  }

  const updated = await prisma.bill.update({
    where: { id: billId },
    data: { status: 'CANCELLED' },
  });

  // Clear from conversation state
  await prisma.conversationState.updateMany({
    where: { currentBillId: billId },
    data: { currentBillId: null },
  });

  logger.info('Bill cancelled', { billId });
  return updated;
}

/**
 * Calculate and display the bill without finalizing.
 */
export async function calculateBill(billId: string): Promise<BillWithItems> {
  return getBill(billId);
}

// ─── Internal Helpers ────────────────────────────────────────────────

async function recalculateBillTotals(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  billId: string
): Promise<BillWithItems> {
  const items = await tx.billItem.findMany({ where: { billId } });

  let subtotal = 0;
  let totalCgst = 0;
  let totalSgst = 0;

  for (const item of items) {
    subtotal += item.taxableValue;
    totalCgst += item.cgst;
    totalSgst += item.sgst;
  }

  const totalTax = totalCgst + totalSgst;
  const grandTotal = subtotal + totalTax;

  await tx.bill.update({
    where: { id: billId },
    data: { subtotal, totalCgst, totalSgst, totalTax, grandTotal },
  });

  return getBillWithinTx(tx, billId);
}

async function getBillWithinTx(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  billId: string
): Promise<BillWithItems> {
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    include: {
      items: {
        include: { product: { select: { name: true, unit: true } } },
      },
    },
  });
  if (!bill) throw new DomainError('BILL_NOT_FOUND', 'Bill not found', { billId });
  return bill;
}
