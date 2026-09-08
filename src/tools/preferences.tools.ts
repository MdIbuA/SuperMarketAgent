import * as preferencesService from '../domain/preferences.service';
import { DomainError, toolSuccess, type ToolResult } from '../utils/errors';

// ─── Tool Schemas ───────────────────────────────────────────────────

export const getPreferencesSchema = {
  name: 'get_owner_preferences',
  description: 'Get all persistent preferences for the store owner. Preferences survive bot restarts and /new chat. Use this at the start of conversations to load the owner\'s settings.',
  input_schema: {
    type: 'object' as const,
    properties: {
      telegramUserId: { type: 'string', description: 'Telegram user ID' },
    },
    required: ['telegramUserId'],
  },
};

export const setPreferenceSchema = {
  name: 'set_owner_preference',
  description: 'Set a persistent preference for the store owner. Common keys: default_payment_method, default_atta, shop_name, shop_gstin, shop_address, shop_phone. Use this for "always assume UPI" or "default atta = Aashirvaad 5kg" type requests.',
  input_schema: {
    type: 'object' as const,
    properties: {
      telegramUserId: { type: 'string', description: 'Telegram user ID' },
      key: { type: 'string', description: 'Preference key (e.g., "default_payment_method", "default_atta", "shop_name")' },
      value: { type: 'string', description: 'Preference value (e.g., "UPI", "Aashirvaad Atta 5kg", "ABC Stores")' },
    },
    required: ['telegramUserId', 'key', 'value'],
  },
};

export const resetPreferenceSchema = {
  name: 'reset_owner_preference',
  description: 'Remove a persistent preference.',
  input_schema: {
    type: 'object' as const,
    properties: {
      telegramUserId: { type: 'string', description: 'Telegram user ID' },
      key: { type: 'string', description: 'Preference key to remove' },
    },
    required: ['telegramUserId', 'key'],
  },
};

// ─── Tool Implementations ───────────────────────────────────────────

export async function executeGetPreferences(args: { telegramUserId: string }): Promise<ToolResult> {
  try {
    const prefs = await preferencesService.getOwnerPreferences(args.telegramUserId);
    return toolSuccess({
      preferences: prefs,
      count: Object.keys(prefs).length,
      message: Object.keys(prefs).length === 0
        ? 'No preferences set.'
        : `${Object.keys(prefs).length} preference(s) loaded.`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeSetPreference(args: {
  telegramUserId: string;
  key: string;
  value: string;
}): Promise<ToolResult> {
  try {
    const result = await preferencesService.setPreference(args.telegramUserId, args.key, args.value);
    return toolSuccess({
      preference: result,
      message: `Preference "${args.key}" set to "${args.value}". This will persist across chats and restarts.`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}

export async function executeResetPreference(args: {
  telegramUserId: string;
  key: string;
}): Promise<ToolResult> {
  try {
    const deleted = await preferencesService.resetPreference(args.telegramUserId, args.key);
    return toolSuccess({
      deleted,
      message: deleted
        ? `Preference "${args.key}" has been removed.`
        : `Preference "${args.key}" was not found.`,
    });
  } catch (e) {
    if (e instanceof DomainError) return e.toToolResult();
    throw e;
  }
}
