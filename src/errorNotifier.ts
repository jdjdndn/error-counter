import * as vscode from 'vscode';
import { ConfigManager } from './config';

/**
 * 错误通知器 - 当错误数超过阈值时提醒
 */
export class ErrorNotifier {
    private configManager: ConfigManager;
    private lastErrorCount = 0;
    private lastWarningCount = 0;
    private lastFileErrors: Map<string, number> = new Map(); // 追踪每个文件的错误数
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;

    // 配置
    private readonly THRESHOLD = 10; // 超过此数量提醒
    private readonly DEBOUNCE = 500; // 防抖时间（缩短以更快响应 AI 修改）
    private readonly ERROR_INCREASE_THRESHOLD = 1; // 新增错误数阈值（更敏感的检测）

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
        const currentFileErrors: Map<string, number> = new Map();
        const filesWithNewErrors: string[] = [];

        const allDiagnostics = vscode.languages.getDiagnostics();
        for (const [uri, diags] of allDiagnostics) {
            // 只处理文件 URI，跳过 vscode://、git:// 等非文件协议
            if (uri.scheme !== 'file') {
                continue;
            }

            // 检查是否应该忽略该文件
            if (this.configManager.shouldIgnore(uri)) {
                continue;
            }

            let fileErrors = 0;
            for (const d of diags) {
                if (d.severity === vscode.DiagnosticSeverity.Error) {
                    errors++;
                    fileErrors++;
                } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
                    warnings++;
                }
            }
            if (fileErrors > 0) {
                currentFileErrors.set(uri.fsPath, fileErrors);
                // 检查该文件是否有新增错误
                const lastCount = this.lastFileErrors.get(uri.fsPath) || 0;
                if (fileErrors > lastCount) {
                    const fileName = uri.path.split('/').pop() || uri.fsPath;
                    filesWithNewErrors.push(fileName);
                }
            }
        }

        // 检查是否需要通知
        const errorIncrease = errors - this.lastErrorCount;

        // 错误数从阈值以下变为阈值以上时通知
        if (this.lastErrorCount < this.THRESHOLD && errors >= this.THRESHOLD) {
            this.showNotification(errors, warnings);
        }

        // 错误数增加时通知（AI 修改后及时反馈）
        if (errorIncrease >= this.ERROR_INCREASE_THRESHOLD) {
            const fileList = filesWithNewErrors.length > 0
                ? ` (${filesWithNewErrors.slice(0, 3).join(', ')}${filesWithNewErrors.length > 3 ? '...' : ''})`
                : '';
            vscode.window.showWarningMessage(
                `Error Counter: 新增 ${errorIncrease} 个错误${fileList}`,
                '查看问题'
            ).then(selection => {
                if (selection === '查看问题') {
                    vscode.commands.executeCommand('workbench.actions.view.problems');
                }
            });
        }

        this.lastErrorCount = errors;
        this.lastWarningCount = warnings;
        this.lastFileErrors = currentFileErrors;
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
