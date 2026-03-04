import * as vscode from 'vscode';
import { ConfigManager } from './config';
import { DiagnosticWatcher } from './diagnosticWatcher';
import { ErrorDecorationProvider } from './errorDecorationProvider';
import { StatusBarProvider } from './statusBar';
import { ErrorLensProvider } from './errorLens';
import { ErrorTreeProvider } from './errorTree';
import { ErrorNotifier } from './errorNotifier';

let configManager: ConfigManager;
let diagnosticWatcher: DiagnosticWatcher;
let decorationProvider: ErrorDecorationProvider;
let statusBarProvider: StatusBarProvider;
let errorLensProvider: ErrorLensProvider;
let errorTreeProvider: ErrorTreeProvider;
let errorNotifier: ErrorNotifier;
let fileDecorationProviderDisposable: vscode.Disposable;

export function activate(context: vscode.ExtensionContext) {
    console.log('Error Counter extension is now active!');

    // Initialize components
    configManager = new ConfigManager();
    diagnosticWatcher = new DiagnosticWatcher(configManager);
    decorationProvider = new ErrorDecorationProvider(diagnosticWatcher, configManager);

    // Register file decoration provider (file tree badges)
    fileDecorationProviderDisposable = vscode.window.registerFileDecorationProvider(decorationProvider);
    context.subscriptions.push(fileDecorationProviderDisposable);

    // Status bar (show total errors in status bar)
    statusBarProvider = new StatusBarProvider(diagnosticWatcher, configManager);
    context.subscriptions.push(statusBarProvider);

    // Error lens (show errors inline in code)
    errorLensProvider = new ErrorLensProvider(configManager);
    context.subscriptions.push(errorLensProvider);

    // Error tree (sidebar panel)
    errorTreeProvider = new ErrorTreeProvider(configManager);
    const treeView = vscode.window.createTreeView('errorCounterPanel', {
        treeDataProvider: errorTreeProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);

    // Error notifier
    errorNotifier = new ErrorNotifier(configManager);
    context.subscriptions.push(errorNotifier);

    // Register commands
    registerCommands(context);

    // Watch for .errorignore file changes
    const watcher = vscode.workspace.createFileSystemWatcher('**/.errorignore');
    watcher.onDidChange(() => {
        configManager.reload();
        decorationProvider.refresh();
        errorTreeProvider.refresh();
    });
    watcher.onDidCreate(() => {
        configManager.reload();
        decorationProvider.refresh();
        errorTreeProvider.refresh();
    });
    watcher.onDidDelete(() => {
        configManager.reload();
        decorationProvider.refresh();
        errorTreeProvider.refresh();
    });
    context.subscriptions.push(watcher);

    // Add cleanup
    context.subscriptions.push({
        dispose: () => {
            diagnosticWatcher.dispose();
            statusBarProvider.dispose();
            errorLensProvider.dispose();
            errorNotifier.dispose();
        }
    });
}

function registerCommands(context: vscode.ExtensionContext) {
    // 刷新
    context.subscriptions.push(
        vscode.commands.registerCommand('errorCounter.refresh', () => {
            configManager.reload();
            decorationProvider.refresh();
            errorTreeProvider.refresh();
            vscode.window.showInformationMessage('Error Counter 刷新完成');
        })
    );

    // 开关
    context.subscriptions.push(
        vscode.commands.registerCommand('errorCounter.toggle', () => {
            const config = vscode.workspace.getConfiguration('errorCounter');
            const currentValue = config.get<boolean>('enabled', true);
            config.update('enabled', !currentValue, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Error Counter ${!currentValue ? '已启用' : '已禁用'}`);
        })
    );

    // 跳转到错误
    context.subscriptions.push(
        vscode.commands.registerCommand('errorCounter.goToError', (uri: vscode.Uri, line: number, character: number) => {
            vscode.window.showTextDocument(uri, {
                selection: new vscode.Range(line, character, line, character + 1)
            });
        })
    );

    // 下一个错误
    context.subscriptions.push(
        vscode.commands.registerCommand('errorCounter.nextError', async () => {
            await navigateError(1);
        })
    );

    // 上一个错误
    context.subscriptions.push(
        vscode.commands.registerCommand('errorCounter.prevError', async () => {
            await navigateError(-1);
        })
    );

    // 显示统计
    context.subscriptions.push(
        vscode.commands.registerCommand('errorCounter.showStats', () => {
            const stats = errorTreeProvider.getStats();
            const message = `📊 项目统计: ${stats.files} 个文件有问题 | ${stats.errors} 个错误 | ${stats.warnings} 个警告`;
            vscode.window.showInformationMessage(message);
        })
    );

    // 导出错误报告
    context.subscriptions.push(
        vscode.commands.registerCommand('errorCounter.exportReport', async () => {
            await exportErrorReport();
        })
    );

    // 复制错误信息
    context.subscriptions.push(
        vscode.commands.registerCommand('errorCounter.copyError', (item: any) => {
            if (item && item.tooltip) {
                vscode.env.clipboard.writeText(item.tooltip);
                vscode.window.showInformationMessage('错误信息已复制');
            }
        })
    );
}

async function navigateError(direction: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const allDiagnostics = vscode.languages.getDiagnostics();

    // 收集所有错误位置
    const errorLocations: { uri: vscode.Uri; range: vscode.Range; severity: vscode.DiagnosticSeverity }[] = [];

    for (const [uri, diags] of allDiagnostics) {
        for (const d of diags) {
            if (d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning) {
                errorLocations.push({ uri, range: d.range, severity: d.severity });
            }
        }
    }

    if (errorLocations.length === 0) {
        vscode.window.showInformationMessage('没有找到错误或警告');
        return;
    }

    // 排序
    errorLocations.sort((a, b) => {
        const pathCompare = a.uri.fsPath.localeCompare(b.uri.fsPath);
        if (pathCompare !== 0) return pathCompare;
        return a.range.start.line - b.range.start.line;
    });

    // 查找当前位置
    let currentIndex = -1;
    if (editor) {
        const currentUri = editor.document.uri;
        const currentLine = editor.selection.start.line;

        for (let i = 0; i < errorLocations.length; i++) {
            const loc = errorLocations[i];
            if (loc.uri.toString() === currentUri.toString() && loc.range.start.line >= currentLine) {
                currentIndex = i;
                break;
            }
        }
    }

    // 计算下一个位置
    let nextIndex: number;
    if (currentIndex === -1) {
        nextIndex = direction > 0 ? 0 : errorLocations.length - 1;
    } else {
        nextIndex = (currentIndex + direction + errorLocations.length) % errorLocations.length;
    }

    // 跳转
    const next = errorLocations[nextIndex];
    const doc = await vscode.workspace.openTextDocument(next.uri);
    const newEditor = await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(next.range.start, next.range.end)
    });

    // 滚动到可见区域
    newEditor.revealRange(next.range, vscode.TextEditorRevealType.InCenter);
}

async function exportErrorReport(): Promise<void> {
    const allDiagnostics = vscode.languages.getDiagnostics();
    const lines: string[] = ['# Error Counter Report', `生成时间: ${new Date().toLocaleString()}`, ''];

    let totalErrors = 0;
    let totalWarnings = 0;

    for (const [uri, diags] of allDiagnostics) {
        if (diags.length === 0) continue;

        lines.push(`## ${uri.fsPath}`);

        for (const d of diags) {
            const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' :
                d.severity === vscode.DiagnosticSeverity.Warning ? 'WARN' : 'INFO';
            const line = d.range.start.line + 1;
            const col = d.range.start.character + 1;

            lines.push(`- [${severity}] Line ${line}, Col ${col}: ${d.message}`);

            if (d.severity === vscode.DiagnosticSeverity.Error) totalErrors++;
            else if (d.severity === vscode.DiagnosticSeverity.Warning) totalWarnings++;
        }
        lines.push('');
    }

    lines.unshift(`总计: ${totalErrors} 个错误, ${totalWarnings} 个警告`, '');

    const content = lines.join('\n');

    // 保存到文件
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        const outputPath = vscode.Uri.joinPath(workspaceFolders[0].uri, 'error-report.md');
        await vscode.workspace.fs.writeFile(outputPath, Buffer.from(content, 'utf-8'));
        vscode.window.showInformationMessage(`错误报告已导出到 ${outputPath.fsPath}`);
    } else {
        // 复制到剪贴板
        await vscode.env.clipboard.writeText(content);
        vscode.window.showInformationMessage('错误报告已复制到剪贴板');
    }
}

export function deactivate() {
    if (diagnosticWatcher) diagnosticWatcher.dispose();
    if (statusBarProvider) statusBarProvider.dispose();
    if (errorLensProvider) errorLensProvider.dispose();
    if (errorNotifier) errorNotifier.dispose();
    if (fileDecorationProviderDisposable) fileDecorationProviderDisposable.dispose();
}
