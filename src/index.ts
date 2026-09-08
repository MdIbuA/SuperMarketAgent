import dotenv from 'dotenv';
import path from 'path';

// Load environment variables first
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { createBot } from './telegram/bot';
import { prisma } from './db/client';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting Supermarket Ops Agent...');

  // Validate required env vars
  const required = ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'DATABASE_URL'];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error(`Missing required environment variable: ${key}`);
      process.exit(1);
    }
  }

  // Test database connection
  try {
    await prisma.$connect();
    logger.info('Database connected');

    // Ensure bill sequence exists
    await prisma.$executeRaw`
      INSERT INTO "BillSequence" ("id", "current")
      VALUES ('singleton', 0)
      ON CONFLICT ("id") DO NOTHING
    `;
  } catch (error: any) {
    logger.error('Database connection failed', { error: error.message });
    process.exit(1);
  }

  // Start Telegram bot
  const bot = createBot(process.env['TELEGRAM_BOT_TOKEN']!);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    bot.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start polling
  logger.info('Bot starting...');
  await bot.start({
    onStart: (botInfo) => {
      logger.info(`Bot started: @${botInfo.username}`, {
        id: botInfo.id,
        username: botInfo.username,
      });
      console.log(`\n🏪 Supermarket Ops Agent is running!`);
      console.log(`📱 Talk to your bot: https://t.me/${botInfo.username}\n`);
    },
  });
}

main().catch((error) => {
  logger.error('Fatal error', { error: error.message, stack: error.stack });
  process.exit(1);
});
