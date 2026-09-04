// Drives media/mcpBridge.js the way an editor does: spawn it, speak
// newline-delimited JSON-RPC over stdio, and check it reaches a live endpoint.
//
// Also proves the bridge and src/mcp/endpointFile.ts agree on where the
// endpoint is recorded. That path is computed twice, once in each language,
// and a disagreement would only ever show up as "Cursor cannot see it".
//
// Run with `npm run check:mcp`.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMcpServer } = require(path.join(__dirname, '..', 'out', 'mcp', 'server.js'));
const { writeEndpointFile, endpointFilePath, clearEndpointFile } = require(path.join(__dirname, '..', 'out', 'mcp', 'endpointFile.js'));

const BRIDGE = path.join(__dirname, '..', 'media', 'mcpBridge.js');

// The extension launches the bridge with the editor's own binary acting as
// Node, which is what `bridgeEntry()` produces. Pass that binary as an
// argument to check the bridge really runs the way an editor will start it:
//   node scripts/checkMcpBridge.js "C:\...\Cursor.exe"
const LAUNCHER = process.argv[2] || process.execPath;
const LAUNCH_ENV = process.argv[2]
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : process.env;

const tools = [{
    name: 'echo',
    description: 'Returns what it was given.',
    inputSchema: { type: 'object', properties: { what: { type: 'string' } } },
    async invoke(args) { return { text: `got ${JSON.stringify(args)}` }; }
}];

let failures = 0;
function check(label, ok, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`}`);
    if (!ok) { failures++; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Collects newline-delimited JSON from the bridge's stdout. */
function attach(child) {
    const replies = [];
    const waiters = [];
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        buffered += chunk;
        for (;;) {
            const brk = buffered.indexOf('\n');
            if (brk < 0) { break; }
            const line = buffered.slice(0, brk).trim();
            buffered = buffered.slice(brk + 1);
            if (!line) { continue; }
            let parsed;
            try { parsed = JSON.parse(line); } catch { parsed = { unparseable: line }; }
            replies.push(parsed);
            const waiter = waiters.shift();
            if (waiter) { waiter(parsed); }
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => process.stdout.write(`   [bridge] ${d.toString().trim()}\n`));
    return {
        replies,
        next(timeoutMs = 10_000) {
            if (replies.length) { return Promise.resolve(replies[replies.length - 1]); }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('the bridge sent nothing back in time')), timeoutMs);
                waiters.push(value => { clearTimeout(timer); resolve(value); });
            });
        },
        take() {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('the bridge sent nothing back in time')), 10_000);
                waiters.push(value => { clearTimeout(timer); resolve(value); });
            });
        }
    };
}

