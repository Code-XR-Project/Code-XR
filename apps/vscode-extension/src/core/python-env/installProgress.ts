/**
 * Turns "this step starts at N%" into the increments a host progress expects.
 *
 * `HostProgress.report` follows the VS Code contract: `increment` is ADDED to
 * what was reported before. The environment set-up thinks in milestones
 * (Python found at 20%, packages from 80%), so it reports through this
 * tracker, which sends only the difference and never moves backwards.
 * Reporting the milestones themselves as increments made VS Code overshoot
 * and a host keeping the largest value stall (#158).
 */
export interface IncrementSink {
    report(value: { message?: string; increment?: number }): void;
}

export class InstallProgress {
    private readonly sink: IncrementSink;
    private readonly onMessage: (message: string) => void;
    private current = 0;

    constructor(sink: IncrementSink, onMessage: (message: string) => void = () => undefined) {
        this.sink = sink;
        this.onMessage = onMessage;
    }

    /** The percentage reached so far (0-100). */
    get percent(): number {
        return this.current;
    }

    /** Moves the bar to `percent` (never back) and shows `message`. */
    to(percent: number, message: string): void {
        const target = Math.min(100, Math.max(this.current, Number.isFinite(percent) ? percent : this.current));
        const increment = target - this.current;
        this.current = target;
        this.sink.report(increment > 0 ? { increment, message } : { message });
        this.onMessage(message);
    }

    /** Shows `message` without moving the bar. */
    message(message: string): void {
        this.sink.report({ message });
        this.onMessage(message);
    }

    /**
     * Splits `from`-`to` into `steps` equal parts: `step(i, message)` moves the
     * bar to the start of part `i` (0-based), so the last part ends where the
     * next milestone begins.
     */
    span(from: number, to: number, steps: number): (index: number, message: string) => void {
        const count = Math.max(1, steps);
        return (index, message) => {
            const clamped = Math.min(Math.max(index, 0), count);
            this.to(from + ((to - from) * clamped) / count, message);
        };
    }
}
