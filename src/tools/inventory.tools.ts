import { z } from 'zod';
import * as inventoryService from '../domain/inventory.service';
import { DomainError, toolSuccess, toolFailure, type ToolResult } from '../utils/errors';
import { formatPaise, paiseToRupees, rupeesToPaise } from '../utils/money';
import { Decimal } from 'decimal.js';
import type { Unit, UnitType } from '@prisma/client';

// ─── Tool Schemas (for Claude tool definitions) ─────────────────────

export const searchProductsSchema = {
  name: 'search_products',
  description: 'Search for products by name. Use this to find products before any operation. Returns matching products with their stock, prices, and GST info.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search query — product name or partial name (e.g., "maggi", "butter", "atta", "sugar")',
      },
    },
    required: ['query'],
  },
};

export const getProductSchema = {
  name: 'get_product',
  description: 'Get detailed information about a specific product by its ID.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productId: {
        type: 'string',
        description: 'The product ID',
      },
    },
    required: ['productId'],
  },
};

export const addProductSchema = {
  name: 'add_product',
  description: 'Add a new product to inventory. Requires name, unit, cost price, sell price, MRP, GST rate, and HSN code. Prices should be in rupees (e.g., 14 for ₹14).',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Product name (e.g., "Amul Butter 100g")' },
      unit: { type: 'string', enum: ['KG', 'G', 'LITRE', 'ML', 'PACKET', 'DOZEN', 'PIECE'], description: 'Unit of measurement' },
      unitType: { type: 'string', enum: ['LOOSE', 'PACKAGED'], description: 'Whether the product is loose or packaged' },
      costPrice: { type: 'number', description: 'Cost price in rupees (e.g., 12 for ₹12)' },
      sellPrice: { type: 'number', description: 'Selling price in rupees' },
      mrp: { type: 'number', description: 'Maximum retail price in rupees' },
      quantity: { type: 'number', description: 'Initial quantity in stock' },
      reorderLevel: { type: 'number', description: 'Stock level at which to reorder (default 10)' },
      gstRate: { type: 'number', description: 'GST rate as percentage (0, 5, 12, or 18)' },
      hsnCode: { type: 'string', description: 'HSN code for the product' },
    },
    required: ['name', 'unit', 'unitType', 'costPrice', 'sellPrice', 'mrp', 'gstRate', 'hsnCode'],
  },
};

export const receiveStockSchema = {
  name: 'receive_stock',
  description: 'Receive stock for an existing product. Increases quantity. Optionally updates cost price and MRP. Use search_products first to find the product ID.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productId: { type: 'string', description: 'Product ID (use search_products to find this)' },
      quantity: { type: 'number', description: 'Quantity being received' },
      costPrice: { type: 'number', description: 'New cost price in rupees (optional — updates if provided)' },
      mrp: { type: 'number', description: 'New MRP in rupees (optional — updates if provided)' },
      notes: { type: 'string', description: 'Notes about this stock receipt' },
    },
    required: ['productId', 'quantity'],
  },
};

export const getStockSchema = {
  name: 'get_stock',
  description: 'Get current stock level for a specific product.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productId: { type: 'string', description: 'Product ID' },
    },
    required: ['productId'],
  },
};

export const getLowStockSchema = {
  name: 'get_low_stock',
  description: 'Get all products that are below their reorder level. Use this for "what\'s running out?" queries.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

export const getInventoryHistorySchema = {
  name: 'get_inventory_history',
  description: 'Get the recent inventory change history for a product.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productId: { type: 'string', description: 'Product ID' },
      limit: { type: 'number', description: 'Max entries to return (default 20)' },
    },
    required: ['productId'],
  },
};

// ─── Tool Implementations ───────────────────────────────────────────

function formatProduct(product: any) {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.unit,
    unitType: product.unitType,
    costPrice: paiseToRupees(product.costPrice),
    sellPrice: paiseToRupees(product.sellPrice),
    mrp: paiseToRupees(product.mrp),
    quantity: new Decimal(product.quantity).toString(),
    reorderLevel: new Decimal(product.reorderLevel).toString(),
    gstRate: new Decimal(product.gstRate).toString() + '%',
    hsnCode: product.hsnCode,
  };
}

export async function executeSearchProducts(args: { query: string }): Promise<ToolResult> {
  try {
    const products = await inventoryService.searchProducts(args.query);
    return toolSuccess({
      products: products.map(formatProduct),
      count: products.length,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGetProduct(args: { productId: string }): Promise<ToolResult> {
  try {
    const product = await inventoryService.getProduct(args.productId);
    return toolSuccess({ product: formatProduct(product) });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeAddProduct(args: {
  name: string;
  unit: string;
  unitType: string;
  costPrice: number;
  sellPrice: number;
  mrp: number;
  quantity?: number;
  reorderLevel?: number;
  gstRate: number;
  hsnCode: string;
}): Promise<ToolResult> {
  try {
    const product = await inventoryService.addProduct({
      name: args.name,
      unit: args.unit as Unit,
      unitType: args.unitType as UnitType,
      costPrice: rupeesToPaise(args.costPrice),
      sellPrice: rupeesToPaise(args.sellPrice),
      mrp: rupeesToPaise(args.mrp),
      quantity: args.quantity,
      reorderLevel: args.reorderLevel,
      gstRate: args.gstRate,
      hsnCode: args.hsnCode,
    });
    return toolSuccess({ product: formatProduct(product), message: `Product "${product.name}" added successfully.` });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeReceiveStock(args: {
  productId: string;
  quantity: number;
  costPrice?: number;
  mrp?: number;
  notes?: string;
}): Promise<ToolResult> {
  try {
    const product = await inventoryService.receiveStock({
      productId: args.productId,
      quantity: args.quantity,
      costPrice: args.costPrice ? rupeesToPaise(args.costPrice) : undefined,
      mrp: args.mrp ? rupeesToPaise(args.mrp) : undefined,
      notes: args.notes,
    });
    return toolSuccess({
      product: formatProduct(product),
      message: `Received ${args.quantity} units of ${product.name}. New stock: ${product.quantity}`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGetStock(args: { productId: string }): Promise<ToolResult> {
  try {
    const { product, quantity } = await inventoryService.getStock(args.productId);
    return toolSuccess({
      product: formatProduct(product),
      quantity,
      unit: product.unit.toLowerCase(),
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGetLowStock(): Promise<ToolResult> {
  try {
    const products = await inventoryService.getLowStock();
    return toolSuccess({
      products: products.map(p => ({
        ...formatProduct(p),
        belowReorderBy: new Decimal(p.reorderLevel).minus(p.quantity).toString(),
      })),
      count: products.length,
      message: products.length === 0
        ? 'All products are above reorder levels.'
        : `${products.length} product(s) need restocking.`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeGetInventoryHistory(args: { productId: string; limit?: number }): Promise<ToolResult> {
  try {
    const history = await inventoryService.getInventoryHistory(args.productId, args.limit);
    return toolSuccess({
      history: history.map(h => ({
        type: h.changeType,
        quantity: new Decimal(h.quantity).toString(),
        notes: h.notes,
        date: h.createdAt.toISOString(),
        productName: h.product.name,
      })),
      count: history.length,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}
