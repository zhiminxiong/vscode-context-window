import * as jsonc from 'jsonc-parser';

/**
 * Puts this extension's entry into a client's MCP config without disturbing
 * anything else in it.
 *
 * Kept free of `vscode` imports so it can be driven from a harness: these
 * files belong to the user and hold other servers, some with credentials in
 * them, so "only touches its own key" has to be something we check rather
 * than something we assert.
 *
 * The edit is applied to the text rather than to a parsed object, because a
 * parse-and-restringify would drop comments and reflow every line the user
 * wrote. Several clients document their config with comments in it, so that is
 * not a hypothetical.
 */

export const DEFAULT_KEY = 'mcpServers';

export type MergeOutcome =
    | { text: string }
    /** Left alone: we could not read it, so we cannot know what we would lose. */
    | { unreadable: string };

/**
 * Taken from the file rather than from which client we believe owns it, since
 * a custom path could belong to anything. Nearly all of them nest servers
 * under `mcpServers`; VS Code's `servers` is the exception, and answering an
 * existing file in its own terms is more reliable than matching on the path.
 */
export function serversKey(config: unknown): string {
    if (!config || typeof config !== 'object') {
        return DEFAULT_KEY;
    }
    const held = config as Record<string, unknown>;
    return 'servers' in held && !(DEFAULT_KEY in held) ? 'servers' : DEFAULT_KEY;
}

function describePosition(text: string, offset: number): string {
    const upto = text.slice(0, offset);
    const line = upto.split(/\r\n|\r|\n/).length;
    const lastBreak = Math.max(upto.lastIndexOf('\n'), upto.lastIndexOf('\r'));
    return `line ${line}, column ${offset - lastBreak}`;
}

export function mergeServerEntry(
    existing: string | undefined,
    name: string,
    entry: unknown
): MergeOutcome {
    const text = existing && existing.trim() ? existing : '{}';

    // Comments and trailing commas are accepted, so an ordinary hand-edited
    // config is not mistaken for a corrupt one.
    const errors: jsonc.ParseError[] = [];
    const parsed = jsonc.parse(text, errors, { allowTrailingComma: true });
    if (errors.length) {
        const first = errors[0];
        return {
            unreadable: `${jsonc.printParseErrorCode(first.error)} at ${describePosition(text, first.offset)}`
        };
    }
    if (parsed !== undefined && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
        return { unreadable: 'the file does not contain a JSON object' };
    }

    const edits = jsonc.modify(text, [serversKey(parsed), name], entry, {
        formattingOptions: {
            tabSize: 2,
            insertSpaces: true,
            eol: text.includes('\r\n') ? '\r\n' : '\n'
        }
    });
    const merged = jsonc.applyEdits(text, edits);
    return { text: merged.endsWith('\n') ? merged : `${merged}\n` };
}
