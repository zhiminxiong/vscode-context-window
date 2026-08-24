import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 8000;
const GIT_TIMEOUT_COLD_MS = 15000;
const userCache = new Map<string, { name: string; email: string }>();
let resolvedGit: string | undefined;
let gitWarmed = false;

async function resolveGit(): Promise<string> {
    if (resolvedGit) {
        return resolvedGit;
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
    try {
        const gitExt = vscode.extensions.getExtension<any>('vscode.git');
        if (gitExt?.isActive) {
            const fromApi = gitExt.exports?.getAPI?.(1)?.git?.path;
            if (typeof fromApi === 'string' && fromApi.trim()) {
                resolvedGit = fromApi.trim();
                return resolvedGit;
            }
        } else if (gitExt) {
            void Promise.resolve(gitExt.activate()).then(() => {
                const fromApi = gitExt.exports?.getAPI?.(1)?.git?.path;
                if (typeof fromApi === 'string' && fromApi.trim()) {
                    resolvedGit = fromApi.trim();
                }
            }, () => { /* 后台激活失败不影响本次用 PATH 里的 git */ });
        }
    } catch {
        // vscode.git 未就绪时退回 PATH
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

function gitErrText(err: unknown): string {
    const e = err as { stderr?: string; message?: string };
    const stderr = String(e?.stderr || '').trim();
    return stderr || String(e?.message || err);
}

function isGitTimeout(err: unknown): boolean {
    const e = err as { killed?: boolean; signal?: string; code?: string; message?: string; timeout?: boolean };
    return e?.timeout === true
        || e?.killed === true
        || e?.signal === 'SIGTERM'
        || e?.code === 'ETIMEDOUT'
        || /ETIMEDOUT|timed? ?out/i.test(String(e?.message || ''));
}

async function gitExec(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
    try {
        const { stdout } = await execFileAsync(await resolveGit(), args, {
            cwd,
            timeout,
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: 256 * 1024
        });
        gitWarmed = true;
        return String(stdout || '');
    } catch (err) {
        const e = new Error(isGitTimeout(err)
            ? `timeout after ${timeout}ms (${args.join(' ')})`
            : gitErrText(err)) as Error & { timeout?: boolean };
        e.timeout = isGitTimeout(err);
        throw e;
    }
}

// git rev-parse --show-toplevel 在 Windows 上常给出 D:/foo 或 /d/foo，和 uri.fsPath 对不上。
function normalizeGitFsPath(p: string): string {
    let s = p.trim().replace(/^['"]|['"]$/g, '');
    const msys = s.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (process.platform === 'win32' && msys) {
        s = `${msys[1].toUpperCase()}:${(msys[2] || '/').replace(/\//g, '\\')}`;
    } else if (process.platform === 'win32') {
        s = s.replace(/\//g, '\\');
    }
    return path.normalize(s);
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

// git blame 未提交行经常给出 0；1970 不能拿来显示「1 minute ago」。
function isPlausibleGitTime(epochSec: number): boolean {
    return epochSec >= 1_000_000_000;
}

async function fileMtimeSec(uri: vscode.Uri, fsPath: string): Promise<number | undefined> {
    try {
        const st = await vscode.workspace.fs.stat(uri);
        const sec = Math.floor(st.mtime / 1000);
        if (isPlausibleGitTime(sec)) {
            return sec;
        }
    } catch {
        // 虚拟文档或 stat 失败时退回磁盘
    }
    try {
        const st = await fs.stat(fsPath);
        const sec = Math.floor(st.mtimeMs / 1000);
        return isPlausibleGitTime(sec) ? sec : undefined;
    } catch {
        return undefined;
    }
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
    uncommitted: boolean;
} | null {
    const lines = stdout.split(/\r?\n/);
    if (!lines.length) {
        return null;
    }
    const sha = (lines[0].split(' ')[0] || '').trim();
    if (!sha) {
        return null;
    }
    const uncommitted = /^0+$/.test(sha);
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
    return {
        sha: uncommitted ? '' : sha,
        author,
        email,
        time,
        summary,
        previous,
        uncommitted
    };
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
 * 非 file URI 或不在仓库里时返回 undefined。未提交行仍返回摘要。
 */
function blameArgs(line: number, filePath: string): string[] {
    return ['blame', '-L', `${line},${line}`, '--porcelain', '--', filePath];
}

// 先在文件目录用文件名 blame（git 自己往上找仓库）。
// 超时只原命令重试一次，不换路径连打三次；路径错误再试相对路径 / 绝对路径。
async function blamePorcelain(fileDir: string, fsPath: string, line: number): Promise<string> {
    const base = path.basename(fsPath);
    const firstTimeout = gitWarmed ? GIT_TIMEOUT_MS : GIT_TIMEOUT_COLD_MS;
    try {
        return await gitExec(fileDir, blameArgs(line, base), firstTimeout);
    } catch (err) {
        const msg = String((err as Error).message || err);
        if (/has only \d+ lines?/i.test(msg)) {
            return [
                '0000000000000000000000000000000000000000 1 1 1',
                'author Not Committed Yet',
                'summary Not Committed Yet'
            ].join('\n');
        }
        if ((err as { timeout?: boolean }).timeout) {
            return await gitExec(fileDir, blameArgs(line, base), GIT_TIMEOUT_COLD_MS);
        }
        const fallbacks: { cwd: string; file: string }[] = [];
        try {
            const root = normalizeGitFsPath(await gitExec(fileDir, ['rev-parse', '--show-toplevel']));
            const rel = path.relative(root, fsPath);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                fallbacks.push({ cwd: root, file: rel.replace(/\\/g, '/') });
            }
        } catch {
            // 没有仓库根就只试绝对路径
        }
        fallbacks.push({ cwd: fileDir, file: fsPath.replace(/\\/g, '/') });
        let lastErr: unknown = err;
        for (const { cwd, file } of fallbacks) {
            try {
                return await gitExec(cwd, blameArgs(line, file));
            } catch (next) {
                lastErr = next;
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
}

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
        const cwd = fileDir;
        // GitLens：先 stat 再 blame。mtime 必须在 git 之前取，否则 blame 期间写盘/过滤器会把时间改新。
        const userP = gitUser(cwd);
        const mtimeP = fileMtimeSec(uri, fsPath);
        const stdout = await blamePorcelain(fileDir, fsPath, line1Based);
        const parsed = parsePorcelain(stdout);
        if (!parsed) {
            return undefined;
        }
        const user = await userP;
        if (parsed.uncommitted) {
            const who = (!parsed.author || /^not committed yet$/i.test(parsed.author))
                ? 'You'
                : displayAuthor(parsed.author, parsed.email, user);
            const time = (await mtimeP) ?? Math.floor(Date.now() / 1000);
            const when = formatAgo(time);
            const date = formatAbsoluteDate(time);
            const text = when
                ? `${who}, ${when} • Uncommitted changes`
                : `${who}, Uncommitted changes`;
            const hover: LineBlameHoverInfo = {
                author: who,
                authorName: (parsed.author && !/^not committed yet$/i.test(parsed.author))
                    ? parsed.author.trim()
                    : (user.name || who),
                ago: when,
                date,
                summary: 'Uncommitted changes',
                sha: '',
                shortSha: ''
            };
            if (parsed.previous) {
                hover.previousSha = parsed.previous;
                hover.previousShortSha = shortSha(parsed.previous);
            }
            return { text, hover };
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
    } catch {
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
