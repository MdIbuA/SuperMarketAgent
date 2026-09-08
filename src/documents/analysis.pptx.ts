import PptxGenJS from 'pptxgenjs';
import { paiseToRupees } from '../utils/money';
import { logger } from '../utils/logger';

interface AnalysisDeckData {
  period: { from: string; to: string };
  totalRevenue: number; // paise
  totalTax: number;
  totalBills: number;
  dailySales: Array<{ date: string; total: number; billCount: number }>;
  topProducts: Array<{ name: string; quantity: string; revenue: number }>;
  paymentDistribution: Record<string, number>;
  gstCollected: { cgst: number; sgst: number; total: number };
  lowStockProducts?: Array<{ name: string; quantity: string; reorderLevel: string }>;
}

/**
 * Generate a real PPTX analysis deck with charts.
 */
export async function generateAnalysisDeck(data: AnalysisDeckData): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'Supermarket Ops Agent';
  pptx.title = `Sales Analysis: ${data.period.from} to ${data.period.to}`;

  // ── Slide 1: Title ──
  const slide1 = pptx.addSlide();
  slide1.background = { fill: '1a1a2e' };
  slide1.addText('Sales Analysis Report', {
    x: 0.5, y: 1.5, w: 9, h: 1.2,
    fontSize: 36, bold: true, color: 'ffffff',
    fontFace: 'Arial',
  });
  slide1.addText(`${data.period.from} to ${data.period.to}`, {
    x: 0.5, y: 2.8, w: 9, h: 0.6,
    fontSize: 18, color: 'cccccc',
    fontFace: 'Arial',
  });
  slide1.addText(
    `Total Revenue: Rs. ${paiseToRupees(data.totalRevenue)}  |  Bills: ${data.totalBills}  |  Tax Collected: Rs. ${paiseToRupees(data.totalTax)}`,
    {
      x: 0.5, y: 4.0, w: 9, h: 0.5,
      fontSize: 14, color: '88ccff',
      fontFace: 'Arial',
    }
  );

  // ── Slide 2: Daily Sales Chart ──
  if (data.dailySales.length > 0) {
    const slide2 = pptx.addSlide();
    slide2.background = { fill: 'ffffff' };
    slide2.addText('Daily Sales Trend', {
      x: 0.5, y: 0.3, w: 9, h: 0.6,
      fontSize: 24, bold: true, color: '1a1a2e',
    });

    const chartData = [{
      name: 'Revenue (Rs.)',
      labels: data.dailySales.map(d => d.date.substring(5)), // MM-DD
      values: data.dailySales.map(d => parseFloat(paiseToRupees(d.total))),
    }];

    slide2.addChart(pptx.ChartType.bar, chartData, {
      x: 0.5, y: 1.2, w: 9, h: 4.0,
      showValue: true,
      catAxisLabelFontSize: 9,
      chartColors: ['3366cc'],
    });
  }

  // ── Slide 3: Top Products ──
  if (data.topProducts.length > 0) {
    const slide3 = pptx.addSlide();
    slide3.background = { fill: 'ffffff' };
    slide3.addText('Top Selling Products', {
      x: 0.5, y: 0.3, w: 9, h: 0.6,
      fontSize: 24, bold: true, color: '1a1a2e',
    });

    const productChartData = [{
      name: 'Revenue (Rs.)',
      labels: data.topProducts.map(p => p.name),
      values: data.topProducts.map(p => parseFloat(paiseToRupees(p.revenue))),
    }];

    slide3.addChart(pptx.ChartType.bar, productChartData, {
      x: 0.5, y: 1.2, w: 9, h: 4.0,
      barDir: 'bar',
      showValue: true,
      catAxisLabelFontSize: 9,
      chartColors: ['27ae60'],
    });
  }

  // ── Slide 4: Payment Distribution ──
  const paymentLabels = Object.keys(data.paymentDistribution).filter(
    k => data.paymentDistribution[k]! > 0
  );
  if (paymentLabels.length > 0) {
    const slide4 = pptx.addSlide();
    slide4.background = { fill: 'ffffff' };
    slide4.addText('Payment Distribution', {
      x: 0.5, y: 0.3, w: 9, h: 0.6,
      fontSize: 24, bold: true, color: '1a1a2e',
    });

    const pieData = [{
      name: 'Payments',
      labels: paymentLabels.map(k => k.toUpperCase()),
      values: paymentLabels.map(k => parseFloat(paiseToRupees(data.paymentDistribution[k]!))),
    }];

    slide4.addChart(pptx.ChartType.pie, pieData, {
      x: 1.5, y: 1.2, w: 7, h: 4.0,
      showPercent: true,
      showLegend: true,
      legendPos: 'b',
      chartColors: ['3366cc', '27ae60', 'e74c3c', 'f39c12'],
    });
  }

  // ── Slide 5: GST Summary ──
  const slide5 = pptx.addSlide();
  slide5.background = { fill: 'ffffff' };
  slide5.addText('GST Collection Summary', {
    x: 0.5, y: 0.3, w: 9, h: 0.6,
    fontSize: 24, bold: true, color: '1a1a2e',
  });

  const gstTableRows: Array<Array<{ text: string; options?: object }>> = [
    [
      { text: 'Component', options: { bold: true, fill: { color: '1a1a2e' }, color: 'ffffff' } },
      { text: 'Amount (Rs.)', options: { bold: true, fill: { color: '1a1a2e' }, color: 'ffffff' } },
    ],
    [{ text: 'CGST' }, { text: paiseToRupees(data.gstCollected.cgst) }],
    [{ text: 'SGST' }, { text: paiseToRupees(data.gstCollected.sgst) }],
    [
      { text: 'Total GST', options: { bold: true } },
      { text: paiseToRupees(data.gstCollected.total), options: { bold: true } },
    ],
  ];

  slide5.addTable(gstTableRows, {
    x: 2.0, y: 1.5, w: 6.0,
    fontSize: 14,
    border: { pt: 1, color: 'cccccc' },
    colW: [3, 3],
    align: 'center',
  });

  // Revenue KPI
  slide5.addText(`Total Revenue: Rs. ${paiseToRupees(data.totalRevenue)}`, {
    x: 2.0, y: 3.8, w: 6, h: 0.5,
    fontSize: 16, bold: true, color: '27ae60', align: 'center',
  });

  // ── Slide 6: Stock Health (if available) ──
  if (data.lowStockProducts && data.lowStockProducts.length > 0) {
    const slide6 = pptx.addSlide();
    slide6.background = { fill: 'ffffff' };
    slide6.addText('Stock Health — Items Below Reorder Level', {
      x: 0.5, y: 0.3, w: 9, h: 0.6,
      fontSize: 24, bold: true, color: 'e74c3c',
    });

    const stockRows: Array<Array<{ text: string; options?: object }>> = [
      [
        { text: 'Product', options: { bold: true, fill: { color: 'e74c3c' }, color: 'ffffff' } },
        { text: 'Current Stock', options: { bold: true, fill: { color: 'e74c3c' }, color: 'ffffff' } },
        { text: 'Reorder Level', options: { bold: true, fill: { color: 'e74c3c' }, color: 'ffffff' } },
      ],
    ];

    for (const p of data.lowStockProducts.slice(0, 10)) {
      stockRows.push([
        { text: p.name },
        { text: p.quantity },
        { text: p.reorderLevel },
      ]);
    }

    slide6.addTable(stockRows, {
      x: 0.5, y: 1.2, w: 9,
      fontSize: 12,
      border: { pt: 1, color: 'cccccc' },
      colW: [4, 2.5, 2.5],
    });
  }

  // Generate
  const output = await pptx.write({ outputType: 'nodebuffer' });
  logger.info('PPTX analysis deck generated', {
    period: data.period,
  });

  return output as Buffer;
}
