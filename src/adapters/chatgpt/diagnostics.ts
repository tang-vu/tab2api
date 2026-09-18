import type { SessionState } from '../../provider.js';
import type { MissingSurface } from './observe-dom.js';
import type { DomObservation } from './observe-dom.js';
import { SELECTOR_CONTRACTS, type ContractCardinality } from './selector-contracts.js';

/**
 * Diagnostics derived from DOM observations. Everything here is content-free: contract
 * names, counts, session states, and URL structure only — never prompt text, assistant
 * text, titles, or account data.
 */

export interface ContractFingerprint {
  readonly cardinality: ContractCardinality;
  /** Bounded match evidence from the last observation. */
  readonly count: number;
  readonly visible: number;
  /** Whether the match shape satisfied the declared cardinality. */
  readonly satisfied: boolean;
}

/**
 * A compact, redacted snapshot of which selector contracts currently match the live UI.
 * When ChatGPT ships a layout change this is the diff that identifies exactly which
 * contract broke — actionable instead of a bare `ui_changed`.
 */
export interface CompatFingerprint {
  readonly capturedAt: string;
  readonly session: SessionState;
  /** Host + pathname only; no query, which may carry conversation/project ids. */
  readonly url: { readonly host: string; readonly pathname: string } | undefined;
  readonly missing: MissingSurface | undefined;
  readonly contracts: Record<string, ContractFingerprint>;
}

function cardinalitySatisfied(cardinality: ContractCardinality, count: number): boolean {
  if (cardinality === 'exactlyOne') return count === 1;
  if (cardinality === 'zeroOrOne') return count <= 1;
  return true;
}

export function fingerprintObservation(
  observation: DomObservation,
  url: string,
  capturedAt = new Date(),
): CompatFingerprint {
  const contracts: Record<string, ContractFingerprint> = {};
  for (const [name, definition] of Object.entries(SELECTOR_CONTRACTS)) {
    const evidence = observation.contracts[name];
    const count = evidence?.count ?? 0;
    contracts[name] = {
      cardinality: definition.cardinality,
      count,
      visible: evidence?.visible ?? 0,
      satisfied: cardinalitySatisfied(definition.cardinality, count),
    };
  }
  let parsedUrl: CompatFingerprint['url'];
  try {
    const parsed = new URL(url);
    parsedUrl = { host: parsed.host, pathname: parsed.pathname };
  } catch {
    parsedUrl = undefined;
  }
  return {
    capturedAt: capturedAt.toISOString(),
    session: observation.session,
    url: parsedUrl,
    missing: observation.missing,
    contracts,
  };
}

/**
 * Truthful three-valued capability evidence. `observed` means a controlling element was
 * seen in the last observation; `absent` means the surface rendered and the control was
 * not there; `unknown` means the capability cannot be established without driving it, and
 * tab2api does not claim support it has not observed.
 */
export type CapabilityStatus = 'observed' | 'absent' | 'unknown';

export interface CapabilitySnapshot {
  readonly checkedAt: string;
  /** A visible composer exists — the minimum for any turn. */
  readonly chat: CapabilityStatus;
  /** Temporary-chat evidence was seen when requested. */
  readonly temporaryChat: CapabilityStatus;
  /** A file input exists, so message attachments can be attempted. */
  readonly fileUploads: CapabilityStatus;
  /** A reasoning/effort control exists. */
  readonly reasoningEffort: CapabilityStatus;
  /** Project rows or the create control were seen on the projects surface. */
  readonly projectNavigation: CapabilityStatus;
  /** Generation completion markers (turn ids / assistant nodes) were seen. */
  readonly turnTracking: CapabilityStatus;
}

export function capabilitySnapshot(
  observation: DomObservation,
  surface: 'chat' | 'projects' | 'unknown',
  checkedAt = new Date(),
): CapabilitySnapshot {
  const rendered =
    observation.session === 'ready' ||
    observation.session === 'generation_in_progress' ||
    observation.composerPresent ||
    observation.projectRowCount > 0;
  return {
    checkedAt: checkedAt.toISOString(),
    chat: observation.composerVisible ? 'observed' : rendered ? 'absent' : 'unknown',
    temporaryChat: observation.temporaryChatEvidence ? 'observed' : 'unknown',
    fileUploads: observation.fileInputCount > 0 ? 'observed' : rendered ? 'absent' : 'unknown',
    reasoningEffort: observation.effortControlPresent
      ? 'observed'
      : rendered
        ? 'absent'
        : 'unknown',
    projectNavigation:
      surface === 'projects'
        ? observation.projectRowCount > 0 || observation.newProjectControl
          ? 'observed'
          : 'absent'
        : 'unknown',
    turnTracking:
      observation.turnIds.length > 0 || observation.assistant.count > 0
        ? 'observed'
        : rendered
          ? 'absent'
          : 'unknown',
  };
}

/**
 * The adapter's diagnostics surface: last observation's fingerprint + capability snapshot,
 * plus the semantic contract names that failed cardinality, for `doctor` and
 * `/admin/diagnostics`.
 */
export interface AdapterDiagnostics {
  readonly state: SessionState;
  readonly fingerprint: CompatFingerprint | undefined;
  readonly capabilities: CapabilitySnapshot | undefined;
  readonly unsatisfiedContracts: readonly string[];
}

export function buildDiagnostics(
  state: SessionState,
  fingerprint: CompatFingerprint | undefined,
  capabilities: CapabilitySnapshot | undefined,
): AdapterDiagnostics {
  const unsatisfiedContracts =
    fingerprint === undefined
      ? []
      : Object.entries(fingerprint.contracts)
          .filter(([, evidence]) => !evidence.satisfied)
          .map(([name]) => name);
  return { state, fingerprint, capabilities, unsatisfiedContracts };
}
