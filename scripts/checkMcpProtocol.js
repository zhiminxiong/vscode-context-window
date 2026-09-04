// Drives the real MCP endpoint over real HTTP with stand-in tools, covering
// the handshake and the failure cases a client can put us in. The transport is
// hand-written, so this is what keeps it honest as clients are added.
// Run with `npm run check:mcp`.
const http = require('http');
const path = require('path');
const { startMcpServer } = require(path.join(__dirname, '..', 'out', 'mcp', 'server.js'));

const tools = [
    {
        name: 'echo',
        title: 'Echo',
        description: 'Returns what it was given.',
        inputSchema: { type: 'object', properties: { what: { type: 'string' } }, required: ['what'] },
        async invoke(args) { return { text: `got ${JSON.stringify(args)}` }; }
    },
    {
        name: 'boom',
        description: 'Always throws.',
        inputSchema: { type: 'object', properties: {} },
        async invoke() { throw new Error('deliberate'); }
    }
];

let failures = 0;
function check(label, ok, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`}`);
    if (!ok) { failures++; }
}

function request(url, { method = 'POST', token, body, headers = {} } = {}) {
    const u = new URL(url);
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: {
            Accept: 'application/json, text/event-stream',
            ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers
        }
    };
    return new Promise((resolve, reject) => {
        const req = http.request(opts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json;
                try { json = text ? JSON.parse(text) : undefined; } catch { /* not json */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        if (payload !== undefined) { req.write(payload); }
        req.end();
    });
}

(async () => {
    const endpoint = await startMcpServer({
        tools,
        info: { name: 'context-view', version: '9.9.9', instructions: 'Use these tools.' },
        log: m => console.log(`   [server] ${m}`)
    });
    const { url, token } = endpoint;

    // --- handshake ---
    const init = await request(url, { token, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } } });
    check('initialize 200', init.status === 200, init.status);
    check('initialize echoes protocol version', init.json?.result?.protocolVersion === '2025-06-18', init.json?.result);
    check('initialize advertises tools capability', !!init.json?.result?.capabilities?.tools, init.json?.result?.capabilities);
    check('initialize carries serverInfo + instructions',
        init.json?.result?.serverInfo?.name === 'context-view' && typeof init.json?.result?.instructions === 'string',
        init.json?.result);
    check('no session id handed out', init.headers['mcp-session-id'] === undefined, init.headers['mcp-session-id']);

    const older = await request(url, { token, body: { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } } });
    check('older protocol version honoured', older.json?.result?.protocolVersion === '2025-03-26', older.json?.result);

    const unknownVersion = await request(url, { token, body: { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2099-01-01' } } });
    check('unknown version falls back to ours', unknownVersion.json?.result?.protocolVersion === '2025-06-18', unknownVersion.json?.result);

    const initialized = await request(url, { token, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    check('notification answered 202 with empty body', initialized.status === 202 && initialized.text === '', initialized);

    // --- tools ---
    const list = await request(url, { token, body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
    check('tools/list returns both tools', list.json?.result?.tools?.length === 2, list.json?.result);
    check('tool carries name/description/inputSchema',
        list.json?.result?.tools?.[0]?.name === 'echo'
        && typeof list.json?.result?.tools?.[0]?.description === 'string'
        && list.json?.result?.tools?.[0]?.inputSchema?.type === 'object',
        list.json?.result?.tools?.[0]);

    const call = await request(url, { token, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { what: 'hi' } } } });
    check('tools/call returns text content',
        call.json?.result?.content?.[0]?.type === 'text'
        && call.json.result.content[0].text.includes('"what":"hi"')
        && call.json.result.isError === false,
        call.json?.result);

    const noArgs = await request(url, { token, body: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo' } } });
    check('missing arguments become an empty object', noArgs.json?.result?.content?.[0]?.text === 'got {}', noArgs.json?.result);

    const threw = await request(url, { token, body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'boom', arguments: {} } } });
    check('a throwing tool is a tool error, not a protocol error',
        threw.status === 200 && threw.json?.result?.isError === true && threw.json.result.content[0].text.includes('deliberate'),
        threw.json);

    const missingTool = await request(url, { token, body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope' } } });
    check('unknown tool is invalid params (-32602)', missingTool.json?.error?.code === -32602, missingTool.json);

    const ping = await request(url, { token, body: { jsonrpc: '2.0', id: 9, method: 'ping' } });
    check('ping returns an empty result', ping.status === 200 && JSON.stringify(ping.json?.result) === '{}', ping.json);

    const badMethod = await request(url, { token, body: { jsonrpc: '2.0', id: 10, method: 'resources/list' } });
    check('unsupported method is -32601', badMethod.json?.error?.code === -32601, badMethod.json);

    const batch = await request(url, { token, body: [
        { jsonrpc: '2.0', id: 11, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/cancelled' },
        { jsonrpc: '2.0', id: 12, method: 'tools/list' }
    ] });
    check('batch drops notifications and keeps replies in order',
        Array.isArray(batch.json) && batch.json.length === 2 && batch.json[0].id === 11 && batch.json[1].id === 12,
        batch.json);

    // --- transport rules ---
    const get = await request(url, { token, method: 'GET' });
    check('GET is 405 with Allow (no SSE stream offered)', get.status === 405 && /POST/.test(String(get.headers.allow)), get.status);

    const del = await request(url, { token, method: 'DELETE' });
    check('DELETE is 204 (nothing to tear down)', del.status === 204, del.status);

    const wrongPath = await request(url.replace('/mcp', '/nope'), { token, body: { jsonrpc: '2.0', id: 13, method: 'ping' } });
    check('other paths are 404', wrongPath.status === 404, wrongPath.status);

    // --- access control ---
    const noToken = await request(url, { body: { jsonrpc: '2.0', id: 14, method: 'ping' } });
    check('no token is 401 with WWW-Authenticate',
        noToken.status === 401 && /Bearer/i.test(String(noToken.headers['www-authenticate'])),
        noToken.status);

    const badToken = await request(url, { token: 'x'.repeat(64), body: { jsonrpc: '2.0', id: 15, method: 'ping' } });
    check('wrong token of the same length is 401', badToken.status === 401, badToken.status);

    const shortToken = await request(url, { token: 'short', body: { jsonrpc: '2.0', id: 16, method: 'ping' } });
    check('wrong token of a different length is 401, not a crash', shortToken.status === 401, shortToken.status);

    const foreignOrigin = await request(url, { token, headers: { Origin: 'https://evil.example.com' }, body: { jsonrpc: '2.0', id: 17, method: 'ping' } });
    check('a browser origin is refused (DNS rebinding)', foreignOrigin.status === 403, foreignOrigin.status);

    const localOrigin = await request(url, { token, headers: { Origin: 'http://localhost:3000' }, body: { jsonrpc: '2.0', id: 18, method: 'ping' } });
    check('a localhost origin is allowed', localOrigin.status === 200, localOrigin.status);

    // --- malformed input ---
    const notJson = await request(url, { token, body: 'not json at all' });
    check('unparseable body is -32700', notJson.status === 400 && notJson.json?.error?.code === -32700, notJson.json);

    const notAnObject = await request(url, { token, body: 42 });
    check('a non-object body is -32600', notAnObject.json?.error?.code === -32600, notAnObject.json);

    const huge = await request(url, { token, body: JSON.stringify({ jsonrpc: '2.0', id: 19, method: 'ping', params: { pad: 'x'.repeat(1024 * 1024 + 10) } }) });
    check('an oversized body is 413', huge.status === 413, huge.status);

    const stillAlive = await request(url, { token, body: { jsonrpc: '2.0', id: 20, method: 'ping' } });
    check('the server survives all of the above', stillAlive.status === 200, stillAlive.status);

    endpoint.dispose();
    console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' CHECK(S) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
    console.error('harness crashed', err);
    process.exit(1);
});
