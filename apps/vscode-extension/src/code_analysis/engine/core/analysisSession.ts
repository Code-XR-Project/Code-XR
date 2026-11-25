/**
 * Analysis Session Types and Interfaces
 * Unified session structure for the new analysis engine
 */

import * as vscode from 'vscode';
import { FileHash } from '../utils/fileHashCalculator';

export type AnalysisMode = 'LivePanel' | 'XR' | 'VisualizeDOM';
export type TargetType = 'file' | 'directory';
export type AnalysisStatus = 'creating' | 'analyzing' | 'monitoring' | 'error' | 'closed';

/**
 * Unified Analysis Session Interface
 * Handles both file and directory analysis with a single structure
 */
export interface UnifiedAnalysisSession {
    // Identification
    id: string;                    // Generated nonce
    
    // Target information
    targetPath: string;            // File path OR directory path
    targetType: TargetType;        // 'file' | 'directory'
    targetName: string;            // File name OR directory name
    
    // Analysis configuration
    analysisMode: AnalysisMode;    // 'LivePanel' | 'XR'
    isDeep: boolean;               // true for deep analysis (applies to directories mainly)
    
    // Server information (added for server integration)
    assignedPort?: number;         // Puerto asignado al servidor de esta sesión
    serverUrl?: string;            // URL completa del servidor
    serverId?: string;             // ID del servidor en el registro activo
    watcherId?: string;            // ID del watcher activo para esta sesión
    
    // Session state
    status: AnalysisStatus;        // Current status
    progress?: number;             // Progress percentage (0-100)
    error?: string;                // Error message if failed
    
    // Timing
    startTime: Date;               // When analysis started
    endTime?: Date;                // When analysis completed/failed
    
    // Hash and validation
    hash256: string;               // SHA256 of target (file content or directory structure)
    
    // Results and output
    outputDirectory: string;       // Directory name: {targetName}_{mode}_{type}_{nonce}
    outputPath: string;            // Full path to analysis results directory
    savedFilesPath?: string;       // Path where processed template files are saved
    port?: number;                 // Port where analysis is being served (if applicable)
    
    // Required files for analysis
    requiredFiles: Map<string, string>; // Map of filename -> file content
    
    // Template paths (SOLO rutas, no contenido)
    templatePaths: Map<string, string>; // Map of filename -> file path
    
    // Directory analysis specific fields
    directoriesToAnalyze?: string[];    // Filtered directories for analysis (only for directory analysis)
    filesToHash?: FileHash[];           // File paths and their SHA256 hashes (only for directory analysis)
    
    // Metadata
    metadata: UnifiedAnalysisSessionMetadata;
}

/**
 * Session metadata interface - SIMPLIFICADO
 */
export interface UnifiedAnalysisSessionMetadata {
    targetSize?: number;            // File size OR total directory size
    lastModified?: Date;            // Last modification time
    [key: string]: any;            // Flexible para cualquier metadata adicional
}

/**
 * Session creation parameters
 */
export interface SessionCreationParams {
    targetPath: string;
    analysisMode: AnalysisMode;
    targetType: TargetType;
    isDeep?: boolean;
    context: vscode.ExtensionContext;
}
