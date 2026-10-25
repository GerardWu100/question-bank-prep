import { describe, it, expect } from 'vitest';
import { buildApp } from '../apps/server/src/app.js';

/** A provider that searches once (so the reply has a trace step) and echoes the prompt. */
const provider = {
  status: async () => ({ available: true, models: [] }),
  async *stream(request: any) {
    await request.executeTool('search_materials', { query: 'duration' });
    yield { type: 'text', text: `Reply to ${request.prompt}` };
    yield { type: 'done', model: 'm', provider: 'p' };
  },
};

describe('AI notes and branches', () => {
  it('keeps one AI note per chat, records tool steps, and branches a chat', async () => {
    const { app } = await buildApp({ provider });
    try {
      const library = (await app.inject({ method: 'POST', url: '/api/libraries', payload: { name: 'Notes test' } })).json();
      const base = `/api/libraries/${library.id}`;
      const chat = (await app.inject({ method: 'POST', url: `${base}/chats`, payload: {} })).json();
      const send = async (text: string) =>
        (await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages`, payload: { text, operationId: `send-${text}` } })).json();
      const first = (await send('one')).chat.messages[1];
      expect(first.tools).toEqual([{ name: 'search_materials', status: 'completed', detail: '"duration"' }]);
      const save = async (messageId: string, operationId: string) =>
        (await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/messages/${messageId}/save-note`, payload: { operationId } })).json();

      // Saving the same reply twice (two clicks, two operations) gives one unchanged note.
      const note = await save(first.id, 'save-1');
      const again = await save(first.id, 'save-2');
      expect(again.id).toBe(note.id); expect(again.version).toBe(1);

      // Chatting more and saving the next reply adds it to the same note.
      const second = (await send('two')).chat.messages[3];
      const grown = await save(second.id, 'save-3');
      expect(grown.id).toBe(note.id); expect(grown.version).toBe(2);
      expect(grown.content).toBe('Reply to one\n\n---\n\nReply to two');
      const notes = (await app.inject(`${base}/notes`)).json().notes.filter((n: any) => n.provenance === 'ai');
      expect(notes).toHaveLength(1);
      expect((await app.inject(`${base}/chats/${chat.id}`)).json().savedMessageIds).toEqual([first.id, second.id]);

      // A branch copies the chat up to the chosen reply and keeps its own note.
      const branch = (await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/branch`, payload: { messageId: first.id, operationId: 'branch-1' } })).json();
      expect(branch.id).not.toBe(chat.id); expect(branch.branchOf).toBe(chat.id);
      expect(branch.messages.map((m: any) => m.content)).toEqual(['one', 'Reply to one']);
      const branchNote = (await app.inject({ method: 'POST', url: `${base}/chats/${branch.id}/messages/${first.id}/save-note`, payload: { operationId: 'save-branch' } })).json();
      expect(branchNote.id).not.toBe(note.id);
      expect((await app.inject({ method: 'POST', url: `${base}/chats/${chat.id}/branch`, payload: { messageId: 'missing', operationId: 'branch-2' } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
