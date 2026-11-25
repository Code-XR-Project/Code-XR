// Types only: every import here is `import type`, so this module never loads
// the item modules. ModularTreeDataProvider loads them lazily on purpose.
import type { ServerTreeItem } from '../servers/items/serverItems';
import type { ActiveServerTreeItem } from '../active_servers/items/activeServerItems';
import type { BabiaExampleTreeItem } from '../babia_examples/items/babiaExampleItems';
import type { VisualizeDataModularTreeItem } from '../../features/visualize-data/views/visualizeDataSectionItems';
import type { CodeAnalysisTreeItem } from '../../code_analysis/views/items/analysisItems';
import type { PythonEnvModularTreeItem } from '../../features/python-env/views/pythonEnvItems';
import type { VisualizationSettingsModularTreeItem } from '../../features/visualization-settings/views/visualizationSettingsSectionItems';
import type { LearnMoreModularTreeItem } from '../../features/learn-more/views/learnMoreItems';

/**
 * An item as a section provider produces and consumes it: one of the eight
 * section item classes, in sidebar order. ModularTreeDataProvider bridges
 * these to and from the ModularTreeItem the view renders.
 */
export type SectionChild =
    | ServerTreeItem
    | ActiveServerTreeItem
    | BabiaExampleTreeItem
    | VisualizeDataModularTreeItem
    | CodeAnalysisTreeItem
    | PythonEnvModularTreeItem
    | VisualizationSettingsModularTreeItem
    | LearnMoreModularTreeItem;
