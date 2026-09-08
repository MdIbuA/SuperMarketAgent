import { logger } from '../utils/logger';
import type { ToolResult } from '../utils/errors';

// Import all tool schemas and executors
import * as inventoryTools from './inventory.tools';
import * as billingTools from './billing.tools';
import * as khataTools from './khata.tools';
import * as analyticsTools from './analytics.tools';
import * as preferencesTools from './preferences.tools';
import * as documentsTools from './documents.tools';

/**
 * All tool definitions for Claude's tool-calling API.
 */
export const ALL_TOOLS = [
  // Inventory
  inventoryTools.searchProductsSchema,
  inventoryTools.getProductSchema,
  inventoryTools.addProductSchema,
  inventoryTools.receiveStockSchema,
  inventoryTools.getStockSchema,
  inventoryTools.getLowStockSchema,
  inventoryTools.getInventoryHistorySchema,

  // Billing
  billingTools.createBillSchema,
  billingTools.getCurrentBillSchema,
  billingTools.addBillItemSchema,
  billingTools.updateBillItemSchema,
  billingTools.removeBillItemSchema,
  billingTools.removeBillItemByNameSchema,
  billingTools.setPaymentMethodSchema,
  billingTools.finalizeBillSchema,
  billingTools.cancelBillSchema,
  billingTools.getBillSchema,

  // Khata
  khataTools.addCreditSchema,
  khataTools.recordPaymentSchema,
  khataTools.getBalanceSchema,
  khataTools.getKhataHistorySchema,
  khataTools.getOutstandingBalancesSchema,

  // Analytics
  analyticsTools.getDailySalesSchema,
  analyticsTools.closeDaySchema,
  analyticsTools.getSalesRangeSchema,

  // Preferences
  preferencesTools.getPreferencesSchema,
  preferencesTools.setPreferenceSchema,
  preferencesTools.resetPreferenceSchema,

  // Documents
  documentsTools.generateInvoicePDFSchema,
  documentsTools.generateAnalysisDeckSchema,
];

/**
 * Execute a tool by name. This is the single dispatch point for the agent.
 * No regex routing, no intent classification — Claude decides which tool to call.
 */
export async function executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  logger.info('Executing tool', { tool: toolName, args });

  try {
    switch (toolName) {
      // Inventory
      case 'search_products':
        return await inventoryTools.executeSearchProducts(args as any);
      case 'get_product':
        return await inventoryTools.executeGetProduct(args as any);
      case 'add_product':
        return await inventoryTools.executeAddProduct(args as any);
      case 'receive_stock':
        return await inventoryTools.executeReceiveStock(args as any);
      case 'get_stock':
        return await inventoryTools.executeGetStock(args as any);
      case 'get_low_stock':
        return await inventoryTools.executeGetLowStock();
      case 'get_inventory_history':
        return await inventoryTools.executeGetInventoryHistory(args as any);

      // Billing
      case 'create_bill':
        return await billingTools.executeCreateBill(args as any);
      case 'get_current_bill':
        return await billingTools.executeGetCurrentBill(args as any);
      case 'add_bill_item':
        return await billingTools.executeAddBillItem(args as any);
      case 'update_bill_item':
        return await billingTools.executeUpdateBillItem(args as any);
      case 'remove_bill_item':
        return await billingTools.executeRemoveBillItem(args as any);
      case 'remove_bill_item_by_name':
        return await billingTools.executeRemoveBillItemByName(args as any);
      case 'set_payment_method':
        return await billingTools.executeSetPaymentMethod(args as any);
      case 'finalize_bill':
        return await billingTools.executeFinalizeBill(args as any);
      case 'cancel_bill':
        return await billingTools.executeCancelBill(args as any);
      case 'get_bill':
        return await billingTools.executeGetBill(args as any);

      // Khata
      case 'add_khata_credit':
        return await khataTools.executeAddCredit(args as any);
      case 'record_khata_payment':
        return await khataTools.executeRecordPayment(args as any);
      case 'get_khata_balance':
        return await khataTools.executeGetBalance(args as any);
      case 'get_khata_history':
        return await khataTools.executeGetKhataHistory(args as any);
      case 'get_all_outstanding_balances':
        return await khataTools.executeGetOutstandingBalances(args as any);

      // Analytics
      case 'get_daily_sales':
        return await analyticsTools.executeGetDailySales(args as any);
      case 'close_day':
        return await analyticsTools.executeCloseDay(args as any);
      case 'get_sales_range':
        return await analyticsTools.executeGetSalesRange(args as any);

      // Preferences
      case 'get_owner_preferences':
        return await preferencesTools.executeGetPreferences(args as any);
      case 'set_owner_preference':
        return await preferencesTools.executeSetPreference(args as any);
      case 'reset_owner_preference':
        return await preferencesTools.executeResetPreference(args as any);

      // Documents
      case 'generate_invoice_pdf':
        return await documentsTools.executeGenerateInvoicePDF(args as any);
      case 'generate_analysis_deck':
        return await documentsTools.executeGenerateAnalysisDeck(args as any);

      default:
        return {
          success: false,
          errorCode: 'VALIDATION_ERROR',
          message: `Unknown tool: ${toolName}`,
          details: { toolName },
        };
    }
  } catch (error: any) {
    logger.error('Tool execution error', { tool: toolName, error: error.message, stack: error.stack });
    return {
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: `Tool execution failed: ${error.message}`,
      details: { tool: toolName },
    };
  }
}
