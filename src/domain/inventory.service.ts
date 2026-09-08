import { prisma } from '../db/client';
import { Decimal } from 'decimal.js';
import { DomainError, withRetry } from '../utils/errors';
import { logger } from '../utils/logger';
import type { Product, Unit, UnitType } from '@prisma/client';

export interface AddProductInput {
  name: string;
  sku?: string;
  unit: Unit;
  unitType: UnitType;
  costPrice: number; // in paise
  sellPrice: number; // in paise
  mrp: number; // in paise
  quantity?: number;
  reorderLevel?: number;
  gstRate: number; // percentage e.g. 5, 12, 18
  hsnCode: string;
}

export interface ReceiveStockInput {
  productId: string;
  quantity: number;
  costPrice?: number; // in paise, updates cost if provided
  mrp?: number; // in paise, updates MRP if provided
  notes?: string;
}

/**
 * Search products by name (fuzzy / case-insensitive).
 */
export async function searchProducts(query: string): Promise<Product[]> {
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      name: {
        contains: query,
        mode: 'insensitive',
      },
    },
    orderBy: { name: 'asc' },
    take: 20,
  });

  logger.info('Product search', { query, resultCount: products.length });
  return products;
}

/**
 * Get a single product by ID.
 */
export async function getProduct(productId: string): Promise<Product> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!product || !product.isActive) {
    throw new DomainError('PRODUCT_NOT_FOUND', `Product not found: ${productId}`, { productId });
  }

  return product;
}

/**
 * Get product by SKU.
 */
export async function getProductBySku(sku: string): Promise<Product | null> {
  return prisma.product.findUnique({
    where: { sku },
  });
}

/**
 * Add a new product. Generates a SKU if not provided.
 */
export async function addProduct(input: AddProductInput): Promise<Product> {
  // Check for duplicate name
  const existing = await prisma.product.findFirst({
    where: { name: { equals: input.name, mode: 'insensitive' }, isActive: true },
  });

  if (existing) {
    throw new DomainError('DUPLICATE_PRODUCT', `Product "${input.name}" already exists`, {
      existingProduct: { id: existing.id, name: existing.name },
    });
  }

  // Validate: sell price must be >= cost price
  if (input.sellPrice < input.costPrice) {
    throw new DomainError('BELOW_COST_PRICE', 'Sell price cannot be less than cost price', {
      costPrice: input.costPrice,
      sellPrice: input.sellPrice,
    });
  }

  // Generate SKU if not provided
  const sku = input.sku || generateSku(input.name);

  const product = await prisma.product.create({
    data: {
      sku,
      name: input.name,
      unit: input.unit,
      unitType: input.unitType,
      costPrice: input.costPrice,
      sellPrice: input.sellPrice,
      mrp: input.mrp,
      quantity: input.quantity ?? 0,
      reorderLevel: input.reorderLevel ?? 10,
      gstRate: input.gstRate,
      hsnCode: input.hsnCode,
    },
  });

  // Log initial stock if quantity provided
  if (input.quantity && input.quantity > 0) {
    await prisma.inventoryHistory.create({
      data: {
        productId: product.id,
        changeType: 'STOCK_IN',
        quantity: input.quantity,
        reference: 'INITIAL_STOCK',
        notes: 'Initial stock on product creation',
      },
    });
  }

  logger.info('Product created', { productId: product.id, name: product.name, sku: product.sku });
  return product;
}

/**
 * Receive stock — atomic increment with history tracking.
 * Optionally updates cost price and MRP.
 */
export async function receiveStock(input: ReceiveStockInput): Promise<Product> {
  if (input.quantity <= 0) {
    throw new DomainError('INVALID_QUANTITY', 'Stock quantity must be positive', {
      quantity: input.quantity,
    });
  }

  const result = await withRetry(async () => {
    return prisma.$transaction(async (tx) => {
      // Row-level lock to coordinate concurrent updates
      const products = await tx.$queryRaw<Product[]>`
        SELECT * FROM "Product" WHERE "id" = ${input.productId} FOR UPDATE
      `;
      const product = products[0];

      if (!product || !product.isActive) {
        throw new DomainError('PRODUCT_NOT_FOUND', 'Product not found', { productId: input.productId });
      }

      // Build update data
      const updateData: Record<string, unknown> = {
        quantity: { increment: input.quantity },
      };

      if (input.costPrice !== undefined) {
        updateData['costPrice'] = input.costPrice;
      }
      if (input.mrp !== undefined) {
        updateData['mrp'] = input.mrp;
        // Also update sell price to new MRP unless sell price is explicitly different
        updateData['sellPrice'] = input.mrp;
      }

      const updated = await tx.product.update({
        where: { id: input.productId },
        data: updateData,
      });

      // Record inventory history
      await tx.inventoryHistory.create({
        data: {
          productId: input.productId,
          changeType: 'STOCK_IN',
          quantity: input.quantity,
          notes: input.notes || `Received ${input.quantity} units`,
        },
      });

      return updated;
    });
  });

  logger.info('Stock received', {
    productId: input.productId,
    quantity: input.quantity,
    newQuantity: result.quantity.toString(),
  });

  return result;
}

/**
 * Get current stock for a product.
 */
export async function getStock(productId: string): Promise<{ product: Product; quantity: string }> {
  const product = await getProduct(productId);
  return { product, quantity: product.quantity.toString() };
}

/**
 * Get all products below their reorder level.
 */
export async function getLowStock(): Promise<Product[]> {
  // Prisma doesn't support comparing two fields directly,
  // so we use raw query
  const products = await prisma.$queryRaw<Product[]>`
    SELECT * FROM "Product"
    WHERE "isActive" = true
    AND "quantity" <= "reorderLevel"
    ORDER BY "quantity" ASC
  `;

  logger.info('Low stock query', { count: products.length });
  return products;
}

/**
 * Get inventory history for a product.
 */
export async function getInventoryHistory(productId: string, limit: number = 20) {
  return prisma.inventoryHistory.findMany({
    where: { productId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { product: { select: { name: true, unit: true } } },
  });
}

/**
 * Atomically decrement stock. Returns false if insufficient stock.
 * Uses conditional update to prevent negative stock.
 * This is called ONLY during bill finalization, not during draft building.
 */
export async function decrementStock(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  productId: string,
  quantity: Decimal | number
): Promise<boolean> {
  const qty = new Decimal(quantity);

  // Atomic conditional update: only succeeds if stock >= requested quantity
  // Uses row-level locking via the WHERE clause
  const result = await tx.$executeRaw`
    UPDATE "Product"
    SET "quantity" = "quantity" - ${qty}::decimal,
        "updatedAt" = NOW()
    WHERE "id" = ${productId}
    AND "isActive" = true
    AND "quantity" >= ${qty}::decimal
  `;

  if (result === 0) {
    return false; // Insufficient stock or product not found
  }

  // Record history
  await tx.inventoryHistory.create({
    data: {
      productId,
      changeType: 'SALE',
      quantity: qty.toNumber(),
      notes: `Stock decremented by ${qty}`,
    },
  });

  return true;
}

/**
 * Get all active products.
 */
export async function getAllProducts(): Promise<Product[]> {
  return prisma.product.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function generateSku(name: string): string {
  const prefix = name
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .map(w => w.substring(0, 3).toUpperCase())
    .join('')
    .substring(0, 8);

  const suffix = Date.now().toString(36).substring(-4).toUpperCase();
  return `${prefix}-${suffix}`;
}
