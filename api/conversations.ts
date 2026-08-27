/**
 * In-memory conversation store (per running server process; no database yet).
 * Contexts are keyed by conversationId which the client echoes back each turn.
 */

import { createConversationContext } from '../shared/index.js';
import type { ConversationContext } from '../shared/index.js';

const MAX_CONVERSATIONS = 5_000;

export interface ConversationStore {
  getOrCreate(conversationId: string | null, userId: string): ConversationContext;
  save(context: ConversationContext): void;
}

export function createInMemoryConversationStore(): ConversationStore {
  const conversations = new Map<string, ConversationContext>();

  return {
    getOrCreate(conversationId, userId) {
      const id = conversationId && conversationId.trim().length > 0 ? conversationId.trim() : null;
      if (id) {
        const existing = conversations.get(id);
        if (existing && existing.userId === userId) return existing;
      }
      const created = createConversationContext({ userId });
      conversations.set(created.id, created);
      if (conversations.size > MAX_CONVERSATIONS) {
        const oldest = conversations.keys().next().value;
        if (oldest !== undefined) conversations.delete(oldest);
      }
      return created;
    },
    save(context) {
      conversations.set(context.id, context);
    },
  };
}
