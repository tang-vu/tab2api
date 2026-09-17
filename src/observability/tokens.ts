import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { AppError } from '../errors.js';

/**
 * Token accounting for ChatGPT Web prompts.
 *
 * A character ratio is not safe here: dense JSON or base64 can hold far more tokens than prose
 * of the same length. Count with the o200k tokenizer used by the current ChatGPT web models
 * instead. ChatGPT still exposes no authoritative usage; every number produced here remains an
 * estimate and is labelled as such on the API surface.
 */

const TOKENIZER_CHUNK_CHARS = 4_096;

/**
 * Counts ordinary text without handing pathological multi-megabyte runs to one tokenizer call.
 * Independent chunks can only lose cross-boundary merges, so the sum may over-count slightly
 * but cannot under-count because of a missed boundary token.
 */
export function estimateTokens(text: string | undefined): number {
  if (text === undefined || text.length === 0) return 0;
  let count = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + TOKENIZER_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end -= 1;
      }
    }
    count += encode(text.slice(start, end)).length;
    start = end;
  }
  return count;
}

/**
 * Measured ChatGPT web transport constants, derived from observed product behaviour (see the
 * codex-chatgpt-web project, MIT). They are ceilings, not guarantees: plan tier, experiments,
 * and UI changes can lower what a given account accepts at any time.
 */

/** Hidden ChatGPT product prompt reserve that every browser turn spends against the window. */
export const CHATGPT_PLATFORM_RESERVE_TOKENS = 8_192;
/** Conservative per-image reserve included in usage estimates. */
export const CHATGPT_IMAGE_RESERVE_TOKENS = 4_096;
/**
 * Largest measured single-message token ceiling across known account tiers (~104k). A serialized
 * prompt beyond this cannot fit any measured browser route, so it is rejected before a tab opens.
 * `TAB2API_MAX_PROMPT_TOKENS` overrides the default for accounts with different limits.
 */
export const CHATGPT_MAX_PROMPT_TOKENS = 104_000;

export interface PromptBudget {
  /** o200k tokens of the serialized prompt text alone. */
  textTokens: number;
  /** Tokens reserved for attached images. */
  imageTokens: number;
  /** Total estimated spend for the turn, including the hidden platform reserve. */
  totalTokens: number;
}

export function promptBudget(text: string, imageCount = 0): PromptBudget {
  const textTokens = estimateTokens(text);
  const imageTokens = imageCount * CHATGPT_IMAGE_RESERVE_TOKENS;
  return {
    textTokens,
    imageTokens,
    totalTokens: textTokens + imageTokens + CHATGPT_PLATFORM_RESERVE_TOKENS,
  };
}

/**
 * Fails explicitly before a browser turn is opened when the serialized prompt exceeds the
 * configured ceiling. The check compares text plus image reserves, not the hidden platform
 * reserve, so a prompt that exactly fills the account window is still attempted once.
 */
export function assertPromptWithinLimit(
  text: string,
  imageCount: number,
  maxPromptTokens: number,
): PromptBudget {
  const budget = promptBudget(text, imageCount);
  if (budget.textTokens + budget.imageTokens > maxPromptTokens) {
    throw new AppError(
      'invalid_request',
      `The serialized request needs ~${(budget.textTokens + budget.imageTokens).toLocaleString('en-US')} tokens, above the ${maxPromptTokens.toLocaleString('en-US')}-token single-message ceiling.`,
      'Shorten the request, move source material into a ChatGPT project, or raise TAB2API_MAX_PROMPT_TOKENS only if the account demonstrably accepts more.',
    );
  }
  return budget;
}
