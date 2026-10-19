/**
 * Keeps one Codex host in existence: asked to on core startup and whenever the host's link drops.
 * Bounded on purpose — a machine without a working Codex would otherwise spawn a doomed host every
 * few seconds forever — and the launcher ensures a host again whenever someone opens a Codex lane.
 * Finding a live host is the normal answer and starts nothing.
 */
export class CodexHostKeeper {
  private running = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: {
    readonly ensureHost: () => Promise<unknown>;
    readonly attempts?: number;
    /** Wait before attempt n+1 is n times this. */
    readonly backoffMs?: number;
    readonly log?: (line: string) => void;
  }) {}

  ensure(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void this.attempt(1);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async attempt(attempt: number): Promise<void> {
    const attempts = this.options.attempts ?? 3;
    try {
      await this.options.ensureHost();
      this.running = false;
    } catch (error) {
      this.options.log?.(`Codex host unavailable (attempt ${attempt} of ${attempts}): ${error instanceof Error ? error.message : "unknown error"}`);
      if (attempt >= attempts || this.stopped) { this.running = false; return; }
      this.timer = setTimeout(() => { void this.attempt(attempt + 1); }, (this.options.backoffMs ?? 2_000) * attempt);
      this.timer.unref();
    }
  }
}
