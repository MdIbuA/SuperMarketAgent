import { prisma } from '../db/client';
import { logger } from '../utils/logger';

/**
 * Get all preferences for an owner.
 */
export async function getOwnerPreferences(telegramUserId: string): Promise<Record<string, string>> {
  const prefs = await prisma.ownerPreference.findMany({
    where: { telegramUserId },
  });

  const result: Record<string, string> = {};
  for (const pref of prefs) {
    result[pref.key] = pref.value;
  }

  return result;
}

/**
 * Get a single preference.
 */
export async function getPreference(telegramUserId: string, key: string): Promise<string | null> {
  const pref = await prisma.ownerPreference.findUnique({
    where: { telegramUserId_key: { telegramUserId, key } },
  });

  return pref?.value ?? null;
}

/**
 * Set a preference (upsert).
 */
export async function setPreference(
  telegramUserId: string,
  key: string,
  value: string
): Promise<{ key: string; value: string }> {
  await prisma.ownerPreference.upsert({
    where: { telegramUserId_key: { telegramUserId, key } },
    update: { value },
    create: { telegramUserId, key, value },
  });

  logger.info('Preference set', { telegramUserId, key, value });
  return { key, value };
}

/**
 * Delete a preference.
 */
export async function resetPreference(
  telegramUserId: string,
  key: string
): Promise<boolean> {
  try {
    await prisma.ownerPreference.delete({
      where: { telegramUserId_key: { telegramUserId, key } },
    });
    logger.info('Preference reset', { telegramUserId, key });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the default payment method preference.
 */
export async function getDefaultPaymentMethod(telegramUserId: string): Promise<string | null> {
  return getPreference(telegramUserId, 'default_payment_method');
}

/**
 * Common preference keys used in the system.
 */
export const PREFERENCE_KEYS = {
  DEFAULT_PAYMENT: 'default_payment_method',
  DEFAULT_ATTA: 'default_atta',
  SHOP_NAME: 'shop_name',
  SHOP_GSTIN: 'shop_gstin',
  SHOP_ADDRESS: 'shop_address',
  SHOP_PHONE: 'shop_phone',
} as const;
