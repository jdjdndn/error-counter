import * as vscode from 'vscode';
import { DiagnosticWatcher } from './diagnosticWatcher';
import { ConfigManager } from './config';

/**
 * 状态栏显示项目总错误数
 */
export class StatusBarProvider {
    private statusBarItem: vscode.StatusBarItem;
    private diagnosticWatcher: DiagnosticWatcher;
    private configManager: ConfigManager;

    constructor(diagnosticWatcher: DiagnosticWatcher, configManager: ConfigManager) {
        this.diagnosticWatcher = diagnosticWatcher;
        this.configManager = configManager;

        // 创建状态栏项（左侧）- 项目总错误
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );

        this.statusBarItem.command = 'workbench.actions.view.problems';
        this.statusBarItem.tooltip = '点击打开问题面板';

        // 监听诊断变化
        this.diagnosticWatcher.onDidChangeDiagnostics(() => {
            this.update();
        });

        // 初始更新
        setTimeout(() => {
            this.update();
        }, 3000);
    }

    private update(): void {
        const config = this.configManager.getConfig();

        if (!config.enabled || !config.showStatusBar) {
            this.statusBarItem.hide();
            return;
        }

        const workspaces = vscode.workspace.workspaceFolders;
        if (!workspaces) {
            this.statusBarItem.hide();
            return;
        }

        let totalErrors = 0;
        let totalWarnings = 0;

        const allDiagnostics = vscode.languages.getDiagnostics();
        for (const [, diagnostics] of allDiagnostics) {
            for (const diagnostic of diagnostics) {
                if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
                    totalErrors++;
                } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
                    totalWarnings++;
                }
            }
        }

        if (totalErrors === 0 && totalWarnings === 0) {
            this.statusBarItem.text = '$(check) 0';
            this.statusBarItem.tooltip = '没有错误或警告';
        } else {
            const parts: string[] = [];
            if (config.showErrors && totalErrors > 0) {
                parts.push(`$(error) ${totalErrors}`);
            }
            if (config.showWarnings && totalWarnings > 0) {
                parts.push(`$(warning) ${totalWarnings}`);
            }
            this.statusBarItem.text = parts.join(' ');
            this.statusBarItem.tooltip = `${totalErrors} 个错误, ${totalWarnings} 个警告\n点击打开问题面板`;
        }

        this.statusBarItem.show();
    }

    public dispose(): void {
        this.statusBarItem.dispose();
    }
}
