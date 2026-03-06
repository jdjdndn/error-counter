import * as vscode from 'vscode';
import { ConfigManager } from './config';

export interface DiagnosticCount {
    errors: number;
    warnings: number;
}

/**
 * 前缀树节点 - 用于高效的文件夹聚合计算
 */
class TrieNode {
    children: Map<string, TrieNode> = new Map();
    count: DiagnosticCount = { errors: 0, warnings: 0 };
    // 累计值（包含所有子节点）
    aggregated: DiagnosticCount = { errors: 0, warnings: 0 };
    // 是否需要重新计算聚合值
    dirty: boolean = true;
}

/**
 * 基于前缀树的高性能诊断计数器
 *
 * 时间复杂度：
 * - 插入/更新: O(k)，k 为路径深度
 * - 查询文件: O(k)
 * - 查询文件夹: O(1) - 直接返回缓存的聚合值
 * - 删除: O(k)
 */
export class DiagnosticWatcher {
    private configManager: ConfigManager;
    private _onDidChangeDiagnostics = new vscode.EventEmitter<void>();
    public readonly onDidChangeDiagnostics = this._onDidChangeDiagnostics.event;
    private disposables: vscode.Disposable[] = [];
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private idleCallback: ReturnType<typeof requestIdleCallback> | undefined;

    // 前缀树根节点
    private root: TrieNode = new TrieNode();

    // 文件路径到树节点的映射（快速查找）
    private fileNodes: Map<string, TrieNode> = new Map();

    // 路径规范化缓存
    private pathCache: Map<string, string[]> = new Map();

    // 性能配置
    private readonly CONFIG = {
        debounceDelay: 300,
        initialDelay: 3000,
        maxPathCacheSize: 10000,
        idleTimeout: 50, // 空闲处理超时
        scanBatchSize: 50, // 批量扫描文件数
        scanDelay: 100, // 扫描间隔
    };

    // 要扫描的文件模式
    private readonly SCAN_PATTERNS = [
        '**/*.js',
        '**/*.jsx',
        '**/*.ts',
        '**/*.tsx',
        '**/*.mjs',
        '**/*.cjs'
    ];

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;

        // 延迟初始化
        setTimeout(() => {
            this.scanDiagnostics();
            // 主动扫描工作区文件以触发诊断
            this.triggerWorkspaceScan();
        }, this.CONFIG.initialDelay);

