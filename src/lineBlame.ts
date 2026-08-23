import { execFile } from 'child_process';
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

function formatAgo(epochSec: number): string {
    const sec = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
    if (sec < 45) {
        return 'just now';
    }
    const min = Math.floor(sec / 60);
    if (min < 60) {
        return min <= 1 ? '1 minute ago' : `${min} minutes ago`;
    }
    const hr = Math.floor(min / 60);
    if (hr < 24) {
        return hr === 1 ? '1 hour ago' : `${hr} hours ago`;
    }
    const day = Math.floor(hr / 24);
    if (day < 30) {
        return day === 1 ? '1 day ago' : `${day} days ago`;
    }
    const month = Math.max(1, Math.round(day / 30));
    return month === 1 ? '1 month ago' : `${month} months ago`;
}

function parsePorcelain(stdout: string): {
    sha: string;
    author: string;
    email: string;
    time: number;
    summary: string;
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
        }
    }
    return { sha, author, email, time, summary };
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

/**
 * 当前行一行 git blame 摘要：`You, 12 months ago • Optimize keyboard response.`
 * 非 file URI、未提交、或不在仓库里时返回 undefined。
 */
export async function blameLineSummary(uriString: string, line1Based: number): Promise<string | undefined> {
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
        const who = displayAuthor(parsed.author, parsed.email, user);
        const when = parsed.time ? formatAgo(parsed.time) : '';
        let subject = parsed.summary.replace(/\s+/g, ' ');
        if (subject.length > 72) {
            subject = subject.slice(0, 71) + '…';
        }
        if (who && when && subject) {
            return `${who}, ${when} • ${subject}`;
        }
        if (who && when) {
            return `${who}, ${when}`;
        }
        return undefined;
    } catch (err) {
        console.warn('[context-window] line blame failed:', fsPath, line1Based, err);
        return undefined;
    }
}
