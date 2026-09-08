import Anthropic from '@anthropic-ai/sdk';
import { ALL_TOOLS, executeTool } from '../tools/registry';
import { getSystemPrompt } from './system-prompt';
import { logger } from '../utils/logger';

// Conversation history per user (in-memory, cleared on /new)
const conversationHistory: Map<string, Anthropic.MessageParam[]> = new Map();

const MAX_HISTORY = 40; // Max messages per conversation
const MAX_TOOL_ROUNDS = 15; // Max tool-calling rounds per request

interface AgentResponse {
  text: string;
  files: Array<{ path: string; name: string; type: 'pdf' | 'pptx' }>;
}

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: process.env['ANTHROPIC_API_KEY'],
    });
  }
  return anthropicClient;
}

/**
 * Clear conversation history for a user (used by /new command).
 * Does NOT clear persistent data (preferences, inventory, etc.)
 */
export function clearConversation(telegramUserId: string): void {
  conversationHistory.delete(telegramUserId);
  logger.info('Conversation cleared', { telegramUserId });
}

/**
 * Process a user message through the agent.
 * This implements the full agentic loop:
 * OBSERVE → REASON → CALL TOOL → RECEIVE RESULT → REASON AGAIN → RESPOND
 */
export async function processMessage(
  telegramUserId: string,
  userMessage: string
): Promise<AgentResponse> {
  const client = getClient();
  const model = process.env['CLAUDE_MODEL'] || 'claude-sonnet-4-20250514';

  // Get or create conversation history
  if (!conversationHistory.has(telegramUserId)) {
    conversationHistory.set(telegramUserId, []);
  }
  const history = conversationHistory.get(telegramUserId)!;

  // Add user message
  history.push({ role: 'user', content: userMessage });

  // Trim old messages to keep context manageable
  while (history.length > MAX_HISTORY) {
    history.shift();
  }

  const systemPrompt = getSystemPrompt(telegramUserId);
  const files: AgentResponse['files'] = [];

  let toolRound = 0;

  // ── Agentic Loop ──
  // Claude reasons, calls tools, receives results, reasons again, etc.
  // Loop continues until Claude produces a text response without tool calls
  while (toolRound < MAX_TOOL_ROUNDS) {
    toolRound++;
    logger.info('Agent turn', { telegramUserId, round: toolRound, historyLength: history.length });

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      tools: ALL_TOOLS as any,
      messages: history,
    });

    logger.info('Claude response', {
      telegramUserId,
      round: toolRound,
      stopReason: response.stop_reason,
      contentBlocks: response.content.length,
    });

    // Process response content blocks
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];
    const textParts: string[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      }
    }

    // If no tool calls, we're done — return the text response
    if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
      // Add assistant response to history
      history.push({ role: 'assistant', content: response.content });

      return {
        text: textParts.join('\n') || 'Done.',
        files,
      };
    }

    // We have tool calls — execute them and feed results back
    // Add assistant message with tool calls to history
    history.push({ role: 'assistant', content: response.content });

    // Execute all tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolCall of toolUseBlocks) {
      logger.info('Tool call', {
        telegramUserId,
        round: toolRound,
        tool: toolCall.name,
        toolId: toolCall.id,
      });

      const result = await executeTool(toolCall.name, toolCall.input as Record<string, unknown>);

      logger.info('Tool result', {
        telegramUserId,
        round: toolRound,
        tool: toolCall.name,
        success: result.success,
      });

      // Check if the tool produced a file (for Telegram upload)
      if (result.success && result.data) {
        const data = result.data as Record<string, unknown>;
        if (data['filePath'] && data['fileName']) {
          const ext = (data['fileName'] as string).split('.').pop()?.toLowerCase();
          if (ext === 'pdf' || ext === 'pptx') {
            files.push({
              path: data['filePath'] as string,
              name: data['fileName'] as string,
              type: ext as 'pdf' | 'pptx',
            });
          }
        }
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    // Add tool results to history
    history.push({ role: 'user', content: toolResults });
  }

  // Exceeded max tool rounds — return whatever we have
  logger.warn('Max tool rounds exceeded', { telegramUserId, rounds: toolRound });
  return {
    text: 'I needed more steps to complete this request. Please try breaking it into smaller parts.',
    files,
  };
}
