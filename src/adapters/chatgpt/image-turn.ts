import type { Locator, Page } from 'playwright';
import { AppError } from '../../errors.js';
import type { GenerateImageRequest, GenerateImageResult } from '../../provider.js';
import type { AppConfig } from '../../config/index.js';
import { contractCandidates } from './selector-contracts.js';
import { observe } from './session.js';
import { assertGeneratingObservation, assertReadyObservation, errorForState, waitForInitialObservation } from './session.js';
import {
  attachFiles,
  assertTemporaryChat,
  resolveComposer,
  submitPrompt,
} from './composer.js';
import type { DomObservation } from './observe-dom.js';
import { turnAbortError, type TurnLifecycle } from './turn-lifecycle.js';
import { TEMPORARY_CHAT_URL, CHATGPT_URL } from './identifiers.js';

/**
 * One image turn through the ChatGPT composer. Completion waits for a new generated image
 * to finish decoding plus turn-completion evidence, then the image is captured at its
 * intrinsic resolution by isolating it in the live DOM — the private image URL is never
 * read or fetched.
 */

const POLL_MS = 300;
const MAX_CAPTURE_DIMENSION = 4_096;
const MAX_CAPTURE_PIXELS = 16_777_216;
/** Padding around the isolated element so the clip never sits flush against the viewport. */
const CAPTURE_MARGIN_PX = 256;
/** Stable observations required before a decoded image counts as final. */
const STABLE_IMAGE_OBSERVATIONS = 3;

/**
 * A turn that uploaded references puts the user's own images into the transcript, where the
 * author-agnostic fallback cannot tell them apart from the answer. Such a turn is matched by
 * assistant-scoped selectors only, so a reference is never captured as the generated image.
 */
function generatedImageSelectors(references: number): readonly string[] {
  return references === 0
    ? [...contractCandidates('generatedImage'), ...contractCandidates('generatedImageFallback')]
    : contractCandidates('generatedImage');
}

/**
 * Keeps the single-image constraint that `waitForGeneratedImage` counts on, and names the
 * uploads so the model treats them as references rather than as the subject to describe.
 */
function imagePrompt(request: GenerateImageRequest): string {
  const references = request.attachments?.length ?? 0;
  if (references === 0) return `Create exactly one image from this request:\n\n${request.prompt}`;
  const noun = references === 1 ? 'the attached image' : `the ${references} attached images`;
  return `Create exactly one image from this request, using ${noun} as visual references:\n\n${request.prompt}`;
}

export function validateIntrinsicPng(
  data: Buffer,
  dimensions: { width: number; height: number },
  mediaLimitBytes: number,
): Buffer {
  const captureError = (reason: string): AppError =>
    new AppError(
      'ui_changed',
      `ChatGPT displayed an image that could not be captured safely at intrinsic resolution (${reason}).`,
    );
  if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw captureError('invalid PNG output');
  }
  const pngWidth = data.length >= 24 ? data.readUInt32BE(16) : 0;
  const pngHeight = data.length >= 24 ? data.readUInt32BE(20) : 0;
  if (pngWidth !== dimensions.width || pngHeight !== dimensions.height) {
    throw captureError(
      `expected ${dimensions.width}x${dimensions.height}, captured ${pngWidth}x${pngHeight}`,
    );
  }
  if (data.length > mediaLimitBytes) {
    throw captureError(`PNG exceeds the configured ${mediaLimitBytes}-byte media limit`);
  }
  return data;
}

async function waitForGeneratedImage(
  page: Page,
  selectors: readonly string[],
  baselineImages: readonly number[],
  baselineCompletionActions: number,
  lifecycle: TurnLifecycle,
  signal: AbortSignal,
  mediaLimitBytes: number,
  hooks: { onObservation?: (observation: DomObservation, url: string) => void } | undefined,
): Promise<Buffer> {
  let stableObservations = 0;
  while (true) {
    if (signal.aborted) throw turnAbortError(signal, lifecycle.postSubmit);
    const observation = await observe(page, { duringGeneration: true });
    hooks?.onObservation?.(observation, page.url());
    assertGeneratingObservation(observation);
    if (observation.session === 'browser_disconnected') {
      throw errorForState('browser_disconnected');
    }
    let image: Locator | undefined;
    for (const [index, selector] of selectors.entries()) {
      const candidates = page.locator(selector);
      const count = await candidates.count();
      if (count > (baselineImages[index] ?? 0)) {
        image = candidates.nth(count - 1);
        break;
      }
    }
    const complete =
      image !== undefined &&
      (await image
        .evaluate((element) => {
          const candidate = element as HTMLImageElement;
          return candidate.complete && candidate.naturalWidth > 0 && candidate.naturalHeight > 0;
        })
        .catch(() => false));
    stableObservations = complete ? stableObservations + 1 : 0;
    const generating = observation.stopVisible;
    const completionActionAvailable =
      observation.completionActionCount > baselineCompletionActions;
    if (
      image !== undefined &&
      stableObservations >= STABLE_IMAGE_OBSERVATIONS &&
      (!generating || completionActionAvailable)
    ) {
      return captureIntrinsicImage(page, image, mediaLimitBytes);
    }
    await page.waitForTimeout(POLL_MS);
  }
}

