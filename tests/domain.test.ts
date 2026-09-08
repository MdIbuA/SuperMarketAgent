/**
 * Comprehensive tests for the Supermarket Ops Agent.
 * 
 * These tests require a running PostgreSQL instance.
 * Run: docker compose up -d && npx prisma db push && npm test
 * 
 * Coverage:
 * 1. Product lookup
 * 2. Receive stock
 * 3. Add product
 * 4. Low-stock query
 * 5. Create bill
 * 6. Add/edit/remove bill items
 * 7. GST calculation
 * 8. CGST/SGST split
 * 9. Oversell rejection
 * 10. Below-cost guard
 * 11. Bill finalization
 * 12. Idempotent finalization
 * 13. Khata credit
 * 14. Khata settlement
 * 15. Invalid khata settlement
 * 16. Daily sales aggregation
 * 17. Persistent preferences
 * 18. /new chat retaining preferences
 * 19. PDF generation
 * 20. PPTX generation
 * 21. Concurrent inventory modification
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Decimal } from 'decimal.js';

// We test domain services directly — these are the business logic
import * as inventoryService from '../src/domain/inventory.service';
import * as billingService from '../src/domain/billing.service';
import * as khataService from '../src/domain/khata.service';
import * as analyticsService from '../src/domain/analytics.service';
import * as preferencesService from '../src/domain/preferences.service';
import { calculateLineTotal, calculateGST, rupeesToPaise, paiseToRupees } from '../src/utils/money';
import { DomainError } from '../src/utils/errors';
import { generateInvoicePDF } from '../src/documents/invoice.pdf';
import { generateAnalysisDeck } from '../src/documents/analysis.pptx';

const prisma = new PrismaClient();
const TEST_USER = 'test-user-123';

// Test product data
const testProducts = [
  {
    sku: 'TEST-MAGGI',
    name: 'Test Maggi 70g',
    unit: 'PACKET' as const,
    unitType: 'PACKAGED' as const,
    costPrice: 1200,
    sellPrice: 1400,
    mrp: 1400,
    quantity: 50,
    reorderLevel: 10,
    gstRate: 12,
    hsnCode: '1902',
  },
  {
    sku: 'TEST-SUGAR',
    name: 'Test Sugar Loose',
    unit: 'KG' as const,
    unitType: 'LOOSE' as const,
    costPrice: 4000,
    sellPrice: 4800,
    mrp: 4800,
    quantity: 30,
    reorderLevel: 15,
    gstRate: 0,
    hsnCode: '1701',
  },
  {
    sku: 'TEST-BUTTER',
    name: 'Test Amul Butter 100g',
    unit: 'PACKET' as const,
    unitType: 'PACKAGED' as const,
    costPrice: 5200,
    sellPrice: 6200,
    mrp: 6200,
    quantity: 10,
    reorderLevel: 10,
    gstRate: 12,
    hsnCode: '0405',
  },
  {
    sku: 'TEST-LOWSTOCK',
    name: 'Test Low Stock Item',
    unit: 'PIECE' as const,
    unitType: 'PACKAGED' as const,
    costPrice: 1000,
    sellPrice: 1500,
    mrp: 1500,
    quantity: 3, // Below reorder level of 10
    reorderLevel: 10,
    gstRate: 5,
    hsnCode: '9999',
  },
];

let productIds: Record<string, string> = {};

beforeAll(async () => {
  // Clean test data
  await prisma.khataEntry.deleteMany();
  await prisma.billItem.deleteMany();
  await prisma.bill.deleteMany();
  await prisma.inventoryHistory.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.dailySummary.deleteMany();
  await prisma.ownerPreference.deleteMany();
  await prisma.conversationState.deleteMany();
  await prisma.processedUpdate.deleteMany();
  await prisma.product.deleteMany();
  await prisma.billSequence.upsert({
    where: { id: 'singleton' },
    update: { current: 0 },
    create: { id: 'singleton', current: 0 },
  });

  // Seed test products
  for (const product of testProducts) {
    const created = await prisma.product.create({ data: product });
    productIds[product.sku] = created.id;
    await prisma.inventoryHistory.create({
      data: {
        productId: created.id,
        changeType: 'STOCK_IN',
        quantity: product.quantity,
        reference: 'TEST_SEED',
      },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ── 1. Product Lookup ──
describe('Product Lookup', () => {
  it('should find products by name search', async () => {
    const results = await inventoryService.searchProducts('Maggi');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name).toContain('Maggi');
  });

  it('should find products case-insensitively', async () => {
    const results = await inventoryService.searchProducts('maggi');
    expect(results.length).toBeGreaterThan(0);
  });

  it('should get product by ID', async () => {
    const product = await inventoryService.getProduct(productIds['TEST-MAGGI']!);
    expect(product.name).toBe('Test Maggi 70g');
    expect(product.costPrice).toBe(1200);
  });

  it('should throw for nonexistent product', async () => {
    await expect(inventoryService.getProduct('nonexistent-id')).rejects.toThrow(DomainError);
  });
});

// ── 2. Receive Stock ──
describe('Receive Stock', () => {
  it('should receive stock and increase quantity', async () => {
    const before = await inventoryService.getProduct(productIds['TEST-MAGGI']!);
    const beforeQty = new Decimal(before.quantity);

    const updated = await inventoryService.receiveStock({
      productId: productIds['TEST-MAGGI']!,
      quantity: 20,
      notes: 'Test stock receipt',
    });

    const afterQty = new Decimal(updated.quantity);
    expect(afterQty.minus(beforeQty).toNumber()).toBe(20);
  });

  it('should update cost price and MRP when provided', async () => {
    const updated = await inventoryService.receiveStock({
      productId: productIds['TEST-MAGGI']!,
      quantity: 10,
      costPrice: 1300,
      mrp: 1500,
    });

    expect(updated.costPrice).toBe(1300);
    expect(updated.mrp).toBe(1500);
  });

  it('should reject negative quantity', async () => {
    await expect(inventoryService.receiveStock({
      productId: productIds['TEST-MAGGI']!,
      quantity: -5,
    })).rejects.toThrow(DomainError);
  });
});

// ── 3. Add Product ──
describe('Add Product', () => {
  it('should add a new product', async () => {
    const product = await inventoryService.addProduct({
      name: 'Test New Product',
      unit: 'PIECE',
      unitType: 'PACKAGED',
      costPrice: 5000,
      sellPrice: 7000,
      mrp: 7000,
      quantity: 15,
      gstRate: 18,
      hsnCode: '8888',
    });

    expect(product.name).toBe('Test New Product');
    expect(product.costPrice).toBe(5000);
    expect(product.sellPrice).toBe(7000);
    productIds['TEST-NEW'] = product.id;
  });

  it('should reject duplicate product name', async () => {
    await expect(inventoryService.addProduct({
      name: 'Test Maggi 70g',
      unit: 'PACKET',
      unitType: 'PACKAGED',
      costPrice: 1200,
      sellPrice: 1400,
      mrp: 1400,
      gstRate: 12,
      hsnCode: '1902',
    })).rejects.toThrow(DomainError);
  });

  it('should reject sell price below cost', async () => {
    await expect(inventoryService.addProduct({
      name: 'Bad Product',
      unit: 'PIECE',
      unitType: 'PACKAGED',
      costPrice: 5000,
      sellPrice: 3000,
      mrp: 3000,
      gstRate: 5,
      hsnCode: '0000',
    })).rejects.toThrow(DomainError);
  });
});

// ── 4. Low-Stock Query ──
describe('Low Stock', () => {
  it('should return products below reorder level', async () => {
    const lowStock = await inventoryService.getLowStock();
    expect(lowStock.length).toBeGreaterThan(0);
    const lowStockItem = lowStock.find(p => p.sku === 'TEST-LOWSTOCK');
    expect(lowStockItem).toBeDefined();
  });
});

// ── 7 & 8. GST Calculation & CGST/SGST Split ──
describe('GST Calculation', () => {
  it('should calculate 12% GST correctly', () => {
    const result = calculateGST(10000, 12); // ₹100 taxable at 12%
    expect(result.cgst).toBe(600); // ₹6.00
    expect(result.sgst).toBe(600); // ₹6.00
    expect(result.totalTax).toBe(1200); // ₹12.00
  });

  it('should handle 0% GST', () => {
    const result = calculateGST(10000, 0);
    expect(result.cgst).toBe(0);
    expect(result.sgst).toBe(0);
    expect(result.totalTax).toBe(0);
  });

  it('should handle 5% GST', () => {
    const result = calculateGST(10000, 5);
    expect(result.cgst).toBe(250);
    expect(result.sgst).toBe(250);
    expect(result.totalTax).toBe(500);
  });

  it('should handle 18% GST', () => {
    const result = calculateGST(10000, 18);
    expect(result.cgst).toBe(900);
    expect(result.sgst).toBe(900);
    expect(result.totalTax).toBe(1800);
  });

  it('should calculate line total correctly', () => {
    // 4 Maggi at ₹14 = ₹56 taxable, 12% GST = ₹6.72 tax
    const result = calculateLineTotal(4, 1400, 12);
    expect(result.taxableValue).toBe(5600); // ₹56
    expect(result.cgst).toBe(336); // ₹3.36
    expect(result.sgst).toBe(336); // ₹3.36
    expect(result.lineTotal).toBe(6272); // ₹62.72
  });

  it('should round correctly', () => {
    // Test rounding with odd amounts
    const result = calculateLineTotal(3, 1400, 12);
    // 3 * 14 = 42, 12% = 5.04, CGST = 2.52, SGST = 2.52
    expect(result.taxableValue).toBe(4200);
    expect(result.cgst).toBe(252);
    expect(result.sgst).toBe(252);
  });
});

describe('Money Utilities', () => {
  it('should convert rupees to paise correctly', () => {
    expect(rupeesToPaise(12)).toBe(1200);
    expect(rupeesToPaise(12.50)).toBe(1250);
    expect(rupeesToPaise(0.01)).toBe(1);
  });

  it('should convert paise to rupees correctly', () => {
    expect(paiseToRupees(1200)).toBe('12.00');
    expect(paiseToRupees(1250)).toBe('12.50');
    expect(paiseToRupees(1)).toBe('0.01');
  });
});

// ── 5, 6, 9, 10, 11. Billing ──
describe('Billing', () => {
  let billId: string;

  // ── 5. Create Bill ──
  it('should create a draft bill', async () => {
    const bill = await billingService.createBill(TEST_USER);
    expect(bill.status).toBe('DRAFT');
    expect(bill.telegramUserId).toBe(TEST_USER);
    billId = bill.id;
  });

  // ── 6. Add/edit/remove bill items ──
  it('should add items to bill', async () => {
    const bill = await billingService.addBillItem(billId, productIds['TEST-MAGGI']!, 4);
    expect(bill.items.length).toBe(1);
    expect(new Decimal(bill.items[0]!.quantity).toNumber()).toBe(4);
    expect(bill.subtotal).toBeGreaterThan(0);
  });

  it('should add another item', async () => {
    const bill = await billingService.addBillItem(billId, productIds['TEST-SUGAR']!, 2);
    expect(bill.items.length).toBe(2);
  });

  it('should add butter', async () => {
    const bill = await billingService.addBillItem(billId, productIds['TEST-BUTTER']!, 1);
    expect(bill.items.length).toBe(3);
  });

  it('should remove item by product name', async () => {
    const bill = await billingService.removeBillItemByProduct(billId, 'Butter');
    expect(bill.items.length).toBe(2);
  });

  it('should update bill item quantity', async () => {
    const bill = await billingService.getBill(billId);
    const maggiItem = bill.items.find(i => i.productName.includes('Maggi'));
    expect(maggiItem).toBeDefined();

    const updated = await billingService.updateBillItem(billId, maggiItem!.id, 6);
    const updatedMaggi = updated.items.find(i => i.productName.includes('Maggi'));
    expect(new Decimal(updatedMaggi!.quantity).toNumber()).toBe(6);
  });

  // ── 10. Below-cost guard ──
  it('should verify below-cost guard (checked at add time via product setup)', async () => {
    // Our products are set up correctly, so we test by creating a product with sell < cost
    await expect(inventoryService.addProduct({
      name: 'Loss Product',
      unit: 'PIECE',
      unitType: 'PACKAGED',
      costPrice: 10000,
      sellPrice: 5000, // below cost
      mrp: 5000,
      gstRate: 5,
      hsnCode: '0001',
    })).rejects.toThrow('Sell price cannot be less than cost price');
  });

  it('should set payment method', async () => {
    const bill = await billingService.setPaymentMethod(billId, 'UPI');
    expect(bill.paymentMethod).toBe('UPI');
  });

  it('should correctly calculate bill totals with GST', async () => {
    const bill = await billingService.getBill(billId);

    // Verify totals make sense
    expect(bill.subtotal).toBeGreaterThan(0);
    expect(bill.grandTotal).toBe(bill.subtotal + bill.totalTax);
    expect(bill.totalTax).toBe(bill.totalCgst + bill.totalSgst);
    expect(bill.totalCgst).toBe(bill.totalSgst); // CGST = SGST for intra-state
  });

  // ── 9. Oversell Rejection ──
  it('should reject oversell at bill item add time', async () => {
    // Low stock item has 3 units, try to add 100
    await expect(
      billingService.addBillItem(billId, productIds['TEST-LOWSTOCK']!, 100)
    ).rejects.toThrow('available');
  });

  // ── 11. Bill Finalization ──
  it('should finalize bill and decrement stock', async () => {
    const maggiBeforeRaw = await inventoryService.getProduct(productIds['TEST-MAGGI']!);
    const magiBefore = new Decimal(maggiBeforeRaw.quantity);

    const bill = await billingService.finalizeBill(billId);
    expect(bill.status).toBe('FINALIZED');
    expect(bill.billNumber).toBeTruthy();
    expect(bill.finalizedAt).toBeTruthy();

    // Verify stock was decremented
    const maggiAfterRaw = await inventoryService.getProduct(productIds['TEST-MAGGI']!);
    const maggiAfter = new Decimal(maggiAfterRaw.quantity);
    expect(magiBefore.minus(maggiAfter).toNumber()).toBe(6); // We set quantity to 6
  });

  // ── 12. Idempotent Finalization ──
  it('should handle duplicate finalization idempotently', async () => {
    // Finalize same bill again — should return existing result, not error
    const bill = await billingService.finalizeBill(billId);
    expect(bill.status).toBe('FINALIZED');
    expect(bill.billNumber).toBeTruthy();
    // Should NOT have decremented stock again
  });

  it('should reject finalization of cancelled bill', async () => {
    const newBill = await billingService.createBill(TEST_USER + '-cancel');
    await billingService.cancelBill(newBill.id);
    await expect(billingService.finalizeBill(newBill.id)).rejects.toThrow('CANCELLED');
  });

  it('should reject finalization of empty bill', async () => {
    const emptyBill = await billingService.createBill(TEST_USER + '-empty');
    await billingService.setPaymentMethod(emptyBill.id, 'CASH');
    await expect(billingService.finalizeBill(emptyBill.id)).rejects.toThrow('empty');
  });

  it('should reject finalization without payment method', async () => {
    const bill = await billingService.createBill(TEST_USER + '-nopay');
    await billingService.addBillItem(bill.id, productIds['TEST-SUGAR']!, 1);
    await expect(billingService.finalizeBill(bill.id)).rejects.toThrow('Payment method');
  });
});

// ── 13, 14, 15. Khata ──
describe('Khata (Credit Ledger)', () => {
  let customerId: string;

  // ── 13. Khata Credit ──
  it('should create customer and add credit', async () => {
    const customer = await khataService.findOrCreateCustomer('Ramesh', TEST_USER);
    customerId = customer.id;

    const result = await khataService.addCredit(customerId, 50000); // ₹500
    expect(result.customer.balance).toBe(50000);
    expect(result.entry.type).toBe('CREDIT');
    expect(result.entry.amount).toBe(50000);
  });

  // ── 14. Khata Settlement ──
  it('should record payment and reduce balance', async () => {
    const result = await khataService.recordPayment(customerId, 30000); // ₹300
    expect(result.customer.balance).toBe(20000); // ₹200 remaining
    expect(result.entry.type).toBe('PAYMENT');
  });

  it('should track balance correctly', async () => {
    const balance = await khataService.getCustomerBalance(customerId);
    expect(balance.balance).toBe(20000); // ₹200
  });

  // ── 15. Invalid Khata Settlement ──
  it('should reject payment exceeding balance', async () => {
    await expect(
      khataService.recordPayment(customerId, 100000) // ₹1000 > ₹200 balance
    ).rejects.toThrow('exceeds');
  });

  it('should reject payment on zero balance', async () => {
    // First settle remaining balance
    await khataService.recordPayment(customerId, 20000);

    // Now try to pay more
    await expect(
      khataService.recordPayment(customerId, 1000)
    ).rejects.toThrow('no outstanding');
  });
});

// ── 16. Daily Sales Aggregation ──
describe('Daily Sales Aggregation', () => {
  it('should return today\'s sales summary', async () => {
    const report = await analyticsService.getDailySales();
    expect(report.date).toBeTruthy();
    // We finalized a bill earlier
    expect(report.billCount).toBeGreaterThanOrEqual(1);
    expect(report.totalSales).toBeGreaterThan(0);
  });

  it('should include payment breakdown', async () => {
    const report = await analyticsService.getDailySales();
    expect(report.upiSales).toBeGreaterThanOrEqual(0);
  });

  it('should close the day', async () => {
    const report = await analyticsService.closeDay(TEST_USER);
    expect(report.totalSales).toBeGreaterThan(0);

    // Verify it was stored
    const summary = await prisma.dailySummary.findFirst({
      where: { telegramUserId: TEST_USER },
    });
    expect(summary).toBeTruthy();
  });
});

// ── 17 & 18. Persistent Preferences ──
describe('Persistent Preferences', () => {
  // ── 17. Set and get preference ──
  it('should set a preference', async () => {
    const result = await preferencesService.setPreference(TEST_USER, 'default_payment_method', 'UPI');
    expect(result.key).toBe('default_payment_method');
    expect(result.value).toBe('UPI');
  });

  it('should get preferences', async () => {
    const prefs = await preferencesService.getOwnerPreferences(TEST_USER);
    expect(prefs['default_payment_method']).toBe('UPI');
  });

  it('should update existing preference', async () => {
    await preferencesService.setPreference(TEST_USER, 'default_payment_method', 'CASH');
    const value = await preferencesService.getPreference(TEST_USER, 'default_payment_method');
    expect(value).toBe('CASH');
  });

  // ── 18. /new chat retaining preferences ──
  it('should retain preferences after simulated /new chat', async () => {
    // Set a preference
    await preferencesService.setPreference(TEST_USER, 'shop_name', 'ABC Stores');
    await preferencesService.setPreference(TEST_USER, 'default_atta', 'Aashirvaad 5kg');

    // Simulate /new chat (clear conversation state, but NOT preferences)
    await prisma.conversationState.deleteMany({ where: { telegramUserId: TEST_USER } });

    // Preferences should still be there
    const prefs = await preferencesService.getOwnerPreferences(TEST_USER);
    expect(prefs['shop_name']).toBe('ABC Stores');
    expect(prefs['default_atta']).toBe('Aashirvaad 5kg');
    expect(prefs['default_payment_method']).toBe('CASH');
  });
});

// ── 19. PDF Generation ──
describe('PDF Invoice Generation', () => {
  it('should generate a valid PDF buffer', async () => {
    const pdfBuffer = await generateInvoicePDF({
      billNumber: 'INV-000001',
      date: new Date().toLocaleDateString('en-IN'),
      items: [
        {
          productName: 'Maggi 70g',
          hsnCode: '1902',
          quantity: '4',
          unit: 'packet',
          unitPrice: 1400,
          taxableValue: 5600,
          gstRate: '12%',
          cgst: 336,
          sgst: 336,
          lineTotal: 6272,
        },
        {
          productName: 'Sugar - Loose',
          hsnCode: '1701',
          quantity: '2',
          unit: 'kg',
          unitPrice: 4800,
          taxableValue: 9600,
          gstRate: '0%',
          cgst: 0,
          sgst: 0,
          lineTotal: 9600,
        },
      ],
      subtotal: 15200,
      totalCgst: 336,
      totalSgst: 336,
      totalTax: 672,
      grandTotal: 15872,
      paymentMethod: 'UPI',
    }, TEST_USER);

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(100);
    // PDF magic number check
    expect(pdfBuffer.toString('ascii', 0, 5)).toBe('%PDF-');
  });
});

// ── 20. PPTX Generation ──
describe('PPTX Analysis Deck Generation', () => {
  it('should generate a valid PPTX buffer', async () => {
    const pptxBuffer = await generateAnalysisDeck({
      period: { from: '2024-01-01', to: '2024-01-07' },
      totalRevenue: 150000,
      totalTax: 12000,
      totalBills: 25,
      dailySales: [
        { date: '2024-01-01', total: 20000, billCount: 3 },
        { date: '2024-01-02', total: 25000, billCount: 5 },
        { date: '2024-01-03', total: 30000, billCount: 4 },
      ],
      topProducts: [
        { name: 'Maggi', quantity: '20', revenue: 28000 },
        { name: 'Sugar', quantity: '15', revenue: 24000 },
      ],
      paymentDistribution: { cash: 50000, upi: 80000, card: 20000 },
      gstCollected: { cgst: 6000, sgst: 6000, total: 12000 },
      lowStockProducts: [
        { name: 'Test Item', quantity: '3', reorderLevel: '10' },
      ],
    });

    expect(pptxBuffer).toBeInstanceOf(Buffer);
    expect(pptxBuffer.length).toBeGreaterThan(100);
    // PPTX is a ZIP file — check PK magic number
    expect(pptxBuffer[0]).toBe(0x50); // P
    expect(pptxBuffer[1]).toBe(0x4B); // K
  });
});

// ── 21. Concurrent Inventory Modification ──
describe('Concurrent Stock Safety', () => {
  it('should handle concurrent stock decrements safely', async () => {
    // Create a product with exactly 10 units
    const concProduct = await prisma.product.create({
      data: {
        sku: 'CONC-TEST',
        name: 'Concurrency Test Product',
        unit: 'PIECE',
        unitType: 'PACKAGED',
        costPrice: 1000,
        sellPrice: 1500,
        mrp: 1500,
        quantity: 10,
        reorderLevel: 0,
        gstRate: 5,
        hsnCode: '9999',
      },
    });

    // Create two bills that each try to buy 7 units (only 10 available)
    const bill1 = await billingService.createBill('concurrent-user-1');
    const bill2 = await billingService.createBill('concurrent-user-2');

    await billingService.addBillItem(bill1.id, concProduct.id, 7);
    await billingService.setPaymentMethod(bill1.id, 'CASH');

    await billingService.addBillItem(bill2.id, concProduct.id, 7);
    await billingService.setPaymentMethod(bill2.id, 'CASH');

    // Finalize both concurrently
    const results = await Promise.allSettled([
      billingService.finalizeBill(bill1.id),
      billingService.finalizeBill(bill2.id),
    ]);

    // Exactly one should succeed, one should fail
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    // Verify stock is correct (should be 3, not negative)
    const finalProduct = await prisma.product.findUnique({ where: { id: concProduct.id } });
    expect(new Decimal(finalProduct!.quantity).toNumber()).toBe(3);
  });

  it('should handle concurrent stock receipt and sale', async () => {
    // Create product with 5 units
    const product = await prisma.product.create({
      data: {
        sku: 'CONC-TEST-2',
        name: 'Concurrency Test 2',
        unit: 'PIECE',
        unitType: 'PACKAGED',
        costPrice: 1000,
        sellPrice: 1500,
        mrp: 1500,
        quantity: 5,
        reorderLevel: 0,
        gstRate: 0,
        hsnCode: '9998',
      },
    });

    // Concurrently: receive 10 AND sell 4
    const bill = await billingService.createBill('concurrent-user-3');
    await billingService.addBillItem(bill.id, product.id, 4);
    await billingService.setPaymentMethod(bill.id, 'CASH');

    const [receiveResult, saleResult] = await Promise.allSettled([
      inventoryService.receiveStock({ productId: product.id, quantity: 10 }),
      billingService.finalizeBill(bill.id),
    ]);

    // Both should succeed (5 + 10 - 4 = 11, or 5 - 4 + 10 = 11)
    expect(receiveResult.status).toBe('fulfilled');
    expect(saleResult.status).toBe('fulfilled');

    const finalProduct = await prisma.product.findUnique({ where: { id: product.id } });
    expect(new Decimal(finalProduct!.quantity).toNumber()).toBe(11);
  });
});
