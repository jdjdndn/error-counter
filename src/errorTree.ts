import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from './config';

/**
 * 错误树节点
 */
class ErrorItem extends vscode.TreeItem {
    constructor(
        public readonly uri: vscode.Uri,
        public readonly diagnostic: vscode.Diagnostic,
        public readonly line: number
    ) {
        super('', vscode.TreeItemCollapsibleState.None);

        const fileName = uri.fsPath.split(/[/\\]/).pop() || '';
        const message = diagnostic.message.substring(0, 60) + (diagnostic.message.length > 60 ? '...' : '');

        this.label = `${fileName}:${line + 1}`;
        this.description = message;
        this.tooltip = diagnostic.message;
        this.iconPath = diagnostic.severity === vscode.DiagnosticSeverity.Error
            ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
            : new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));

        this.command = {
            command: 'errorCounter.goToError',
            title: 'Go to Error',
            arguments: [uri, line, diagnostic.range.start.character]
        };

        this.contextValue = 'errorItem';
    }
}

/**
 * 文件分组节点
 */
class FileItem extends vscode.TreeItem {
    constructor(
        public readonly uri: vscode.Uri,
        public readonly errors: number,
        public readonly warnings: number
    ) {
        super('', vscode.TreeItemCollapsibleState.Collapsed);

        const fileName = uri.fsPath.split(/[/\\]/).pop() || '';
        this.label = fileName;
        // 使用纯数字显示，更清晰
        this.description = '';
        if (errors > 0) this.description += `E:${errors}`;
        if (warnings > 0) this.description += (errors > 0 ? ' ' : '') + `W:${warnings}`;
        this.iconPath = vscode.ThemeIcon.File;
        this.resourceUri = uri;
        this.tooltip = `${uri.fsPath}\n错误: ${errors}, 警告: ${warnings}`;
        this.contextValue = 'fileItem';
    }
}

/**
 * 文件夹分组节点
 */
class FolderItem extends vscode.TreeItem {
    constructor(
        public readonly folderPath: string,
        public readonly folderName: string,
        public readonly errors: number,
        public readonly warnings: number,
        public readonly fileCount: number
    ) {
        super('', vscode.TreeItemCollapsibleState.Collapsed);

        // 在文件夹名称中直接显示错误数（绕过 VSCode badge 限制）
        let displayName = folderName;
        this.label = displayName;
        // 使用描述显示错误数
        this.description = '';
        if (errors > 0) this.description += `E:${errors}`;
        if (warnings > 0) this.description += (errors > 0 ? ' ' : '') + `W:${warnings}`;
        this.tooltip = `${folderPath}\n${fileCount} 个文件有错误\n错误: ${errors}, 警告: ${warnings}`;
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'folderItem';
    }
}

/**
 * 统计信息节点
 */
class StatsItem extends vscode.TreeItem {
    constructor(stats: { files: number; errors: number; warnings: number }) {
        super('', vscode.TreeItemCollapsibleState.None);

        this.label = `📊 统计`;
        this.description = `🔴${stats.errors} 🟡${stats.warnings} | ${stats.files} 个文件`;
        this.tooltip = `项目错误统计\n错误: ${stats.errors}\n警告: ${stats.warnings}\n有问题的文件: ${stats.files}`;
        this.iconPath = new vscode.ThemeIcon('graph');
        this.contextValue = 'statsItem';
    }
}

/**
 * 错误概览面板（侧边栏 TreeView）
 */
export class ErrorTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private configManager: ConfigManager;
    private diagnostics: Map<string, vscode.Diagnostic[]> = new Map();

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;

        // 监听诊断变化
        vscode.languages.onDidChangeDiagnostics(() => {
            this.refresh();
        });

        // 延迟初始化
        setTimeout(() => {
            this.refresh();
        }, 3000);
    }

    refresh(): void {
        this.diagnostics.clear();
        const config = this.configManager.getConfig();

        if (!config.enabled) {
            this._onDidChangeTreeData.fire();
            return;
        }

        const allDiagnostics = vscode.languages.getDiagnostics();
        for (const [uri, diags] of allDiagnostics) {
            if (this.configManager.shouldIgnore(uri)) {
                continue;
            }

            const filtered = diags.filter(d =>
                (d.severity === vscode.DiagnosticSeverity.Error && config.showErrors) ||
                (d.severity === vscode.DiagnosticSeverity.Warning && config.showWarnings)
            );

            if (filtered.length > 0) {
                this.diagnostics.set(uri.toString(), filtered);
            }
        }

        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (!element) {
            // 根节点：显示统计和文件夹分组
            const items: vscode.TreeItem[] = [];

            // 添加统计信息
            const stats = this.getStats();
            if (stats.errors > 0 || stats.warnings > 0) {
                items.push(new StatsItem(stats));
            }

            // 按文件夹分组
            const folderMap = new Map<string, { files: FileItem[]; errors: number; warnings: number }>();

            for (const [uriStr, diags] of this.diagnostics) {
                const uri = vscode.Uri.parse(uriStr);
                const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
                const warnings = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
                const fileItem = new FileItem(uri, errors, warnings);

                // 获取文件夹路径
                const dirPath = path.dirname(uri.fsPath);
                const folderName = dirPath.split(/[/\\]/).pop() || dirPath;

                if (!folderMap.has(dirPath)) {
                    folderMap.set(dirPath, { files: [], errors: 0, warnings: 0 });
                }

                const folder = folderMap.get(dirPath)!;
                folder.files.push(fileItem);
                folder.errors += errors;
                folder.warnings += warnings;
            }

            // 创建文件夹节点
            for (const [folderPath, data] of folderMap) {
                const folderName = folderPath.split(/[/\\]/).pop() || folderPath;
                const folderItem = new FolderItem(folderPath, folderName, data.errors, data.warnings, data.files.length);

                // 将文件作为子节点
                folderItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                (folderItem as any).children = data.files;

                items.push(folderItem);
            }

            // 按错误数排序
            items.sort((a, b) => {
                // 统计信息排在最前面
                if (a instanceof StatsItem) return -1;
                if (b instanceof StatsItem) return 1;

                const errorsA = a instanceof FolderItem ? a.errors : 0;
                const errorsB = b instanceof FolderItem ? b.errors : 0;
                return errorsB - errorsA;
            });

            return Promise.resolve(items);
        } else if (element instanceof FolderItem) {
            // 显示文件夹下的文件列表
            const children = (element as any).children || [];
            return Promise.resolve(children);
        } else if (element instanceof FileItem) {
            // 显示文件下的错误列表
            const diags = this.diagnostics.get(element.uri.toString()) || [];
            const items: vscode.TreeItem[] = [];

            for (const diag of diags) {
                items.push(new ErrorItem(element.uri, diag, diag.range.start.line));
            }

            return Promise.resolve(items);
        }

        return Promise.resolve([]);
    }

    public getStats(): { files: number; errors: number; warnings: number } {
        let errors = 0;
        let warnings = 0;

        for (const diags of this.diagnostics.values()) {
            for (const d of diags) {
                if (d.severity === vscode.DiagnosticSeverity.Error) {
                    errors++;
                } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
                    warnings++;
                }
            }
        }

        return {
            files: this.diagnostics.size,
            errors,
            warnings
        };
    }
}
