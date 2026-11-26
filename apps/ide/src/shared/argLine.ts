/** An argument list typed on one line (A12's MCP server form), as plain shells split it. */

/** Splits an argument line like a shell would for plain cases: spaces separate, quotes group. */
export function splitArgs(line: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let started = false;
    for (const char of line) {
        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
            started = true;
        } else if (/\s/.test(char)) {
            if (started) {
                args.push(current);
                current = '';
                started = false;
            }
        } else {
            current += char;
            started = true;
        }
    }
    if (started) {
        args.push(current);
    }
    return args;
}

/** The reverse of splitArgs, for showing and editing a stored list. */
export function joinArgs(args: readonly string[]): string {
    return args.map((arg) => {
        if (arg && !/[\s"']/.test(arg)) {
            return arg;
        }
        return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
    }).join(' ');
}
