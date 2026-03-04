import * as vscode from 'vscode';
import { ConfigManager } from './config';

/**
 * 错误通知器 - 当错误数超过阈值时提醒
 */
export class ErrorNotifier {
    private configManager: ConfigManager;
    private lastErrorCount = 0;
    private lastWarningCount = 0;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;

    // 配置
    private readonly THRESHOLD = 10; // 超过此数量提醒
    private readonly DEBOUNCE = 2000; // 防抖时间

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;

        // 监听诊断变化
        vscode.languages.onDidChangeDiagnostics(() => {
            this.check();
        });

        // 初始检查
        setTimeout(() => {
            this.check();
        }, 5000);
    }

    private check(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.doCheck();
            this.debounceTimer = undefined;
        }, this.DEBOUNCE);
    }

    private doCheck(): void {
        const config = this.configManager.getConfig();
        if (!config.enabled) {
            return;
        }

        let errors = 0;
        let warnings = 0;

        const allDiagnostics = vscode.languages.getDiagnostics();
        for (const [, diags] of allDiagnostics) {
            for (const d of diags) {
                if (d.severity === vscode.DiagnosticSeverity.Error) {
                    errors++;
                } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
                    warnings++;
                }
            }
        }

        // 检查是否需要通知
        const errorIncrease = errors - this.lastErrorCount;
        const warningIncrease = warnings - this.lastWarningCount;

        // 错误数从阈值以下变为阈值以上时通知
        if (this.lastErrorCount < this.THRESHOLD && errors >= this.THRESHOLD) {
            this.showNotification(errors, warnings);
        }

        // 错误数大幅增加时通知
        if (errorIncrease >= 5) {
            vscode.window.showWarningMessage(`Error Counter: 新增 ${errorIncrease} 个错误`);
        }

        this.lastErrorCount = errors;
        this.lastWarningCount = warnings;
    }

    private showNotification(errors: number, warnings: number): void {
        const message = `Error Counter: 项目存在 ${errors} 个错误${warnings > 0 ? `，${warnings} 个警告` : ''}`;

        vscode.window.showWarningMessage(message, '查看问题', '忽略').then(selection => {
            if (selection === '查看问题') {
                vscode.commands.executeCommand('workbench.actions.view.problems');
            }
        });
    }

    public dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
    }
}
