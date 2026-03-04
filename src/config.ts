import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { minimatch } from 'minimatch';

export interface ErrorCounterConfig {
    enabled: boolean;
    showErrors: boolean;
    showWarnings: boolean;
    showStatusBar: boolean;
    showErrorLens: boolean;
    ignorePatterns: string[];
    showErrorIgnoreFile: boolean;
}

export class ConfigManager {
    private config: ErrorCounterConfig;
    private ignoreFilePatterns: string[] = [];
    private workspaceRoot: vscode.Uri | undefined;

    constructor() {
        this.config = this.loadConfig();
        this.loadIgnoreFile();
    }

    private loadConfig(): ErrorCounterConfig {
        const cfg = vscode.workspace.getConfiguration('errorCounter');
        return {
            enabled: cfg.get<boolean>('enabled', true),
            showErrors: cfg.get<boolean>('showErrors', true),
            showWarnings: cfg.get<boolean>('showWarnings', true),
            showStatusBar: cfg.get<boolean>('showStatusBar', true),
            showErrorLens: cfg.get<boolean>('showErrorLens', true),
            ignorePatterns: cfg.get<string[]>('ignorePatterns', []),
            showErrorIgnoreFile: cfg.get<boolean>('showErrorIgnoreFile', true)
        };
    }

    private loadIgnoreFile(): void {
        this.ignoreFilePatterns = [];
        const workspaces = vscode.workspace.workspaceFolders;
        if (!workspaces || workspaces.length === 0) {
            return;
        }

        this.workspaceRoot = workspaces[0].uri;

        if (this.config.showErrorIgnoreFile) {
            const ignoreFilePath = vscode.Uri.joinPath(this.workspaceRoot, '.errorignore');
            const ignoreFilePathFs = ignoreFilePath.fsPath;

            if (fs.existsSync(ignoreFilePathFs)) {
                try {
                    const content = fs.readFileSync(ignoreFilePathFs, 'utf-8');
                    const lines = content.split(/\r?\n/);
                    for (const line of lines) {
                        const trimmed = line.trim();
                        // Skip empty lines and comments
                        if (trimmed && !trimmed.startsWith('#')) {
                            this.ignoreFilePatterns.push(this.convertGitignoreToGlob(trimmed));
                        }
                    }
                } catch (error) {
                    console.error('Error reading .errorignore file:', error);
                }
            }
        }
    }

    private convertGitignoreToGlob(pattern: string): string {
        // Convert .gitignore style patterns to glob patterns
        if (pattern.endsWith('/')) {
            pattern = pattern.slice(0, -1);
        }

        // If pattern doesn't contain a path separator, make it match anywhere
        if (!pattern.includes('/')) {
            return `**/${pattern}`;
        }

        // If pattern starts with /, it's relative to root
        if (pattern.startsWith('/')) {
            return pattern.substring(1);
        }

        return `**/${pattern}`;
    }

    public reload(): void {
        this.config = this.loadConfig();
        this.loadIgnoreFile();
    }

    public getConfig(): ErrorCounterConfig {
        return this.config;
    }

    public shouldIgnore(uri: vscode.Uri): boolean {
        const allPatterns = [...this.config.ignorePatterns, ...this.ignoreFilePatterns];

        // Get relative path from workspace root
        let relativePath: string;
        if (this.workspaceRoot) {
            relativePath = path.relative(this.workspaceRoot.fsPath, uri.fsPath);
        } else {
            relativePath = uri.fsPath;
        }

        // Normalize path separators to forward slashes for glob matching
        relativePath = relativePath.replace(/\\/g, '/');

        for (const pattern of allPatterns) {
            // Try matching the path as-is
            if (minimatch(relativePath, pattern, { dot: true })) {
                return true;
            }

            // Also try matching as a directory (for folder paths)
            if (minimatch(relativePath + '/', pattern, { dot: true })) {
                return true;
            }

            // Try basename matching for patterns like *.d.ts
            if (minimatch(path.basename(uri.fsPath), pattern, { dot: true })) {
                return true;
            }
        }

        return false;
    }
}
