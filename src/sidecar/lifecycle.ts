export type SidecarState = 'idle' | 'starting' | 'listening' | 'stopping' | 'stopped' | 'failed';

export type SidecarStopReason = 'parent_stream_closed' | 'parent_request' | 'SIGINT' | 'SIGTERM';

export interface SidecarAddress {
  host: '127.0.0.1' | '::1';
  port: number;
}

export interface SidecarOperations {
  start(): Promise<SidecarAddress>;
  stop(): Promise<void>;
}

interface OutputSink {
  write(chunk: string): boolean;
}

export interface SidecarEvent {
  protocol: 1;
  sequence: number;
  timestamp: string;
  event: 'starting' | 'listening' | 'status' | 'stopping' | 'stopped' | 'fatal' | 'protocol_error';
  state: SidecarState;
  host?: SidecarAddress['host'];
  port?: number;
  reason?: SidecarStopReason;
  code?: 'startup_failed' | 'invalid_command' | 'command_too_large';
}

export class SidecarReporter {
  private sequence = 0;

  constructor(private readonly output: OutputSink) {}

  emit(event: Omit<SidecarEvent, 'protocol' | 'sequence' | 'timestamp'>): void {
    const envelope: SidecarEvent = {
      protocol: 1,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.output.write(`${JSON.stringify(envelope)}\n`);
  }
}

export class SidecarLifecycle {
  private state: SidecarState = 'idle';
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly operations: SidecarOperations,
    private readonly reporter: SidecarReporter,
  ) {}

  currentState(): SidecarState {
    return this.state;
  }

  start(): Promise<void> {
    if (this.state !== 'idle') throw new Error('Sidecar lifecycle can only be started once.');
    this.starting = this.performStart();
    return this.starting;
  }

  private async performStart(): Promise<void> {
    this.state = 'starting';
    this.reporter.emit({ event: 'starting', state: this.state });
    try {
      const address = await this.operations.start();
      this.state = 'listening';
      this.reporter.emit({ event: 'listening', state: this.state, ...address });
    } catch (error) {
      this.state = 'failed';
      this.reporter.emit({ event: 'fatal', state: this.state, code: 'startup_failed' });
      throw error;
    }
  }

  reportStatus(): void {
    this.reporter.emit({ event: 'status', state: this.state });
  }

  shutdown(reason: SidecarStopReason): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopping = this.performShutdown(reason);
    return this.stopping;
  }

  reportProtocolError(code: 'invalid_command' | 'command_too_large'): void {
    this.reporter.emit({ event: 'protocol_error', state: this.state, code });
  }

  private async performShutdown(reason: SidecarStopReason): Promise<void> {
    if (this.state === 'stopped') return;
    if (this.state === 'starting' && this.starting !== undefined) {
      await this.starting.catch(() => undefined);
    }
    this.state = 'stopping';
    this.reporter.emit({ event: 'stopping', state: this.state, reason });
    try {
      await this.operations.stop();
    } finally {
      this.state = 'stopped';
      this.reporter.emit({ event: 'stopped', state: this.state, reason });
    }
  }
}

type SidecarCommand = { command: 'status' } | { command: 'shutdown' };

export class SidecarCommandDecoder {
  private buffer = '';
  private atStreamStart = true;

  constructor(
    private readonly onCommand: (command: SidecarCommand) => void,
    private readonly onError: (code: 'invalid_command' | 'command_too_large') => void,
    private readonly maximumLineBytes = 4096,
  ) {}

  push(chunk: string): void {
    if (this.atStreamStart) {
      this.atStreamStart = false;
      // RFC 8259 permits parsers to ignore one leading BOM for interoperability. Some
      // Windows Process.StandardInput writers emit it before their first redirected line.
      if (chunk.startsWith('\uFEFF')) chunk = chunk.slice(1);
    }
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maximumLineBytes) {
      this.buffer = '';
      this.onError('command_too_large');
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.decode(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private decode(line: string): void {
    try {
      const value: unknown = JSON.parse(line);
      if (
        typeof value !== 'object' ||
        value === null ||
        !('command' in value) ||
        (value.command !== 'status' && value.command !== 'shutdown')
      ) {
        this.onError('invalid_command');
        return;
      }
      this.onCommand({ command: value.command });
    } catch {
      this.onError('invalid_command');
    }
  }
}
