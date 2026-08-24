import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2500;
const userCache = new Map<string, { name: string; email: string }>();
let resolvedGit: string | undefined;

async function resolveGit(): Promise<string> {
    if (resolvedGit) {
        return resolvedGit;
    }
    try {
        const gitExt = vscode.extensions.getExtension<any>('vscode.git');
        if (gitExt && !gitExt.isActive) {
            await gitExt.activate();
        }
        const api = gitExt?.exports?.getAPI?.(1);
        const fromApi = api?.git?.path;
        if (typeof fromApi === 'string' && fromApi.trim()) {
            resolvedGit = fromApi.trim();
            return resolvedGit;
        }
    } catch {
        // vscode.git 未就绪时退回配置 / PATH
    }
    const configured = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
    if (typeof configured === 'string' && configured.trim()) {
        resolvedGit = configured.trim();
        return resolvedGit;
    }
    if (Array.isArray(configured)) {
        const first = configured.find(p => typeof p === 'string' && p.trim());
        if (first) {
            resolvedGit = first.trim();
            return resolvedGit;
        }
    }
    resolvedGit = process.platform === 'win32' ? 'git.exe' : 'git';
    return resolvedGit;
}

function toFileUri(uriString: string): vscode.Uri | undefined {
    try {
        const uri = vscode.Uri.parse(uriString);
        if (uri.scheme === 'file') {
            return uri;
        }
    } catch {
        // fall through
    }
    if (/^[a-zA-Z]:[\\/]/.test(uriString) || uriString.startsWith('/') || uriString.startsWith('\\\\')) {
        return vscode.Uri.file(uriString);
    }
    return undefined;
}

async function gitExec(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(await resolveGit(), args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 256 * 1024
    });
    return String(stdout || '');
}

async function gitUser(cwd: string): Promise<{ name: string; email: string }> {
    const key = cwd.toLowerCase();
    const hit = userCache.get(key);
    if (hit) {
        return hit;
    }
    const [nameOut, emailOut] = await Promise.allSettled([
        gitExec(cwd, ['config', 'user.name']),
        gitExec(cwd, ['config', 'user.email'])
    ]);
    const user = {
        name: nameOut.status === 'fulfilled' ? nameOut.value.trim() : '',
        email: emailOut.status === 'fulfilled' ? emailOut.value.trim() : ''
    };
    userCache.set(key, user);
    return user;
}

// 对齐 GitLens fromNow：单位门槛 + Intl.RelativeTimeFormat(numeric: 'auto')。
// 与「满 30 天再进月、round(day/30)」不同——7 天起用 week；月按 365/12 天 trunc；
// 年要到近两年才切换。auto 会把 -1 month 收成 last month，而不是 1 month ago。
const MS_DAY = 24 * 60 * 60 * 1000;
const relativeUnitThresholds: [Intl.RelativeTimeFormatUnit, number, number][] = [
    ['year', MS_DAY * (365 * 2 - 1), MS_DAY * 365],
    ['month', (MS_DAY * 365) / 12, (MS_DAY * 365) / 12],
    ['week', MS_DAY * 7, MS_DAY * 7],
    ['day', MS_DAY, MS_DAY],
    ['hour', 60 * 60 * 1000, 60 * 60 * 1000],
    ['minute', 60 * 1000, 60 * 1000],
    ['second', 1000, 1000],
];

let relativeTimeFormat: Intl.RelativeTimeFormat | undefined;

function formatAgo(epochSec: number): string {
    const elapsed = epochSec * 1000 - Date.now();
    if (!Number.isFinite(elapsed)) {
        return '';
    }
    const elapsedAbs = Math.abs(elapsed);
    for (const [unit, threshold, divisor] of relativeUnitThresholds) {
        if (elapsedAbs >= threshold || threshold === 1000) {
            relativeTimeFormat ??= new Intl.RelativeTimeFormat(undefined, {
                localeMatcher: 'best fit',
                numeric: 'auto',
                style: 'long',
            });
            return relativeTimeFormat.format(Math.trunc(elapsed / divisor), unit);
        }
    }
    return '';
}

function ordinal(n: number): string {
    const v = n % 100;
    if (v >= 11 && v <= 13) {
        return `${n}th`;
    }
    switch (n % 10) {
        case 1: return `${n}st`;
        case 2: return `${n}nd`;
        case 3: return `${n}rd`;
        default: return `${n}th`;
    }
}

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

// 对齐 GitLens 默认绝对时间：`June 28th, 2026 11:51 PM`
function formatAbsoluteDate(epochSec: number): string {
    const d = new Date(epochSec * 1000);
    if (Number.isNaN(d.getTime())) {
        return '';
    }
    let h = d.getHours();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()} ${h}:${min} ${ap}`;
}

function shortSha(sha: string): string {
    return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function firstLine(text: string): string {
    return (text.split(/\r?\n/)[0] || '').trim();
}

// Git 不存头像。用作者邮箱的 Gravatar；未登记时返回 404，前端改用首字母。
function gravatarUrl(email: string): string | undefined {
    const trimmed = (email || '').trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) {
        return undefined;
    }
    const hash = createHash('md5').update(trimmed).digest('hex');
    return `https://www.gravatar.com/avatar/${hash}?s=64&d=404`;
}

async function commitMessage(cwd: string, sha: string): Promise<string> {
    try {
        return (await gitExec(cwd, ['log', '-1', '--format=%B', '--no-patch', sha])).replace(/\s+$/g, '');
    } catch {
        return '';
    }
}

