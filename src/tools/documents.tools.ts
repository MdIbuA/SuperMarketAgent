import { generateInvoicePDF } from '../documents/invoice.pdf';
import { generateAnalysisDeck } from '../documents/analysis.pptx';
import * as billingService from '../domain/billing.service';
import * as analyticsService from '../domain/analytics.service';
import * as inventoryService from '../domain/inventory.service';
import { DomainError, toolSuccess, type ToolResult } from '../utils/errors';
import { Decimal } from 'decimal.js';
import { logger } from '../utils/logger';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ─── Tool Schemas ───────────────────────────────────────────────────

export const generateInvoicePDFSchema = {
  name: 'generate_invoice_pdf',
  description: 'Generate a PDF invoice for a finalized bill. Returns the file path to the generated PDF. The bill must be finalized first.',
  input_schema: {
    type: 'object' as const,
    properties: {
      billId: { type: 'string', description: 'Bill ID (must be a finalized bill)' },
      telegramUserId: { type: 'string', description: 'Telegram user ID (for shop info from preferences)' },
    },
    required: ['billId', 'telegramUserId'],
  },
};

export const generateAnalysisDeckSchema = {
  name: 'generate_analysis_deck',
  description: 'Generate a PowerPoint (PPTX) analysis deck with charts showing sales trends, top products, payment distribution, GST collection, and stock health. Returns the file path to the generated PPTX.',
  input_schema: {
    type: 'object' as const,
    properties: {
      telegramUserId: { type: 'string', description: 'Telegram user ID' },
      startDate: { type: 'string', description: 'Start date (YYYY-MM-DD). Defaults to 7 days ago.' },
      endDate: { type: 'string', description: 'End date (YYYY-MM-DD). Defaults to today.' },
    },
    required: ['telegramUserId'],
  },
};

// ─── Tool Implementations ───────────────────────────────────────────

function ensureTempDir(): string {
  const dir = path.join(os.tmpdir(), 'supermarket-agent-docs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export async function executeGenerateInvoicePDF(args: {
  billId: string;
  telegramUserId: string;
}): Promise<ToolResult> {
  try {
    const bill = await billingService.getBill(args.billId);

    if (bill.status !== 'FINALIZED') {
      return {
        success: false,
        errorCode: 'INVALID_BILL_STATE',
        message: 'Can only generate invoice for finalized bills. Finalize the bill first.',
        details: { status: bill.status },
      };
    }

    const invoiceData = {
      billNumber: bill.billNumber || 'DRAFT',
      date: bill.finalizedAt?.toLocaleDateString('en-IN') || new Date().toLocaleDateString('en-IN'),
      items: bill.items.map(item => ({
        productName: item.productName,
        hsnCode: item.hsnCode,
        quantity: new Decimal(item.quantity).toString(),
        unit: (item as any).product?.unit?.toLowerCase() || 'unit',
        unitPrice: item.unitPrice,
        taxableValue: item.taxableValue,
        gstRate: new Decimal(item.gstRate).toString() + '%',
        cgst: item.cgst,
        sgst: item.sgst,
        lineTotal: item.lineTotal,
      })),
      subtotal: bill.subtotal,
      totalCgst: bill.totalCgst,
      totalSgst: bill.totalSgst,
      totalTax: bill.totalTax,
      grandTotal: bill.grandTotal,
      paymentMethod: bill.paymentMethod || 'CASH',
      paymentRef: bill.paymentRef,
      customerName: (bill as any).customer?.name,
    };

    const pdfBuffer = await generateInvoicePDF(invoiceData, args.telegramUserId);

    // Save to temp file
    const dir = ensureTempDir();
    const filename = `invoice_${bill.billNumber || bill.id}.pdf`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, pdfBuffer);

    logger.info('Invoice PDF generated', { billId: args.billId, filepath, size: pdfBuffer.length });

    return toolSuccess({
      filePath: filepath,
      fileName: filename,
      billNumber: bill.billNumber,
      size: pdfBuffer.length,
      message: `Invoice ${bill.billNumber} PDF generated successfully.`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGenerateAnalysisDeck(args: {
  telegramUserId: string;
  startDate?: string;
  endDate?: string;
}): Promise<ToolResult> {
  try {
    const endDate = args.endDate ? new Date(args.endDate) : new Date();
    const startDate = args.startDate
      ? new Date(args.startDate)
      : new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Get sales data
    const salesData = await analyticsService.getSalesRange(startDate, endDate);

    // Get low stock products
    const lowStockProducts = await inventoryService.getLowStock();

    const deckData = {
      period: {
        from: startDate.toISOString().split('T')[0]!,
        to: endDate.toISOString().split('T')[0]!,
      },
      totalRevenue: salesData.totalRevenue,
      totalTax: salesData.totalTax,
      totalBills: salesData.totalBills,
      dailySales: salesData.dailySales,
      topProducts: salesData.topProducts,
      paymentDistribution: salesData.paymentDistribution,
      gstCollected: salesData.gstCollected,
      lowStockProducts: lowStockProducts.map(p => ({
        name: p.name,
        quantity: new Decimal(p.quantity).toString(),
        reorderLevel: new Decimal(p.reorderLevel).toString(),
      })),
    };

    const pptxBuffer = await generateAnalysisDeck(deckData);

    // Save to temp file
    const dir = ensureTempDir();
    const filename = `analysis_${deckData.period.from}_to_${deckData.period.to}.pptx`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, pptxBuffer);

    logger.info('Analysis deck generated', { filepath, size: pptxBuffer.length });

    return toolSuccess({
      filePath: filepath,
      fileName: filename,
      period: deckData.period,
      size: pptxBuffer.length,
      message: `Analysis deck generated for ${deckData.period.from} to ${deckData.period.to}.`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}
