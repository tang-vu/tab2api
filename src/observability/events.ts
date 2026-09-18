/**
 * Bounded runtime event log. Events carry only operational metadata — event type, session
 * states, error codes, request ids, turn phases — and must never carry prompt text,
 * assistant output, file names, titles, or any other user content. The ring buffer is
 * fixed-size so diagnostics cannot grow unboundedly or become a transcript by accident.
 */

export type RuntimeEventType =
  | 'session.state'
  | 'turn.phase'
  | 'turn.submitted'
  | 'turn.completed'
  | 'turn.failed'
  | 'request.error'
  | 'queue.draining'
  | 'queue.resumed'
  | 'browser.reset'
  | 'image.completed'
  | 'image.failed'
  | 'project.completed'
  | 'project.failed';

export interface RuntimeEvent {
  /** Monotonic sequence number, so ordering survives a wrap of the ring. */
  readonly seq: number;
  readonly at: string;
  readonly type: RuntimeEventType;
  /** Content-free detail: an error code, session state, or turn phase only. */
  readonly detail?: string;
  readonly requestId?: string;
}

const DEFAULT_CAPACITY = 256;

export class EventLog {
  private readonly ring: (RuntimeEvent | undefined)[];
  private head = 0;
  private count = 0;
  private sequence = 0;

  constructor(private readonly capacity = DEFAULT_CAPACITY) {
    this.ring = new Array<RuntimeEvent | undefined>(capacity);
  }

  record(type: RuntimeEventType, detail?: string, requestId?: string): RuntimeEvent {
    const event: RuntimeEvent = {
      seq: this.sequence,
      at: new Date().toISOString(),
      type,
      ...(detail === undefined ? {} : { detail }),
      ...(requestId === undefined ? {} : { requestId }),
    };
    this.sequence += 1;
    this.ring[this.head] = event;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    return event;
  }

  /** Oldest-first list of retained events, optionally limited to the newest `limit`. */
  list(limit?: number): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    for (let index = 0; index < this.count; index += 1) {
      const position = (this.head - this.count + index + this.capacity) % this.capacity;
      const event = this.ring[position];
      if (event !== undefined) events.push(event);
    }
    return limit === undefined || events.length <= limit
      ? events
      : events.slice(events.length - limit);
  }

  get size(): number {
    return this.count;
  }
}
