import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DiagnosticWatcher, DiagnosticCount } from './diagnosticWatcher';
import { ConfigManager } from './config';

/**
 * 文件装饰提供者 - 只处理文件夹的错误聚合显示
 * 文件badge由其他插件显示，本插件不处理
 */
export class ErrorDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private diagnosticWatcher: DiagnosticWatcher;
    private configManager: ConfigManager;
    private pendingRefresh: ReturnType<typeof setTimeout> | undefined;

    constructor(diagnosticWatcher: DiagnosticWatcher, configManager: ConfigManager) {
        this.diagnosticWatcher = diagnosticWatcher;
        this.configManager = configManager;

        // Listen for diagnostic changes and trigger decoration refresh
        this.diagnosticWatcher.onDidChangeDiagnostics(() => {
            this.debouncedRefresh();
        });
    }

    private debouncedRefresh(): void {
        if (this.pendingRefresh) {
            clearTimeout(this.pendingRefresh);
        }
        this.pendingRefresh = setTimeout(() => {
            this._onDidChangeFileDecorations.fire(undefined);
            this.pendingRefresh = undefined;
        }, 100);
    }

    provideFileDecoration(
        uri: vscode.Uri,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.FileDecoration> {
        const config = this.configManager.getConfig();

        if (!config.enabled) {
            return undefined;
        }

        // Only handle file scheme URIs
        if (uri.scheme !== 'file') {
            return undefined;
        }

        // Check if this URI should be ignored
        if (this.configManager.shouldIgnore(uri)) {
            return undefined;
        }

        // 只处理文件夹，不处理文件（文件已有其他插件显示badge）
        const isFolder = this.isFolder(uri);
        if (!isFolder) {
            return undefined;
        }

        const count = this.diagnosticWatcher.getFolderCount(uri);

        // 只为有错误的文件夹显示装饰
        if (count.errors > 0 || count.warnings > 0) {
            return this.createFolderDecoration(count);
        }

        return undefined;
    }

    /**
     * 为文件夹创建装饰（显示小圆点指示器，悬停查看详情）
     */
    private createFolderDecoration(count: DiagnosticCount): vscode.FileDecoration {
        const tooltipParts: string[] = [];
        let color: vscode.ThemeColor | undefined;

        if (count.errors > 0) {
            tooltipParts.push(`${count.errors} 个错误`);
            color = new vscode.ThemeColor('list.errorForeground');
        }

        if (count.warnings > 0) {
            tooltipParts.push(`${count.warnings} 个警告`);
            if (!color) {
                color = new vscode.ThemeColor('list.warningForeground');
            }
        }

        const tooltip = 'Error Counter (文件夹聚合): ' + tooltipParts.join(', ');

        // 文件夹只能显示小圆点，但悬停可以看到详细信息
        return new vscode.FileDecoration(undefined, tooltip, color);
    }

    private isFolder(uri: vscode.Uri): boolean {
        try {
            if (fs.existsSync(uri.fsPath)) {
                return fs.statSync(uri.fsPath).isDirectory();
            }
        } catch {
            // Ignore errors (file might not exist in some cases)
        }

        // Fallback heuristic: check if it has no extension
        const basename = path.basename(uri.fsPath);
        return !basename.includes('.');
    }

    public refresh(): void {
        if (this.pendingRefresh) {
            clearTimeout(this.pendingRefresh);
            this.pendingRefresh = undefined;
        }
        this._onDidChangeFileDecorations.fire(undefined);
    }

    public dispose(): void {
        if (this.pendingRefresh) {
            clearTimeout(this.pendingRefresh);
        }
    }
}
