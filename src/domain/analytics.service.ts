import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import { Decimal } from 'decimal.js';

export interface DailySalesReport {
  date: string;
  totalSales: number; // paise
  totalTax: number;
  totalCgst: number;
  totalSgst: number;
  cashSales: number;
  upiSales: number;
  cardSales: number;
  creditSales: number;
  billCount: number;
  topItems: Array<{ name: string; quantity: string; revenue: number }>;
  paymentBreakdown: Record<string, number>;
}

/**
 * Get sales summary for a given date.
 */
export async function getDailySales(date?: Date): Promise<DailySalesReport> {
  const targetDate = date || new Date();
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  const bills = await prisma.bill.findMany({
    where: {
      status: 'FINALIZED',
      finalizedAt: {
        gte: startOfDay,
        lte: endOfDay,
      },
    },
    include: {
      items: true,
    },
  });

  let totalSales = 0;
  let totalTax = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let cashSales = 0;
  let upiSales = 0;
  let cardSales = 0;
  let creditSales = 0;

  const itemSales: Record<string, { name: string; quantity: Decimal; revenue: number }> = {};

  for (const bill of bills) {
    totalSales += bill.grandTotal;
    totalTax += bill.totalTax;
    totalCgst += bill.totalCgst;
    totalSgst += bill.totalSgst;

    switch (bill.paymentMethod) {
      case 'CASH':
        cashSales += bill.grandTotal;
        break;
      case 'UPI':
        upiSales += bill.grandTotal;
        break;
      case 'CARD':
        cardSales += bill.grandTotal;
        break;
      case 'CREDIT':
        creditSales += bill.grandTotal;
        break;
    }

    for (const item of bill.items) {
      const key = item.productId;
      if (!itemSales[key]) {
        itemSales[key] = { name: item.productName, quantity: new Decimal(0), revenue: 0 };
      }
      itemSales[key]!.quantity = itemSales[key]!.quantity.plus(item.quantity);
      itemSales[key]!.revenue += item.lineTotal;
    }
  }

  const topItems = Object.values(itemSales)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map(item => ({
      name: item.name,
      quantity: item.quantity.toString(),
      revenue: item.revenue,
    }));

  const report: DailySalesReport = {
    date: startOfDay.toISOString().split('T')[0]!,
    totalSales,
    totalTax,
    totalCgst,
    totalSgst,
    cashSales,
    upiSales,
    cardSales,
    creditSales,
    billCount: bills.length,
    topItems,
    paymentBreakdown: {
      cash: cashSales,
      upi: upiSales,
      card: cardSales,
      credit: creditSales,
    },
  };

  logger.info('Daily sales report generated', {
    date: report.date,
    totalSales,
    billCount: bills.length,
  });

  return report;
}

/**
 * Get sales data for a date range (for analysis decks).
 */
export async function getSalesRange(startDate: Date, endDate: Date): Promise<{
  dailySales: Array<{ date: string; total: number; billCount: number }>;
  totalRevenue: number;
  totalTax: number;
  totalBills: number;
  topProducts: Array<{ name: string; quantity: string; revenue: number }>;
  paymentDistribution: Record<string, number>;
  gstCollected: { cgst: number; sgst: number; total: number };
}> {
  const bills = await prisma.bill.findMany({
    where: {
      status: 'FINALIZED',
      finalizedAt: {
        gte: startDate,
        lte: endDate,
      },
    },
    include: { items: true },
    orderBy: { finalizedAt: 'asc' },
  });

  const dailyMap: Record<string, { total: number; billCount: number }> = {};
  const productMap: Record<string, { name: string; quantity: Decimal; revenue: number }> = {};
  const paymentDist: Record<string, number> = { cash: 0, upi: 0, card: 0, credit: 0 };

  let totalRevenue = 0;
  let totalTax = 0;
  let totalCgst = 0;
  let totalSgst = 0;

  for (const bill of bills) {
    const dateKey = bill.finalizedAt!.toISOString().split('T')[0]!;

    if (!dailyMap[dateKey]) {
      dailyMap[dateKey] = { total: 0, billCount: 0 };
    }
    dailyMap[dateKey]!.total += bill.grandTotal;
    dailyMap[dateKey]!.billCount += 1;

    totalRevenue += bill.grandTotal;
    totalTax += bill.totalTax;
    totalCgst += bill.totalCgst;
    totalSgst += bill.totalSgst;

    const method = (bill.paymentMethod || 'cash').toLowerCase();
    paymentDist[method] = (paymentDist[method] || 0) + bill.grandTotal;

    for (const item of bill.items) {
      if (!productMap[item.productId]) {
        productMap[item.productId] = { name: item.productName, quantity: new Decimal(0), revenue: 0 };
      }
      productMap[item.productId]!.quantity = productMap[item.productId]!.quantity.plus(item.quantity);
      productMap[item.productId]!.revenue += item.lineTotal;
    }
  }

  return {
    dailySales: Object.entries(dailyMap)
      .map(([date, data]) => ({ date, total: data.total, billCount: data.billCount }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    totalRevenue,
    totalTax,
    totalBills: bills.length,
    topProducts: Object.values(productMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map(p => ({ name: p.name, quantity: p.quantity.toString(), revenue: p.revenue })),
    paymentDistribution: paymentDist,
    gstCollected: { cgst: totalCgst, sgst: totalSgst, total: totalTax },
  };
}

/**
 * Close the day — generates and stores a daily summary.
 */
export async function closeDay(telegramUserId: string, date?: Date): Promise<DailySalesReport> {
  const report = await getDailySales(date);

  const targetDate = date || new Date();
  const dateOnly = new Date(targetDate);
  dateOnly.setHours(0, 0, 0, 0);

  // Upsert daily summary
  await prisma.dailySummary.upsert({
    where: { date: dateOnly },
    update: {
      totalSales: report.totalSales,
      totalTax: report.totalTax,
      totalCgst: report.totalCgst,
      totalSgst: report.totalSgst,
      cashSales: report.cashSales,
      upiSales: report.upiSales,
      cardSales: report.cardSales,
      creditSales: report.creditSales,
      billCount: report.billCount,
    },
    create: {
      date: dateOnly,
      telegramUserId,
      totalSales: report.totalSales,
      totalTax: report.totalTax,
      totalCgst: report.totalCgst,
      totalSgst: report.totalSgst,
      cashSales: report.cashSales,
      upiSales: report.upiSales,
      cardSales: report.cardSales,
      creditSales: report.creditSales,
      billCount: report.billCount,
    },
  });

  logger.info('Day closed', { date: report.date, totalSales: report.totalSales });
  return report;
}
