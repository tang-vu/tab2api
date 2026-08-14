export interface ResponseMetadata {
  id: string;
  createdAt: number;
  status: 'completed' | 'failed';
}

export class MetadataStore {
  private readonly entries = new Map<string, ResponseMetadata>();

  constructor(private readonly limit = 100) {}

  set(entry: ResponseMetadata): void {
    this.entries.set(entry.id, entry);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get(id: string): ResponseMetadata | undefined {
    return this.entries.get(id);
  }
}