        // 监听文件打开
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(() => {
                this.debounceScan();
            })
        );

        // 监听诊断变化 - 使用增量更新
        this.disposables.push(
            vscode.languages.onDidChangeDiagnostics((e) => {
                this.incrementalUpdate(e.uris);
            })
        );

        // 监听配置变化
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('errorCounter')) {
                    this.configManager.reload();
                    this.clearAll();
                    this.debounceScan();
                }
            })
        );

        // 监听 .errorignore 变化
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (doc.uri.fsPath.endsWith('.errorignore')) {
                    this.configManager.reload();
                    this.clearAll();
                    this.debounceScan();
                }
            })
        );
    }

    /**
     * 主动扫描工作区文件以触发 VSCode 诊断
     * 解决未打开文件没有错误检测的问题
     */
    private async triggerWorkspaceScan(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        // 收集所有需要扫描的文件
        const filesToScan: vscode.Uri[] = [];

        for (const pattern of this.SCAN_PATTERNS) {
            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
            for (const file of files) {
                if (!this.configManager.shouldIgnore(file)) {
                    filesToScan.push(file);
                }
            }
        }

        // 批量打开文件以触发诊断（不显示在编辑器中）
        for (let i = 0; i < filesToScan.length; i += this.CONFIG.scanBatchSize) {
            const batch = filesToScan.slice(i, i + this.CONFIG.scanBatchSize);

            for (const uri of batch) {
                try {
                    // 打开文档但不显示，触发语言服务器诊断
                    await vscode.workspace.openTextDocument(uri);
                } catch {
                    // 忽略无法打开的文件
                }
            }

            // 批次间延迟，避免性能问题
            if (i + this.CONFIG.scanBatchSize < filesToScan.length) {
                await new Promise(resolve => setTimeout(resolve, this.CONFIG.scanDelay));
            }
        }

        // 扫描完成后更新诊断
        this.debounceScan();
    }

    /**
     * 公共方法：手动触发工作区扫描
     */
    public async scanWorkspace(): Promise<number> {
        await this.triggerWorkspaceScan();
        const allDiagnostics = vscode.languages.getDiagnostics();
        let count = 0;
        for (const [, diags] of allDiagnostics) {
            count += diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
        }
        return count;
    }

    /**
     * 将路径分割为段数组（带缓存）
     */
    private parsePath(filePath: string): string[] {
        let segments = this.pathCache.get(filePath);
        if (segments) {
            return segments;
        }

        // 规范化路径
        const normalized = filePath.replace(/\\/g, '/');
        segments = normalized.split('/');

        // LRU 缓存：限制大小
        if (this.pathCache.size >= this.CONFIG.maxPathCacheSize) {
            // 删除最早的条目
            const firstKey = this.pathCache.keys().next().value;
            if (firstKey) {
                this.pathCache.delete(firstKey);
            }
        }

        this.pathCache.set(filePath, segments);
        return segments;
    }

    /**
     * 增量更新：只更新变化的文件
     */
    private incrementalUpdate(uris: readonly vscode.Uri[]): void {
        if (uris.length === 0) {
            return;
        }

        const config = this.configManager.getConfig();
        if (!config.enabled) {
            return;
        }

        for (const uri of uris) {
            if (this.configManager.shouldIgnore(uri)) {
                continue;
            }

            const diagnostics = vscode.languages.getDiagnostics(uri);
            let errors = 0;
            let warnings = 0;

            for (const diagnostic of diagnostics) {
                if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
                    errors++;
                } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
                    warnings++;
                }
            }

            this.updateFile(uri.fsPath, { errors, warnings });
        }

        this._onDidChangeDiagnostics.fire();
    }

    /**
     * 更新单个文件的错误计数
     */
    private updateFile(filePath: string, count: DiagnosticCount): void {
        const segments = this.parsePath(filePath);
        const key = segments.join('/');

        const oldNode = this.fileNodes.get(key);
        const oldCount = oldNode?.count || { errors: 0, warnings: 0 };

        // 计算差值
        const deltaErrors = count.errors - oldCount.errors;
        const deltaWarnings = count.warnings - oldCount.warnings;

        if (deltaErrors === 0 && deltaWarnings === 0) {
            return; // 无变化
        }

        // 遍历到目标节点，同时更新路径上的聚合值
        let node = this.root;
        for (const segment of segments) {
            if (!node.children.has(segment)) {
                node.children.set(segment, new TrieNode());
            }
            node = node.children.get(segment)!;

            // 更新聚合值
            node.aggregated.errors += deltaErrors;
            node.aggregated.warnings += deltaWarnings;
        }

        // 更新节点的值
        node.count = { ...count };

        // 如果文件有错误，添加到映射
        if (count.errors > 0 || count.warnings > 0) {
            this.fileNodes.set(key, node);
        } else {
            this.fileNodes.delete(key);
        }
    }

    /**
     * 查找路径对应的节点
     */
    private findNode(filePath: string): TrieNode | undefined {
        const segments = this.parsePath(filePath);
        let node = this.root;

        for (const segment of segments) {
            const child = node.children.get(segment);
            if (!child) {
                return undefined;
            }
            node = child;
        }

        return node;
    }

    /**
     * 获取文件的错误计数
     */
    public getFileCount(uri: vscode.Uri): DiagnosticCount {
        const node = this.findNode(uri.fsPath);
        return node?.count || { errors: 0, warnings: 0 };
    }

    /**
     * 获取文件夹的错误计数（使用预计算的聚合值，O(1)）
     */
    public getFolderCount(uri: vscode.Uri): DiagnosticCount {
        const node = this.findNode(uri.fsPath);
        if (!node) {
            return { errors: 0, warnings: 0 };
        }
        // 对于文件夹，返回所有子节点的聚合值（文件夹本身的 count 应该是 0）
        return {
            errors: node.aggregated.errors - node.count.errors,
            warnings: node.aggregated.warnings - node.count.warnings
        };
    }

    /**
     * 获取文件或文件夹的错误计数
     */
    public getCount(uri: vscode.Uri, isFolder: boolean): DiagnosticCount {
        if (isFolder) {
            return this.getFolderCount(uri);
        }
        return this.getFileCount(uri);
    }

    /**
     * 防抖扫描
     */
    private debounceScan(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.scanDiagnostics();
            this.debounceTimer = undefined;
        }, this.CONFIG.debounceDelay);
    }

    /**
     * 清空所有数据
     */
    private clearAll(): void {
        this.root = new TrieNode();
        this.fileNodes.clear();
        this.pathCache.clear();
    }

    /**
     * 全量扫描诊断信息
     */
    private scanDiagnostics(): void {
        const config = this.configManager.getConfig();

        if (!config.enabled) {
            this.clearAll();
            this._onDidChangeDiagnostics.fire();
            return;
        }

        const allDiagnostics = vscode.languages.getDiagnostics();

        // 清空并重建
        this.clearAll();

        // 批量插入
        for (const [uri, diagnostics] of allDiagnostics) {
            if (this.configManager.shouldIgnore(uri)) {
                continue;
            }

            let errors = 0;
            let warnings = 0;

            for (const diagnostic of diagnostics) {
                if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
                    errors++;
                } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
                    warnings++;
                }
            }

            if (errors > 0 || warnings > 0) {
                this.updateFile(uri.fsPath, { errors, warnings });
            }
        }

        this._onDidChangeDiagnostics.fire();
    }

    public dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        if (this.idleCallback) {
            cancelIdleCallback(this.idleCallback);
        }
        this.disposables.forEach(d => d.dispose());
        this.clearAll();
    }
}

// Polyfill for environments without requestIdleCallback
declare function requestIdleCallback(callback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void, options?: { timeout?: number }): number;
declare function cancelIdleCallback(handle: number): void;
