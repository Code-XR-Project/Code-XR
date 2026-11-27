/** Clamps a reported percentage to 0-100, or undefined for an unknown one (an indeterminate bar, #153). */
export function clampPercent(percent: number | undefined): number | undefined {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) {
        return undefined;
    }
    return Math.min(100, Math.max(0, percent));
}
