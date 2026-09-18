import type { Page } from 'playwright';

export interface BrowserController {
  /**
   * Hands the caller a page it owns: the caller must close it, usually in a `finally`.
   * Implementations track outstanding pages so `openPageCount` can report leaks.
   */
  getPage(): Promise<Page>;
  /**
   * Pages currently leased to callers. A nonzero value after an operation's `finally`
   * block means a page escaped its owner — a leak worth surfacing in diagnostics.
   */
  openPageCount?(): number;
  close(): Promise<void>;
}
