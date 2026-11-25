/**
 * Chart Type Command Factory
 * The one "select chart type" command shape shared by the file and
 * directory settings. Each caller passes its own id, description, logger
 * and error reporting, so the two error dialects stay as they were.
 */

import { CommandRegistration } from './analysis-file-mode/analysisFileModeCommands';
import type { ScopedLogger } from '../../../../platform/logging/sink';

export interface ChartTypeCommandOptions {
    commandId: string;
    description: string;
    /** Opens the setting's chart-type quick pick. */
    showSelection: () => Promise<void>;
    refreshCallback: () => void;
    logger: ScopedLogger;
    /** Logs and shows a failure of showSelection, in the caller's own words. */
    reportError: (error: unknown) => void;
}

export function createChartTypeCommands(options: ChartTypeCommandOptions): CommandRegistration[] {
    return [
        {
            commandId: options.commandId,
            callback: async () => {
                options.logger.debug('Chart type selection command executed');
                try {
                    // Use the chart type setting's built-in selection dialog
                    await options.showSelection();
                } catch (error) {
                    options.reportError(error);
                }
                options.refreshCallback();
            },
            description: options.description,
        },
    ];
}
