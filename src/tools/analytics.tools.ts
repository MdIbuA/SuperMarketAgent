import * as analyticsService from '../domain/analytics.service';
import { DomainError, toolSuccess, type ToolResult } from '../utils/errors';
import { paiseToRupees } from '../utils/money';

// ─── Tool Schemas ───────────────────────────────────────────────────

export const getDailySalesSchema = {
  name: 'get_daily_sales',
  description: 'Get today\'s sales summary — total revenue, tax collected, payment breakdown, and top-selling items. Use this for "today\'s sales?" type queries.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'Date in YYYY-MM-DD format (defaults to today)' },
    },
    required: [],
  },
};

export const closeDaySchema = {
  name: 'close_day',
  description: 'Close the day — generates and stores a comprehensive daily summary. Use this for "close the day" type requests.',
  input_schema: {
    type: 'object' as const,
    properties: {
      telegramUserId: { type: 'string', description: 'Telegram user ID' },
      date: { type: 'string', description: 'Date to close (defaults to today)' },
    },
    required: ['telegramUserId'],
  },
};

export const getSalesRangeSchema = {
  name: 'get_sales_range',
  description: 'Get sales analytics for a date range. Includes daily breakdown, top products, payment distribution, and GST collected. Use this for weekly/monthly analysis.',
  input_schema: {
    type: 'object' as const,
    properties: {
      startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
      endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
    },
    required: ['startDate', 'endDate'],
  },
};

// ─── Tool Implementations ───────────────────────────────────────────

function formatSalesReport(report: analyticsService.DailySalesReport) {
  return {
    date: report.date,
    totalSales: paiseToRupees(report.totalSales),
    totalTax: paiseToRupees(report.totalTax),
    totalCgst: paiseToRupees(report.totalCgst),
    totalSgst: paiseToRupees(report.totalSgst),
    billCount: report.billCount,
    paymentBreakdown: {
      cash: paiseToRupees(report.cashSales),
      upi: paiseToRupees(report.upiSales),
      card: paiseToRupees(report.cardSales),
      credit: paiseToRupees(report.creditSales),
    },
    topItems: report.topItems.map(item => ({
      name: item.name,
      quantity: item.quantity,
      revenue: paiseToRupees(item.revenue),
    })),
  };
}

export async function executeGetDailySales(args: { date?: string }): Promise<ToolResult> {
  try {
    const date = args.date ? new Date(args.date) : undefined;
    const report = await analyticsService.getDailySales(date);
    return toolSuccess({
      report: formatSalesReport(report),
      message: report.billCount === 0
        ? `No sales recorded for ${report.date}.`
        : `${report.date}: ${report.billCount} bills, Total: ₹${paiseToRupees(report.totalSales)}, Tax: ₹${paiseToRupees(report.totalTax)}`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeCloseDay(args: { telegramUserId: string; date?: string }): Promise<ToolResult> {
  try {
    const date = args.date ? new Date(args.date) : undefined;
    const report = await analyticsService.closeDay(args.telegramUserId, date);
    return toolSuccess({
      report: formatSalesReport(report),
      message: `Day closed for ${report.date}. Total: ₹${paiseToRupees(report.totalSales)}, ${report.billCount} bills.`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGetSalesRange(args: { startDate: string; endDate: string }): Promise<ToolResult> {
  try {
    const data = await analyticsService.getSalesRange(
      new Date(args.startDate),
      new Date(args.endDate)
    );

    return toolSuccess({
      period: { from: args.startDate, to: args.endDate },
      totalRevenue: paiseToRupees(data.totalRevenue),
      totalTax: paiseToRupees(data.totalTax),
      totalBills: data.totalBills,
      gstCollected: {
        cgst: paiseToRupees(data.gstCollected.cgst),
        sgst: paiseToRupees(data.gstCollected.sgst),
        total: paiseToRupees(data.gstCollected.total),
      },
      dailySales: data.dailySales.map(d => ({
        date: d.date,
        total: paiseToRupees(d.total),
        billCount: d.billCount,
      })),
      topProducts: data.topProducts.map(p => ({
        name: p.name,
        quantity: p.quantity,
        revenue: paiseToRupees(p.revenue),
      })),
      paymentDistribution: Object.fromEntries(
        Object.entries(data.paymentDistribution).map(([k, v]) => [k, paiseToRupees(v)])
      ),
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}
