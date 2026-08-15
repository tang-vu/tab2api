import { describe, expect, it } from 'vitest';
import {
  conversationIdFromUrl,
  conversationUrl,
  projectIdFromHref,
  projectUrl,
} from '../src/adapters/chatgpt/identifiers.js';

const PROJECT_ID = 'g-p-6a7fe6399d0c819196f3dc4ae1aa83fe';
const CONVERSATION_ID = '6a80100f-332c-83ec-9f7c-44a526f82a4b';

describe('project and conversation identifiers', () => {
  it('builds the documented project and conversation URLs', () => {
    expect(projectUrl(PROJECT_ID)).toBe(`https://chatgpt.com/g/${PROJECT_ID}/project`);
    expect(conversationUrl(CONVERSATION_ID)).toBe(`https://chatgpt.com/c/${CONVERSATION_ID}`);
  });

  it.each([
    ['../../settings', 'path traversal'],
    ['g-p-6a7fe6399d0c819196f3dc4ae1aa83fe/../../x', 'trailing traversal'],
    ['g-p-ZZZZ', 'non-hex characters'],
    ['g-p-abc', 'too short'],
    ['', 'empty'],
    ['https://evil.example/g-p-6a7fe6399d0c819196f3dc4ae1aa83fe', 'absolute URL'],
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
    expect(projectIdFromHref('/c/6a80100f-332c-83ec-9f7c-44a526f82a4b')).toBeUndefined();
    expect(projectIdFromHref('/g/g-4-not-a-project/project')).toBeUndefined();
    expect(projectIdFromHref('/projects')).toBeUndefined();
  });
});
