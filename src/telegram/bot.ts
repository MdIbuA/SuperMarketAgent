import { Bot, InputFile } from 'grammy';
import { processMessage, clearConversation } from '../agent/runtime';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';
import fs from 'fs';

let bot: Bot | null = null;

export function createBot(token: string): Bot {
  bot = new Bot(token);

  // ── /start command ──
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '🏪 *Supermarket Ops Agent*\n\n' +
      'I\'m your AI-powered kirana store assistant. Talk to me in plain language!\n\n' +
      '*Examples:*\n' +
      '• "50 packets of Maggi came in, cost ₹12, MRP ₹14"\n' +
      '• "make a bill: 2kg sugar, 4 Maggi, UPI"\n' +
      '• "how much sugar is left?"\n' +
      '• "put ₹500 on Ramesh\'s credit"\n' +
      '• "today\'s sales?"\n' +
      '• "send me that bill as a PDF"\n\n' +
      'Use /new to start a fresh conversation (your data is preserved).',
      { parse_mode: 'Markdown' }
    );
  });

  // ── /new command — clear conversation context ──
  bot.command('new', async (ctx) => {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    clearConversation(userId);
    await ctx.reply('🔄 Fresh conversation started. Your store data, preferences, and inventory are preserved.');
  });

  // ── Handle text messages — the main agent loop ──
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id?.toString();
    const text = ctx.message.text;

    if (!userId || !text) return;

    // Handle /new as text too (some users type "new chat")
    if (text.toLowerCase().trim() === '/new' || text.toLowerCase().trim() === 'new chat') {
      clearConversation(userId);
      await ctx.reply('🔄 Fresh conversation started. Your store data, preferences, and inventory are preserved.');
      return;
    }

    // Check for duplicate Telegram updates (idempotency)
    const updateId = ctx.update.update_id;
    try {
      await prisma.processedUpdate.create({
        data: { updateId },
      });
    } catch {
      // Duplicate update — already processed
      logger.warn('Duplicate Telegram update', { updateId });
      return;
    }

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    // Keep typing while processing
    const typingInterval = setInterval(async () => {
      try {
        await ctx.replyWithChatAction('typing');
      } catch {
        // Ignore typing errors
      }
    }, 4000);

    try {
      logger.info('Processing message', {
        updateId,
        userId,
        textLength: text.length,
      });

      const response = await processMessage(userId, text);

      // Send text response
      if (response.text) {
        // Split long messages (Telegram limit: 4096 chars)
        const maxLen = 4096;
        const messageText = response.text;
        
        if (messageText.length <= maxLen) {
          await ctx.reply(messageText);
        } else {
          // Split at newlines if possible
          let remaining = messageText;
          while (remaining.length > 0) {
            let chunk: string;
            if (remaining.length <= maxLen) {
              chunk = remaining;
              remaining = '';
            } else {
              const splitAt = remaining.lastIndexOf('\n', maxLen);
              if (splitAt > maxLen * 0.5) {
                chunk = remaining.substring(0, splitAt);
                remaining = remaining.substring(splitAt + 1);
              } else {
                chunk = remaining.substring(0, maxLen);
                remaining = remaining.substring(maxLen);
              }
            }
            await ctx.reply(chunk);
          }
        }
      }

      // Send generated files
      for (const file of response.files) {
        if (fs.existsSync(file.path)) {
          if (file.type === 'pdf') {
            await ctx.replyWithDocument(new InputFile(file.path, file.name));
          } else if (file.type === 'pptx') {
            await ctx.replyWithDocument(new InputFile(file.path, file.name));
          }
          logger.info('File sent', { fileName: file.name, type: file.type });
        }
      }

    } catch (error: any) {
      logger.error('Message processing error', {
        updateId,
        userId,
        error: error.message,
        stack: error.stack,
      });

      await ctx.reply(
        '❌ Sorry, something went wrong processing your request. Please try again.'
      );
    } finally {
      clearInterval(typingInterval);
    }
  });

  // ── Error handler ──
  bot.catch((err) => {
    logger.error('Bot error', { error: err.message, stack: err.stack });
  });

  return bot;
}

export function getBot(): Bot | null {
  return bot;
}
