import * as vscode from 'vscode';
import { ConfigManager } from './config';

/**
 * 代码行内显示错误信息（类似 Error Lens）
 */
export class ErrorLensProvider {
    private configManager: ConfigManager;
    private decorationTypes: Map<vscode.DiagnosticSeverity, vscode.TextEditorDecorationType> = new Map();
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;

        // 创建不同严重级别的装饰类型
        this.decorationTypes.set(
            vscode.DiagnosticSeverity.Error,
            vscode.window.createTextEditorDecorationType({
                after: {
                    color: new vscode.ThemeColor('editorError.foreground'),
                    fontStyle: 'italic',
                    margin: '0 0 0 1em'
                }
            })
        );

        this.decorationTypes.set(
            vscode.DiagnosticSeverity.Warning,
            vscode.window.createTextEditorDecorationType({
                after: {
                    color: new vscode.ThemeColor('editorWarning.foreground'),
                    fontStyle: 'italic',
                    margin: '0 0 0 1em'
                }
            })
        );

        // 监听诊断变化
        vscode.languages.onDidChangeDiagnostics(() => {
            this.debounceUpdate();
        });

        // 监听编辑器切换
        vscode.window.onDidChangeActiveTextEditor(() => {
            this.update();
        });

        // 监听文档变化
        vscode.workspace.onDidChangeTextDocument(() => {
            this.debounceUpdate();
        });

        // 初始更新
        setTimeout(() => {
            this.update();
        }, 3000);
    }

    private debounceUpdate(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.update();
            this.debounceTimer = undefined;
        }, 100);
    }

    private update(): void {
        const config = this.configManager.getConfig();

        if (!config.enabled || !config.showErrorLens) {
            this.clearAllDecorations();
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);

        // 按行分组
        const lineDiagnostics = new Map<number, vscode.Diagnostic[]>();
        for (const diagnostic of diagnostics) {
            const line = diagnostic.range.start.line;
            if (!lineDiagnostics.has(line)) {
                lineDiagnostics.set(line, []);
            }
            lineDiagnostics.get(line)!.push(diagnostic);
        }

        // 按严重级别分组装饰
        const errorDecorations: vscode.DecorationOptions[] = [];
        const warningDecorations: vscode.DecorationOptions[] = [];

        lineDiagnostics.forEach((diags, line) => {
            // 过滤只保留需要显示的严重级别
            const filteredDiags = diags.filter(d => {
                if (d.severity === vscode.DiagnosticSeverity.Error) {
                    return config.showErrors;
                }
                if (d.severity === vscode.DiagnosticSeverity.Warning) {
                    return config.showWarnings;
                }
                return false;
            });

            if (filteredDiags.length === 0) {
                return;
            }

            // 按严重级别排序，优先显示错误
            filteredDiags.sort((a, b) => (a.severity || 0) - (b.severity || 0));

            const messages = filteredDiags.map(d => d.message).join(' | ');
            const range = new vscode.Range(line, Number.MAX_VALUE, line, Number.MAX_VALUE);

            const decoration: vscode.DecorationOptions = {
                range,
                renderOptions: {
                    after: {
                        contentText: ` // ${messages.substring(0, 100)}${messages.length > 100 ? '...' : ''}`
                    }
                }
            };

            const severity = filteredDiags[0].severity;
            if (severity === vscode.DiagnosticSeverity.Error) {
                errorDecorations.push(decoration);
            } else if (severity === vscode.DiagnosticSeverity.Warning) {
                warningDecorations.push(decoration);
            }
        });

        // 应用装饰
        const errorType = this.decorationTypes.get(vscode.DiagnosticSeverity.Error);
        const warningType = this.decorationTypes.get(vscode.DiagnosticSeverity.Warning);

        if (errorType) {
            editor.setDecorations(errorType, errorDecorations);
        }
        if (warningType) {
            editor.setDecorations(warningType, warningDecorations);
        }
    }

    private clearAllDecorations(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        for (const decorationType of this.decorationTypes.values()) {
            editor.setDecorations(decorationType, []);
        }
    }

    public dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        for (const decorationType of this.decorationTypes.values()) {
            decorationType.dispose();
        }
    }
}
