import { describe, expect, it } from 'vitest';
import {
  conversationIdFromUrl,
  conversationUrl,
  projectConversationUrl,
  projectIdFromHref,
  projectSourcesUrl,
  projectUrl,
} from '../src/adapters/chatgpt/identifiers.js';

const PROJECT_ID = 'g-p-0123456789abcdef0123456789abcdef';
const CONVERSATION_ID = '0123abcd-4567-89ef-0123-456789abcdef';

describe('project and conversation identifiers', () => {
  it('builds the documented project and conversation URLs', () => {
    expect(projectUrl(PROJECT_ID)).toBe(`https://chatgpt.com/g/${PROJECT_ID}/project`);
    expect(conversationUrl(CONVERSATION_ID)).toBe(`https://chatgpt.com/c/${CONVERSATION_ID}`);
  });

  it('addresses project files through the sources tab', () => {
    // Uploading anywhere else attaches to a single message instead of the project.
    expect(projectSourcesUrl(PROJECT_ID)).toBe(
      `https://chatgpt.com/g/${PROJECT_ID}/project?tab=sources`,
    );
  });

  it('addresses a project conversation directly rather than via the redirecting form', () => {
    expect(projectConversationUrl(PROJECT_ID, CONVERSATION_ID)).toBe(
      `https://chatgpt.com/g/${PROJECT_ID}/c/${CONVERSATION_ID}`,
    );
  });

  it('validates both identifiers when building a project conversation URL', () => {
    expect(() => projectConversationUrl('../../evil', CONVERSATION_ID)).toThrow(/project id/i);
    expect(() => projectConversationUrl(PROJECT_ID, '../../evil')).toThrow(/conversation id/i);
  });

  it.each([
    ['../../settings', 'path traversal'],
    ['g-p-0123456789abcdef0123456789abcdef/../../x', 'trailing traversal'],
    ['g-p-ZZZZ', 'non-hex characters'],
    ['g-p-abc', 'too short'],
    ['', 'empty'],
    ['https://evil.example/g-p-0123456789abcdef0123456789abcdef', 'absolute URL'],
    [`${PROJECT_ID}?next=https://evil.example`, 'query injection'],
    [`${PROJECT_ID}#frag`, 'fragment injection'],
  ])('rejects %s as a project id (%s)', (candidate) => {
    expect(() => projectUrl(candidate)).toThrow(/project id/i);
  });

  it.each([
    ['../../admin', 'path traversal'],
    ['not-a-uuid', 'wrong shape'],
    ['6A80100F-332C-83EC-9F7C-44A526F82A4B', 'uppercase hex'],
    [`${CONVERSATION_ID}/../x`, 'trailing traversal'],
  ])('rejects %s as a conversation id (%s)', (candidate) => {
    expect(() => conversationUrl(candidate)).toThrow(/conversation id/i);
  });

  it('reads a conversation id back from the URL the browser lands on', () => {
    expect(conversationIdFromUrl(`https://chatgpt.com/c/${CONVERSATION_ID}`)).toBe(CONVERSATION_ID);
    expect(
      conversationIdFromUrl(`https://chatgpt.com/c/${CONVERSATION_ID}?messageId=finalAgentTurn`),
    ).toBe(CONVERSATION_ID);
  });

  it('returns undefined when the URL carries no conversation', () => {
    expect(conversationIdFromUrl('https://chatgpt.com/')).toBeUndefined();
    expect(conversationIdFromUrl(`https://chatgpt.com/g/${PROJECT_ID}/project`)).toBeUndefined();
  });

  it('reads a project id from both a relative href and a full project URL', () => {
    expect(projectIdFromHref(`/g/${PROJECT_ID}/project`)).toBe(PROJECT_ID);
    expect(projectIdFromHref(`https://chatgpt.com/g/${PROJECT_ID}/project`)).toBe(PROJECT_ID);
  });

  it('ignores hrefs that are not projects', () => {
    expect(projectIdFromHref('/c/0123abcd-4567-89ef-0123-456789abcdef')).toBeUndefined();
    expect(projectIdFromHref('/g/g-4-not-a-project/project')).toBeUndefined();
    expect(projectIdFromHref('/projects')).toBeUndefined();
  });
});
