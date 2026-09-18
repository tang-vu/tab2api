import type { Locator, Page } from 'playwright';
import { AppError, abortError } from '../../errors.js';
import type { MediaAttachment, UiEffort } from '../../provider.js';
import { contractError, firstVisible } from './locators.js';
import { contractCandidates } from './selector-contracts.js';
import { EFFORT_LABELS } from './selectors.js';

/**
 * Composer interactions: resolving the input, filling the prompt, the send gesture, the
 * effort control, Temporary Chat evidence, and attachment upload. Every required target
 * resolves through its selector contract so a missing control raises the contract's typed
 * failure rather than a generic timeout.
 */

const INITIAL_STATE_POLL_MS = 250;

/** The composer must exist and be visible before a turn can prepare. */
export async function resolveComposer(page: Page): Promise<Locator> {
  const composer = await firstVisible(page, contractCandidates('composer'));
  if (composer === undefined) {
    throw contractError(
      'composer',
      'composer_unavailable',
      'The ChatGPT composer is unavailable or not visible.',
    );
  }
  return composer;
}

/**
 * Uploads attachments through the composer's hidden file input. Doing nothing for an empty
 * list keeps callers free of the guard and leaves attachment-free turns untouched.
 */
export async function attachFiles(
  page: Page,
  attachments: readonly MediaAttachment[] | undefined,
): Promise<void> {
  if (attachments === undefined || attachments.length === 0) return;
  const fileInput = page.locator(contractCandidates('fileInput').join(',')).first();
  if ((await fileInput.count()) === 0) {
    throw contractError(
      'fileInput',
      'attachment_failed',
      'The ChatGPT file input is unavailable.',
    );
  }
  await fileInput.setInputFiles(
    attachments.map((attachment) => ({
      name: attachment.filename,
      mimeType: attachment.mimeType,
      buffer: attachment.data,
    })),
  );
}

/**
 * A request that asked for Temporary Chat must observe actual evidence: the URL query
 * alone is weak because the SPA can drop it, and a silently persistent chat would keep
 * history the caller asked not to keep.
 */
export async function assertTemporaryChat(page: Page, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (signal.aborted) throw abortError(signal);
    if (page.url().includes('temporary-chat')) return;
    if ((await firstVisible(page, contractCandidates('temporaryChat'))) !== undefined) return;
    await page.waitForTimeout(INITIAL_STATE_POLL_MS);
  }
  throw new AppError(
    'ui_changed',
    'ChatGPT did not confirm a Temporary Chat for this turn.',
    'Unset `temporary`/`TAB2API_TEMPORARY_CHAT` or file a selector bug.',
  );
}

/**
 * Drives the composer's effort control for an explicit `reasoning_effort`. The control
 * and its labels vary by plan and locale; an unlisted label fails `ui_changed` rather
 * than silently sending at whatever effort the account happened to leave selected.
 */
export async function selectEffort(page: Page, effort: UiEffort): Promise<void> {
  const control = await firstVisible(page, contractCandidates('effortButton'));
  if (control === undefined) {
    throw contractError(
      'effortButton',
      'unsupported_capability',
      'The ChatGPT effort control is unavailable.',
    );
  }
  await control.click();
  const options = page.locator(contractCandidates('effortOption').join(','));
  for (const pattern of EFFORT_LABELS[effort]) {
    const option = options.filter({ hasText: pattern }).first();
    try {
      await option.waitFor({ state: 'visible', timeout: 1_500 });
      await option.click();
      return;
    } catch {
      // Try the next candidate label.
    }
  }
  throw new AppError(
    'ui_changed',
    `ChatGPT offered no effort option matching "${effort}".`,
    'Remove `reasoning_effort` or report the offered labels in a selector bug.',
  );
}

/**
 * Fills the composer and performs the send gesture. A failure of the gesture itself is
 * `submission_uncertain`: the prompt may already have been delivered by a partial click or
 * a keypress that fired before the throw, so the caller must not auto-retry.
 */
export async function submitPrompt(page: Page, composer: Locator, prompt: string): Promise<void> {
  await composer.fill(prompt);
  const send = await firstVisible(page, contractCandidates('sendControl'));
  try {
    if (send !== undefined) await send.click();
    else await composer.press('Enter');
  } catch {
    throw new AppError(
      'submission_uncertain',
      'The send gesture failed after the prompt was entered; submission is uncertain.',
      'Check the conversation in ChatGPT before retrying. The prompt was not automatically resubmitted.',
    );
  }
}
