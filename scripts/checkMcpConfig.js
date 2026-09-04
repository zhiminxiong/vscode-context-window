// Checks that adding our entry to a client's MCP config leaves the rest of it
// alone. These files are the user's: they hold other people's servers, some
// with credentials, and are usually hand-edited. Nothing here needs an editor,
// so it runs as a plain script.
//
// Run with `npm run check:mcp`.
const path = require('path');
const { mergeServerEntry, serversKey, DEFAULT_KEY } = require(path.join(__dirname, '..', 'out', 'mcp', 'configMerge.js'));

const NAME = 'context-view';
const ENTRY = { type: 'stdio', command: 'node', args: ['C:\\Users\\me\\.context-view\\mcpBridge.js', '${workspaceFolder}'] };

let failures = 0;
function check(label, ok, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`}`);
    if (!ok) { failures++; }
}

function merged(text) {
    const out = mergeServerEntry(text, NAME, ENTRY);
    if ('unreadable' in out) { throw new Error(`unexpectedly unreadable: ${out.unreadable}`); }
    return out;
}

// A config with other servers in it, one of them carrying a secret.
const populated = `{
  "mcpServers": {
    "amap-amap-sse": { "url": "https://mcp.amap.com/sse?key=SECRET-KEY" },
    "gitlens": {
      "command": "npx",
      "args": ["-y", "gitlens-mcp"],
      "env": { "TOKEN": "do-not-lose-me" }
    }
  },
  "somethingElseEntirely": { "keepMe": true }
}
`;

{
    const out = merged(populated).text;
    const parsed = JSON.parse(out);
    check('our entry is added', JSON.stringify(parsed.mcpServers[NAME]) === JSON.stringify(ENTRY), parsed.mcpServers[NAME]);
    check('the other servers are still there',
        !!parsed.mcpServers['amap-amap-sse'] && !!parsed.mcpServers.gitlens, Object.keys(parsed.mcpServers));
    check('their settings are untouched',
        parsed.mcpServers.gitlens.env.TOKEN === 'do-not-lose-me'
        && parsed.mcpServers['amap-amap-sse'].url.includes('SECRET-KEY'), parsed.mcpServers);
    check('unrelated top-level keys survive', parsed.somethingElseEntirely?.keepMe === true, Object.keys(parsed));
    check('nothing but our key is rewritten',
        out.includes('"amap-amap-sse": { "url": "https://mcp.amap.com/sse?key=SECRET-KEY" }'), out);
}

// Hand-edited configs have comments in them; CodeBuddy's own documentation
// shows them. Reflowing or, worse, replacing such a file is not acceptable.
const commented = `{
  // Keep this one first, the order matters to me
  "mcpServers": {
    /* the map service */
    "amap-amap-sse": { "url": "https://mcp.amap.com/sse?key=SECRET-KEY" },
  },
}
`;

{
    const out = merged(commented).text;
    check('a file with comments is still readable', out.includes(NAME), out);
    check('the comments are kept',
        out.includes('// Keep this one first') && out.includes('/* the map service */'), out);
    check('the server that was already there is kept', out.includes('SECRET-KEY'), out);
}

// Replacing our own entry, which is what re-running the command does.
{
    const once = merged(populated).text;
    const twice = merged(once).text;
    check('re-running is idempotent', twice === once);
    const stale = once.replace('"command": "node"', '"command": "C:\\\\old\\\\Cursor.exe"');
    const refreshed = merged(stale).text;
    check('a stale entry is replaced, not duplicated',
        (refreshed.match(new RegExp(`"${NAME}"`, 'g')) || []).length === 1
        && refreshed.includes('"command": "node"')
        && !refreshed.includes('Cursor.exe'), refreshed);
}

// VS Code's shape. Answer an existing file in its own terms.
{
    const out = merged(`{\n  "servers": {\n    "other": { "command": "x" }\n  }\n}\n`).text;
    const parsed = JSON.parse(out);
    check('an existing "servers" file keeps that key',
        !!parsed.servers[NAME] && parsed.mcpServers === undefined, Object.keys(parsed));
    check('"mcpServers" wins when both are present',
        serversKey({ servers: {}, mcpServers: {} }) === DEFAULT_KEY);
    check('a file with neither gets the common key', serversKey({}) === DEFAULT_KEY);
}

// Files that do not exist yet, or are empty.
for (const [label, text] of [['an absent', undefined], ['an empty', ''], ['a whitespace-only', '\n  \n']]) {
    const parsed = JSON.parse(merged(text).text);
    check(`${label} file becomes a valid config`, !!parsed[DEFAULT_KEY][NAME], parsed);
}

// The whole point: a file we cannot understand keeps its contents.
for (const [label, text] of [
    ['truncated', '{ "mcpServers": { "other": { "command": '],
    ['not an object', '[1, 2, 3]'],
    ['nonsense', 'this is not a config at all']
]) {
    const out = mergeServerEntry(text, NAME, ENTRY);
    check(`a ${label} file is refused rather than rewritten`, 'unreadable' in out, out);
}

// CRLF should not turn the file into mixed line endings.
{
    const out = merged(populated.replace(/\n/g, '\r\n')).text;
    check('CRLF files stay CRLF', !/[^\r]\n/.test(out), out.slice(0, 120));
}

console.log(`\n${failures === 0 ? 'all config checks passed' : failures + ' CONFIG CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