async function captureIntrinsicImage(
  page: Page,
  image: Locator,
  mediaLimitBytes: number,
): Promise<Buffer> {
  const dimensions = await image.evaluate((element) => {
    const candidate = element as HTMLImageElement;
    return { width: candidate.naturalWidth, height: candidate.naturalHeight };
  });
  if (
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > MAX_CAPTURE_DIMENSION ||
    dimensions.height > MAX_CAPTURE_DIMENSION ||
    dimensions.width * dimensions.height > MAX_CAPTURE_PIXELS
  ) {
    throw new AppError(
      'ui_changed',
      'ChatGPT displayed an image with unsupported intrinsic dimensions.',
    );
  }

  // Enlarging the element in place is not enough on its own: an ancestor still clips it, so
  // an element screenshot captures whatever the page renders across that box — the chat
  // chrome and blank background rather than the picture. Everything except the capture
  // target is therefore hidden, the target is lifted out of its clipping ancestor, and the
  // viewport is clipped to exactly its box. The node stays in ChatGPT's tree so React does
  // not detach the locator mid-capture, and the private image URL is never read or fetched.
  //
  // Device metrics are also pinned to a 1:1 ratio, because a page attached over CDP
  // inherits the host display's real scale factor and a fractional value rounds the clip to
  // a size that no longer matches the element's natural pixels.
  const deviceMetrics = await page.context().newCDPSession(page);
  // Playwright re-applies its own viewport when it screenshots, so the size must go through
  // setViewportSize; the CDP override is what pins the scale factor to 1:1 afterwards.
  const applyMetrics = async (width: number, height: number): Promise<void> => {
    await page.setViewportSize({ width, height });
    await deviceMetrics.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  };
  let overrideWidth = dimensions.width + CAPTURE_MARGIN_PX;
  let overrideHeight = dimensions.height + CAPTURE_MARGIN_PX;
  await applyMetrics(overrideWidth, overrideHeight);
  await image.evaluate((element) => {
    const candidate = element as HTMLImageElement;
    candidate.dataset.tab2apiCapture = 'true';
    const isolationStyle = document.createElement('style');
    isolationStyle.textContent = `
      body *:not([data-tab2api-capture="true"]),
      body *::before,
      body *::after { visibility: hidden !important; }
      [data-tab2api-capture="true"] { visibility: visible !important; }
    `;
    document.head.append(isolationStyle);
    const declarations: ReadonlyArray<readonly [string, string]> = [
      ['position', 'fixed'],
      ['left', '64px'],
      ['top', '64px'],
      ['width', `${candidate.naturalWidth}px`],
      ['height', `${candidate.naturalHeight}px`],
      ['max-width', 'none'],
      ['max-height', 'none'],
      ['object-fit', 'fill'],
      ['display', 'block'],
      ['border-radius', '0'],
      ['clip-path', 'none'],
      ['transform', 'none'],
      ['z-index', '2147483647'],
    ];
    for (const [property, value] of declarations)
      candidate.style.setProperty(property, value, 'important');
  });

  // `position: fixed` is only viewport-relative when no ancestor establishes a containing
  // block, and ChatGPT's message list uses a transform. Measure where the element really
  // landed and grow the viewport to contain it before clipping.
  let box = await image.boundingBox();
  if (box === null) {
    throw new AppError('ui_changed', 'The generated image could not be measured for capture.');
  }
  const requiredWidth = Math.ceil(box.x + dimensions.width) + CAPTURE_MARGIN_PX;
  const requiredHeight = Math.ceil(box.y + dimensions.height) + CAPTURE_MARGIN_PX;
  if (requiredWidth > overrideWidth || requiredHeight > overrideHeight) {
    overrideWidth = Math.max(overrideWidth, requiredWidth);
    overrideHeight = Math.max(overrideHeight, requiredHeight);
    await applyMetrics(overrideWidth, overrideHeight);
    box = await image.boundingBox();
    if (box === null) {
      throw new AppError('ui_changed', 'The generated image could not be measured for capture.');
    }
  }

  const data = await page.screenshot({
    type: 'png',
    animations: 'disabled',
    scale: 'css',
    clip: { x: box.x, y: box.y, width: dimensions.width, height: dimensions.height },
  });
  return validateIntrinsicPng(data, dimensions, mediaLimitBytes);
}

export async function runImageTurn(
  page: Page,
  request: GenerateImageRequest,
  lifecycle: TurnLifecycle,
  config: AppConfig,
  hooks?: { onObservation?: (observation: DomObservation, url: string) => void },
): Promise<GenerateImageResult> {
  lifecycle.transition('navigating');
  const target = request.temporary === true ? TEMPORARY_CHAT_URL : CHATGPT_URL;
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    if (request.signal.aborted) throw turnAbortError(request.signal, false);
    throw new AppError(
      'navigation_failed',
      'ChatGPT did not finish navigating to the requested surface.',
      'Run `npm run doctor`; the prompt was not submitted.',
    );
  }
  lifecycle.transition('observing');
  const initial = await waitForInitialObservation(page);
  hooks?.onObservation?.(initial, page.url());
  if (request.signal.aborted) throw turnAbortError(request.signal, false);
  assertReadyObservation(initial);

  lifecycle.transition('preparing');
  const composer = await resolveComposer(page);
  if (request.temporary === true) await assertTemporaryChat(page, request.signal);
  const imageSelectors = generatedImageSelectors(request.attachments?.length ?? 0);
  const baselineImages = await Promise.all(
    imageSelectors.map(async (selector) => page.locator(selector).count()),
  );
  const baselineObservation = await observe(page);
  const baselineCompletionActions = baselineObservation.completionActionCount;
  await attachFiles(page, request.attachments);

  lifecycle.transition('submitting');
  await submitPrompt(page, composer, imagePrompt(request));
  lifecycle.transition('submitted');

  const data = await waitForGeneratedImage(
    page,
    imageSelectors,
    baselineImages,
    baselineCompletionActions,
    lifecycle,
    request.signal,
    config.mediaLimitBytes,
    hooks,
  );
  lifecycle.transition('completing');
  lifecycle.transition('done');
  return { data, mimeType: 'image/png' };
}
