import PDFDocument from 'pdfkit';
import { paiseToRupees } from '../utils/money';
import { Decimal } from 'decimal.js';
import { logger } from '../utils/logger';
import * as preferencesService from '../domain/preferences.service';
import type { BillItem } from '@prisma/client';

interface InvoiceData {
  billNumber: string;
  date: string;
  items: Array<{
    productName: string;
    hsnCode: string;
    quantity: string;
    unit: string;
    unitPrice: number; // paise
    taxableValue: number; // paise
    gstRate: string;
    cgst: number; // paise
    sgst: number; // paise
    lineTotal: number; // paise
  }>;
  subtotal: number; // paise
  totalCgst: number; // paise
  totalSgst: number; // paise
  totalTax: number; // paise
  grandTotal: number; // paise
  paymentMethod: string;
  paymentRef?: string | null;
  customerName?: string;
}

interface ShopInfo {
  name: string;
  address: string;
  phone: string;
  gstin: string;
}

/**
 * Generate a real PDF invoice and return it as a Buffer.
 */
export async function generateInvoicePDF(
  data: InvoiceData,
  telegramUserId: string
): Promise<Buffer> {
  // Load shop preferences
  const prefs = await preferencesService.getOwnerPreferences(telegramUserId);
  const shop: ShopInfo = {
    name: prefs['shop_name'] || 'My Kirana Store',
    address: prefs['shop_address'] || 'Shop Address',
    phone: prefs['shop_phone'] || '',
    gstin: prefs['shop_gstin'] || 'Not Registered',
  };

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const buffers: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const pageWidth = doc.page.width - 80; // margins

      // ── Header ──
      doc.fontSize(18).font('Helvetica-Bold').text(shop.name, { align: 'center' });
      doc.fontSize(9).font('Helvetica').text(shop.address, { align: 'center' });
      if (shop.phone) doc.text(`Phone: ${shop.phone}`, { align: 'center' });
      doc.text(`GSTIN: ${shop.gstin}`, { align: 'center' });

      doc.moveDown(0.5);
      doc.moveTo(40, doc.y).lineTo(40 + pageWidth, doc.y).stroke();
      doc.moveDown(0.3);

      // ── Tax Invoice Title ──
      doc.fontSize(14).font('Helvetica-Bold').text('TAX INVOICE', { align: 'center' });
      doc.moveDown(0.3);

      // ── Invoice Details ──
      doc.fontSize(9).font('Helvetica');
      const detailsY = doc.y;
      doc.text(`Invoice No: ${data.billNumber}`, 40, detailsY);
      doc.text(`Date: ${data.date}`, 40 + pageWidth / 2, detailsY, { align: 'right', width: pageWidth / 2 });
      doc.moveDown(0.2);
      if (data.customerName) {
        doc.text(`Customer: ${data.customerName}`);
      }
      doc.text(`Payment: ${data.paymentMethod}${data.paymentRef ? ` (Ref: ${data.paymentRef})` : ''}`);

      doc.moveDown(0.5);
      doc.moveTo(40, doc.y).lineTo(40 + pageWidth, doc.y).stroke();
      doc.moveDown(0.3);

      // ── Table Header ──
      const cols = {
        sno: { x: 40, w: 25 },
        item: { x: 65, w: 120 },
        hsn: { x: 185, w: 55 },
        qty: { x: 240, w: 40 },
        rate: { x: 280, w: 55 },
        taxable: { x: 335, w: 55 },
        gst: { x: 390, w: 35 },
        cgst: { x: 425, w: 45 },
        sgst: { x: 470, w: 45 },
        total: { x: 515, w: 45 },
      };

      doc.fontSize(7.5).font('Helvetica-Bold');
      const headerY = doc.y;
      doc.text('#', cols.sno.x, headerY, { width: cols.sno.w });
      doc.text('Item', cols.item.x, headerY, { width: cols.item.w });
      doc.text('HSN', cols.hsn.x, headerY, { width: cols.hsn.w });
      doc.text('Qty', cols.qty.x, headerY, { width: cols.qty.w, align: 'right' });
      doc.text('Rate', cols.rate.x, headerY, { width: cols.rate.w, align: 'right' });
      doc.text('Taxable', cols.taxable.x, headerY, { width: cols.taxable.w, align: 'right' });
      doc.text('GST%', cols.gst.x, headerY, { width: cols.gst.w, align: 'right' });
      doc.text('CGST', cols.cgst.x, headerY, { width: cols.cgst.w, align: 'right' });
      doc.text('SGST', cols.sgst.x, headerY, { width: cols.sgst.w, align: 'right' });
      doc.text('Total', cols.total.x, headerY, { width: cols.total.w, align: 'right' });

      doc.moveDown(0.3);
      doc.moveTo(40, doc.y).lineTo(40 + pageWidth, doc.y).stroke();
      doc.moveDown(0.2);

      // ── Table Rows ──
      doc.font('Helvetica').fontSize(7.5);
      data.items.forEach((item, index) => {
        const rowY = doc.y;
        doc.text(String(index + 1), cols.sno.x, rowY, { width: cols.sno.w });
        doc.text(item.productName, cols.item.x, rowY, { width: cols.item.w });
        doc.text(item.hsnCode, cols.hsn.x, rowY, { width: cols.hsn.w });
        doc.text(`${item.quantity} ${item.unit}`, cols.qty.x, rowY, { width: cols.qty.w, align: 'right' });
        doc.text(paiseToRupees(item.unitPrice), cols.rate.x, rowY, { width: cols.rate.w, align: 'right' });
        doc.text(paiseToRupees(item.taxableValue), cols.taxable.x, rowY, { width: cols.taxable.w, align: 'right' });
        doc.text(item.gstRate, cols.gst.x, rowY, { width: cols.gst.w, align: 'right' });
        doc.text(paiseToRupees(item.cgst), cols.cgst.x, rowY, { width: cols.cgst.w, align: 'right' });
        doc.text(paiseToRupees(item.sgst), cols.sgst.x, rowY, { width: cols.sgst.w, align: 'right' });
        doc.text(paiseToRupees(item.lineTotal), cols.total.x, rowY, { width: cols.total.w, align: 'right' });
        doc.moveDown(0.5);
      });

      // ── Totals ──
      doc.moveTo(40, doc.y).lineTo(40 + pageWidth, doc.y).stroke();
      doc.moveDown(0.3);

      doc.font('Helvetica').fontSize(9);
      const totalsX = 380;
      const totalsValueX = 480;
      const totalsW = 80;

      doc.text('Subtotal:', totalsX, doc.y, { continued: false });
      doc.text(`Rs. ${paiseToRupees(data.subtotal)}`, totalsValueX, doc.y - 11, { width: totalsW, align: 'right' });
      doc.moveDown(0.2);

      doc.text('CGST:', totalsX, doc.y);
      doc.text(`Rs. ${paiseToRupees(data.totalCgst)}`, totalsValueX, doc.y - 11, { width: totalsW, align: 'right' });
      doc.moveDown(0.2);

      doc.text('SGST:', totalsX, doc.y);
      doc.text(`Rs. ${paiseToRupees(data.totalSgst)}`, totalsValueX, doc.y - 11, { width: totalsW, align: 'right' });
      doc.moveDown(0.2);

      doc.font('Helvetica-Bold').fontSize(11);
      doc.text('Grand Total:', totalsX, doc.y);
      doc.text(`Rs. ${paiseToRupees(data.grandTotal)}`, totalsValueX, doc.y - 13, { width: totalsW, align: 'right' });

      doc.moveDown(1.5);
      doc.moveTo(40, doc.y).lineTo(40 + pageWidth, doc.y).stroke();
      doc.moveDown(0.5);

      // ── Footer ──
      doc.fontSize(8).font('Helvetica').fillColor('#666666');
      doc.text('Thank you for your purchase!', { align: 'center' });
      doc.text('This is a computer-generated invoice.', { align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
