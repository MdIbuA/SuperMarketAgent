import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

interface AppConfig {
  telegramBotToken: string;
  anthropicApiKey: string;
  databaseUrl: string;
  claudeModel: string;
  logLevel: string;
  nodeEnv: string;
}

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config: AppConfig = {
  telegramBotToken: getEnvOrThrow('TELEGRAM_BOT_TOKEN'),
  anthropicApiKey: getEnvOrThrow('ANTHROPIC_API_KEY'),
  databaseUrl: getEnvOrThrow('DATABASE_URL'),
  claudeModel: process.env['CLAUDE_MODEL'] || 'claude-sonnet-4-20250514',
  logLevel: process.env['LOG_LEVEL'] || 'info',
  nodeEnv: process.env['NODE_ENV'] || 'development',
};