function send(child, message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxview-bridge-'));
    // A home of its own, so the fallback below sees one record and not whatever
    // editors the person running this happens to have open.
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxview-home-'));
    let child;
    let serverA;
    let serverB;
    try {
        serverA = await startMcpServer({ tools, info: { name: 'context-view', version: '9.9.9' }, log: () => undefined });

        // The extension records the endpoint; the bridge must find that file.
        const recorded = writeEndpointFile(root, {
            url: serverA.url, token: serverA.token, pid: process.pid,
            workspaceRoot: root, version: '9.9.9', updatedAt: new Date().toISOString()
        });
        check('endpoint file lands where the extension expects', fs.existsSync(endpointFilePath(root)), recorded);

        console.log(`launching the bridge with ${LAUNCHER}`);
        child = spawn(LAUNCHER, [BRIDGE, root], { stdio: ['pipe', 'pipe', 'pipe'], env: LAUNCH_ENV });
        const io = attach(child);

        send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
        const init = await io.take();
        check('bridge finds the recorded endpoint and relays initialize',
            init.id === 1 && init.result?.protocolVersion === '2025-06-18', init);
        check('bridge relays serverInfo untouched', init.result?.serverInfo?.name === 'context-view', init.result?.serverInfo);

        send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
        await sleep(300);
        check('a notification produces no stdout', io.replies.length === 1, io.replies.length);

        send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        const list = await io.take();
        check('tools/list round-trips', list.id === 2 && list.result?.tools?.[0]?.name === 'echo', list.result);

        send(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { what: 'hi' } } });
        const call = await io.take();
        check('tools/call round-trips', call.result?.content?.[0]?.text.includes('"what":"hi"'), call.result);

        // The config passes ${workspaceFolder}. An editor that does not expand
        // it would otherwise hash the literal and look like a closed window.
        const literal = spawn(LAUNCHER, [BRIDGE, '${workspaceFolder}'], {
            stdio: ['pipe', 'pipe', 'pipe'], env: LAUNCH_ENV, cwd: root
        });
        try {
            const literalIo = attach(literal);
            send(literal, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
            const literalInit = await literalIo.take();
            check('an unexpanded ${workspaceFolder} falls back to the working directory',
                literalInit.result?.protocolVersion === '2025-06-18', literalInit);
        } finally {
            literal.stdin.end();
            literal.kill();
        }

        // Cursor expands ${workspaceFolder} to the folder holding mcp.json, so
        // a home-directory config names the home directory and not the project.
        // The working directory the client started us in is the better guess.
        const viaCwd = spawn(LAUNCHER, [BRIDGE, path.join(root, 'not-the-workspace')], {
            stdio: ['pipe', 'pipe', 'pipe'], env: LAUNCH_ENV, cwd: root
        });
        try {
            const cwdIo = attach(viaCwd);
            send(viaCwd, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
            const cwdInit = await cwdIo.take();
            check('a root nobody serves falls back to the working directory',
                cwdInit.result?.protocolVersion === '2025-06-18', cwdInit);
        } finally {
            viaCwd.stdin.end();
            viaCwd.kill();
        }

        // With neither matching, one serving window is still unambiguous. (The
        // refusal to guess between several is a length check the harness cannot
        // reach without waiting out the startup grace period.)
        const isolatedDir = path.join(isolatedHome, '.context-view', 'endpoints');
        fs.mkdirSync(isolatedDir, { recursive: true });
        fs.writeFileSync(path.join(isolatedDir, 'sole.json'), JSON.stringify({
            url: serverA.url, token: serverA.token, pid: process.pid,
            workspaceRoot: root, version: '9.9.9', updatedAt: new Date().toISOString()
        }), 'utf8');
        const stray = spawn(LAUNCHER, [BRIDGE, path.join(root, 'nothing-recorded-here')], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...LAUNCH_ENV, HOME: isolatedHome, USERPROFILE: isolatedHome }
        });
        try {
            const strayIo = attach(stray);
            send(stray, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
            const strayInit = await strayIo.take();
            check('an unmatched workspace falls back to the only window that is serving',
                strayInit.result?.protocolVersion === '2025-06-18', strayInit);
        } finally {
            stray.stdin.end();
            stray.kill();
        }

        // A restarted window means a new port and a new token. The bridge holds
        // the old ones, so it has to notice and re-read the file.
        serverA.dispose();
        await sleep(200);
        serverB = await startMcpServer({ tools, info: { name: 'context-view', version: '9.9.9' }, log: () => undefined });
        check('the restarted endpoint really is a different one', serverB.url !== serverA.url, [serverA.url, serverB.url]);
        writeEndpointFile(root, {
            url: serverB.url, token: serverB.token, pid: process.pid,
            workspaceRoot: root, version: '9.9.9', updatedAt: new Date().toISOString()
        });

        send(child, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
        const afterRestart = await io.take();
        check('bridge recovers after the window restarts on a new port',
            afterRestart.id === 4 && afterRestart.result?.tools?.[0]?.name === 'echo', afterRestart);

        // Window closed for good: the record points at a port nobody holds.
        serverB.dispose();
        serverB = undefined;
        await sleep(200);
        send(child, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
        const dead = await io.take();
        check('an unreachable endpoint is a clear JSON-RPC error, not a hang or a crash',
            dead.id === 5 && !!dead.error && /not reachable/i.test(dead.error.message || ''), dead);

        send(child, { jsonrpc: '2.0', method: 'notifications/cancelled' });
        await sleep(200);
        check('bridge is still alive after all of that', child.exitCode === null, child.exitCode);

        const garbage = 'this is not json\n';
        child.stdin.write(garbage);
        const parseError = await io.take();
        check('malformed input from the editor is answered, not swallowed',
            parseError.error?.code === -32700, parseError);
    } finally {
        if (child) { child.stdin.end(); child.kill(); }
        if (serverA) { try { serverA.dispose(); } catch { /* already gone */ } }
        if (serverB) { try { serverB.dispose(); } catch { /* already gone */ } }
        clearEndpointFile(root);
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(isolatedHome, { recursive: true, force: true });
    }

    console.log(`\n${failures === 0 ? 'all bridge checks passed' : failures + ' BRIDGE CHECK(S) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
    console.error('harness crashed', err);
    process.exit(1);
});
