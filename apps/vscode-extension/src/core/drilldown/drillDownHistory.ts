import type { DrillTarget } from './drillDownModels';
import { sameTarget } from './drillDownPaths';

/** History entries kept; the oldest non-home entries go first. */
export const DRILL_HISTORY_LIMIT = 50;

/**
 * Browser-like history of the drill-down (#334). The first entry is always
 * the session's own target (home). Opening a target drops the forward
 * stack; back and forward move one step; re-opening the current target is
 * not a new entry.
 */
export class DrillHistory {
    private readonly entries: DrillTarget[];
    private index = 0;
    private readonly limit: number;

    constructor(home: DrillTarget, limit: number = DRILL_HISTORY_LIMIT) {
        this.entries = [home];
        this.limit = Math.max(2, limit);
    }

    public get home(): DrillTarget {
        return this.entries[0];
    }

    public get current(): DrillTarget {
        return this.entries[this.index];
    }

    public get position(): number {
        return this.index;
    }

    public get length(): number {
        return this.entries.length;
    }

    public get canBack(): boolean {
        return this.index > 0;
    }

    public get canForward(): boolean {
        return this.index < this.entries.length - 1;
    }

    public get atHome(): boolean {
        return sameTarget(this.current, this.home);
    }

    /** What back would show, without moving. */
    public peekBack(): DrillTarget | null {
        return this.canBack ? this.entries[this.index - 1] : null;
    }

    /** What forward would show, without moving. */
    public peekForward(): DrillTarget | null {
        return this.canForward ? this.entries[this.index + 1] : null;
    }

    /** Opens a target: a new entry after the current one, the forward stack is dropped. */
    public push(target: DrillTarget): DrillTarget {
        if (sameTarget(target, this.current)) {
            return this.current;
        }
        this.entries.splice(this.index + 1);
        this.entries.push({ kind: target.kind, relativePath: target.relativePath });
        this.index = this.entries.length - 1;
        while (this.entries.length > this.limit) {
            // Home stays first: trim the oldest entry after it.
            this.entries.splice(1, 1);
            this.index--;
        }
        return this.current;
    }

    public back(): DrillTarget | null {
        if (!this.canBack) {
            return null;
        }
        this.index--;
        return this.current;
    }

    public forward(): DrillTarget | null {
        if (!this.canForward) {
            return null;
        }
        this.index++;
        return this.current;
    }

    /** Going home is a jump like any other, so Back returns to where you were. */
    public goHome(): DrillTarget {
        return this.push(this.home);
    }

    /** Puts back a snapshot taken before a move whose target could not be shown. */
    public reset(snapshot: { entries: readonly DrillTarget[]; index: number }): void {
        if (!snapshot.entries.length) {
            return;
        }
        this.entries.splice(0, this.entries.length, ...snapshot.entries.map((entry) => ({ ...entry })));
        this.index = Math.min(Math.max(0, snapshot.index), this.entries.length - 1);
    }

    public snapshot(): { entries: DrillTarget[]; index: number } {
        return { entries: this.entries.map((entry) => ({ ...entry })), index: this.index };
    }
}