function parsePorcelain(stdout: string): {
    sha: string;
    author: string;
    email: string;
    time: number;
    summary: string;
    previous: string;
} | null {
    const lines = stdout.split(/\r?\n/);
    if (!lines.length) {
        return null;
    }
    const sha = (lines[0].split(' ')[0] || '').trim();
    if (!sha || /^0+$/.test(sha)) {
        return null;
    }
    let author = '';
    let email = '';
    let time = 0;
    let summary = '';
    let previous = '';
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('author ')) {
            author = line.slice(7);
        } else if (line.startsWith('author-mail ')) {
            email = line.slice(12).replace(/^[<]/, '').replace(/[>]$/, '');
        } else if (line.startsWith('author-time ')) {
            time = parseInt(line.slice(12), 10) || 0;
        } else if (line.startsWith('summary ')) {
            summary = line.slice(8).trim();
        } else if (line.startsWith('previous ')) {
            previous = (line.slice(9).split(' ')[0] || '').trim();
        }
    }
    return { sha, author, email, time, summary, previous };
}

function displayAuthor(author: string, email: string, user: { name: string; email: string }): string {
    const name = (author || '').trim() || 'Someone';
    if (user.email && email && user.email.toLowerCase() === email.toLowerCase()) {
        return 'You';
    }
    if (user.name && name && user.name.toLowerCase() === name.toLowerCase()) {
        return 'You';
    }
    return name;
}

export interface LineBlameHoverInfo {
    author: string;
    authorName: string;
    ago: string;
    date: string;
    summary: string;
    avatarUrl?: string;
    sha: string;
    shortSha: string;
    previousSha?: string;
    previousShortSha?: string;
}

export interface LineBlameInfo {
    text: string;
    hover: LineBlameHoverInfo;
}

/**
 * 当前行一行 git blame：行尾摘要 + 浮窗详情。
 * 非 file URI、未提交、或不在仓库里时返回 undefined。
 */
export async function blameLine(uriString: string, line1Based: number): Promise<LineBlameInfo | undefined> {
    if (!uriString || line1Based < 1) {
        return undefined;
    }
    const uri = toFileUri(uriString);
    if (!uri) {
        return undefined;
    }
    const fsPath = uri.fsPath;
    const fileDir = path.dirname(fsPath);
    try {
        let cwd = fileDir;
        let blamePath = path.basename(fsPath);
        try {
            const root = (await gitExec(fileDir, ['rev-parse', '--show-toplevel'])).trim();
            if (root) {
                const rel = path.relative(root, fsPath);
                if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                    cwd = root;
                    blamePath = rel.replace(/\\/g, '/');
                }
            }
        } catch {
            // 找不到仓库根：在文件目录下用文件名 blame
        }
        const [stdout, user] = await Promise.all([
            gitExec(cwd, ['blame', '-L', `${line1Based},${line1Based}`, '--porcelain', '--', blamePath]),
            gitUser(cwd)
        ]);
        const parsed = parsePorcelain(stdout);
        if (!parsed) {
            return undefined;
        }
        const fullMessage = (await commitMessage(cwd, parsed.sha)) || parsed.summary;
        const who = displayAuthor(parsed.author, parsed.email, user);
        const when = parsed.time ? formatAgo(parsed.time) : '';
        const date = parsed.time ? formatAbsoluteDate(parsed.time) : '';
        const subject = firstLine(fullMessage) || parsed.summary.replace(/\s+/g, ' ');
        let textSubject = subject;
        if (textSubject.length > 72) {
            textSubject = textSubject.slice(0, 71) + '…';
        }
        let text = '';
        if (who && when && textSubject) {
            text = `${who}, ${when} • ${textSubject}`;
        } else if (who && when) {
            text = `${who}, ${when}`;
        }
        if (!text) {
            return undefined;
        }
        const hover: LineBlameHoverInfo = {
            author: who,
            authorName: (parsed.author || '').trim() || who,
            ago: when,
            date,
            summary: fullMessage,
            avatarUrl: gravatarUrl(parsed.email),
            sha: parsed.sha,
            shortSha: shortSha(parsed.sha)
        };
        if (parsed.previous) {
            hover.previousSha = parsed.previous;
            hover.previousShortSha = shortSha(parsed.previous);
        }
        return { text, hover };
    } catch (err) {
        console.warn('[context-window] line blame failed:', fsPath, line1Based, err);
        return undefined;
    }
}

function toGitUri(uri: vscode.Uri, ref: string): vscode.Uri {
    return uri.with({
        scheme: 'git',
        query: JSON.stringify({ path: uri.fsPath, ref })
    });
}

function editorViewColumn(): vscode.ViewColumn {
    if (vscode.window.activeTextEditor?.viewColumn) {
        return vscode.window.activeTextEditor.viewColumn;
    }
    const visible = vscode.window.visibleTextEditors.find(e => e.viewColumn);
    return visible?.viewColumn ?? vscode.ViewColumn.One;
}

/**
 * 在 VS Code 主编辑区打开该行 blame 对应的两次提交 diff（对齐 GitLens Open Changes）。
 */
export async function openBlameDiff(uriString: string, previousSha: string, sha: string): Promise<void> {
    const uri = toFileUri(uriString);
    if (!uri || !previousSha || !sha) {
        return;
    }
    try {
        const gitExt = vscode.extensions.getExtension('vscode.git');
        if (gitExt && !gitExt.isActive) {
            await gitExt.activate();
        }
    } catch {
        // git 方案由 vscode.git 提供；激活失败时 vscode.diff 仍可能打开空页
    }
    const name = path.basename(uri.fsPath);
    const title = `${name} (${shortSha(previousSha)}) ↔ ${name} (${shortSha(sha)})`;
    await vscode.commands.executeCommand(
        'vscode.diff',
        toGitUri(uri, previousSha),
        toGitUri(uri, sha),
        title,
        { preview: true, preserveFocus: false, viewColumn: editorViewColumn() }
    );
}
