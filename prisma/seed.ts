import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed data: realistic Indian kirana store products.
 * 
 * GST rates based on common Indian GST classifications:
 * - 0%: Essential food items (loose grains, fresh produce)
 * - 5%: Packaged food staples (branded atta, sugar, edible oils)
 * - 12%: Processed food, butter, cheese
 * - 18%: Soaps, detergents, FMCG non-food items
 * 
 * HSN codes are representative classifications.
 * All prices in paise (₹1 = 100 paise).
 */
const products = [
  {
    sku: 'AASH-ATTA-5KG',
    name: 'Aashirvaad Atta 5kg',
    unit: 'PACKET' as const,
    unitType: 'PACKAGED' as const,
    costPrice: 27000, // ₹270
    sellPrice: 29500, // ₹295
    mrp: 29500,
    quantity: 25,
    reorderLevel: 10,
    gstRate: 5,
    hsnCode: '1101',
  },
  {
    sku: 'TATA-SALT-1KG',
    name: 'Tata Salt 1kg',
    unit: 'PACKET' as const,
    unitType: 'PACKAGED' as const,
    costPrice: 2000, // ₹20
    sellPrice: 2800, // ₹28
    mrp: 2800,
    quantity: 50,
    reorderLevel: 15,
    gstRate: 5,
    hsnCode: '2501',
  },
  {
    sku: 'AMUL-BUTR-100G',
    name: 'Amul Butter 100g',
    unit: 'PACKET' as const,
    unitType: 'PACKAGED' as const,
    costPrice: 5200, // ₹52
    sellPrice: 6200, // ₹62
    mrp: 6200,
    quantity: 30,
    reorderLevel: 10,
    gstRate: 12,
    hsnCode: '0405',
  },
  {
    sku: 'FORT-OIL-1L',
    name: 'Fortune Sunflower Oil 1L',
    unit: 'LITRE' as const,
    unitType: 'PACKAGED' as const,
    costPrice: 13000, // ₹130
    sellPrice: 15500, // ₹155
    mrp: 15500,
    quantity: 20,
    reorderLevel: 8,
    gstRate: 5,
    hsnCode: '1512',
  },
  {
    sku: 'MAGGI-70G',
    name: 'Maggi 70g',
    unit: 'PACKET' as const,
    unitType: 'PACKAGED' as const,
    costPrice: 1200, // ₹12
    sellPrice: 1400, // ₹14
    mrp: 1400,
    quantity: 100,
    reorderLevel: 20,
    gstRate: 12,
    hsnCode: '1902',
  },
  {
    sku: 'PARLE-G-BIS',
    name: 'Parle-G',
    unit: 'PACKET' as const,
    unitType: 'PACKAGED' as const,
    costPrice: 800, // ₹8
    sellPrice: 1000, // ₹10
    mrp: 1000,
    quantity: 60,
    reorderLevel: 20,
    gstRate: 18,
    hsnCode: '1905',
  },
  {
    sku: 'SURF-EXCL-1KG',
    name: 'Surf Excel 1kg',
    unit: 'PACKET' as const,
    unitType: 'PACKAGED' as const,
    costPrice: 19000, // ₹190
    sellPrice: 22500, // ₹225
    mrp: 22500,
    quantity: 15,
    reorderLevel: 5,
    gstRate: 18,
    hsnCode: '3402',
  },
  {
    sku: 'SUGAR-LOOSE',
    name: 'Sugar - Loose',
    unit: 'KG' as const,
    unitType: 'LOOSE' as const,
    costPrice: 4000, // ₹40/kg
    sellPrice: 4800, // ₹48/kg
    mrp: 4800,
    quantity: 50, // 50 kg
    reorderLevel: 15,
    gstRate: 0,
    hsnCode: '1701',
  },
  {
    sku: 'RICE-LOOSE',
    name: 'Rice - Loose',
    unit: 'KG' as const,
    unitType: 'LOOSE' as const,
    costPrice: 5500, // ₹55/kg
    sellPrice: 6500, // ₹65/kg
    mrp: 6500,
    quantity: 80, // 80 kg
    reorderLevel: 20,
    gstRate: 0,
    hsnCode: '1006',
  },
  {
    sku: 'DAL-LOOSE',
    name: 'Dal - Loose',
    unit: 'KG' as const,
    unitType: 'LOOSE' as const,
    costPrice: 9000, // ₹90/kg
    sellPrice: 11000, // ₹110/kg
    mrp: 11000,
    quantity: 40, // 40 kg
    reorderLevel: 10,
    gstRate: 0,
    hsnCode: '0713',
  },
];

async function seed() {
  console.log('🌱 Seeding database...\n');

  // Clear existing data (development only)
  await prisma.khataEntry.deleteMany();
  await prisma.billItem.deleteMany();
  await prisma.bill.deleteMany();
  await prisma.inventoryHistory.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.product.deleteMany();
  await prisma.ownerPreference.deleteMany();
  await prisma.conversationState.deleteMany();
  await prisma.dailySummary.deleteMany();
  await prisma.processedUpdate.deleteMany();

  // Reset bill sequence
  await prisma.billSequence.upsert({
    where: { id: 'singleton' },
    update: { current: 0 },
    create: { id: 'singleton', current: 0 },
  });

  // Create products
  for (const product of products) {
    const created = await prisma.product.create({ data: product });
    console.log(`  ✅ ${created.name} (SKU: ${created.sku}) — stock: ${created.quantity}`);

    // Create initial stock history
    if (product.quantity > 0) {
      await prisma.inventoryHistory.create({
        data: {
          productId: created.id,
          changeType: 'STOCK_IN',
          quantity: product.quantity,
          reference: 'SEED_DATA',
          notes: 'Initial seed stock',
        },
      });
    }
  }

  console.log(`\n✅ Seeded ${products.length} products.`);
  console.log('\n📋 Product Summary:');
  console.log('─'.repeat(70));
  console.log(
    'Name'.padEnd(25) +
    'Unit'.padEnd(10) +
    'Cost'.padEnd(10) +
    'MRP'.padEnd(10) +
    'GST'.padEnd(6) +
    'Stock'
  );
  console.log('─'.repeat(70));

  for (const p of products) {
    console.log(
      p.name.padEnd(25) +
      p.unit.padEnd(10) +
      `₹${(p.costPrice / 100).toFixed(0)}`.padEnd(10) +
      `₹${(p.mrp / 100).toFixed(0)}`.padEnd(10) +
      `${p.gstRate}%`.padEnd(6) +
      `${p.quantity}`
    );
  }

  console.log('─'.repeat(70));
  console.log('\n🏪 Database seeded successfully! Ready for demo.\n');
}

seed()
  .catch((error) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
