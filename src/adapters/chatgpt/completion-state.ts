export interface CompletionObservation {
  assistantCount: number;
  text: string;
  generating: boolean;
  completionActionAvailable?: boolean;
}

export type CompletionDecision = 'waiting' | 'complete';

export class CompletionStateMachine {
  private lastText = '';
  private stableObservations = 0;

  constructor(
    private readonly baselineAssistantCount: number,
    private readonly requiredStableObservations = 3,
  ) {}

  observe(observation: CompletionObservation): CompletionDecision {
    const isNew = observation.assistantCount > this.baselineAssistantCount;
    if (!isNew || observation.text.length === 0) {
      this.lastText = '';
      this.stableObservations = 0;
      return 'waiting';
    }
    if (observation.text === this.lastText) this.stableObservations += 1;
    else {
      this.lastText = observation.text;
      this.stableObservations = 1;
    }
    if (
      (!observation.generating || observation.completionActionAvailable === true) &&
      this.stableObservations >= this.requiredStableObservations
    ) {
      return 'complete';
    }
    return 'waiting';
  }
}
