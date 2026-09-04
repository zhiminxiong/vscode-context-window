import { McpToolDefinition, McpToolOutcome } from './protocol';
import { RelationDirection, ToolResult, queryEnclosingSymbol, queryRelations } from './tools';

/**
 * The tools this extension offers an AI, and the wording that decides whether
 * it reaches for them. Nothing here knows about a transport.
 */

export const MCP_SERVER_NAME = 'context-view';

export const MCP_INSTRUCTIONS = [
    'These tools answer from the editor\'s language server, so they know what the code means,',
    'not just what it looks like. Prefer them over text search when the question is "who calls',
    'this", "what does this reach", "where is this used", or "where does this function begin and',
    'end". Line and character numbers are 1-based, matching search output and the editor gutter.',
    'A result of "the language server has not finished indexing" is not an answer — retry it',
    'rather than concluding that nothing was found.'
].join(' ');

function outcomeFrom(result: ToolResult): McpToolOutcome {
    if (result.status === 'ok') {
        return {
            text: result.detail ? `${result.text}\n\n(${result.detail})` : result.text
        };
    }
    // An empty-but-trustworthy answer is not a failure; a warm-up or a bad
    // location is, because the model should do something different next.
    return {
        text: `${result.status}: ${result.detail || 'No answer.'}`,
        isError: result.status !== 'no_results'
    };
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const parsed = typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : NaN;
}

function asDirection(value: unknown): RelationDirection | undefined {
    return value === 'callers' || value === 'callees' || value === 'both' ? value : undefined;
}

const relationsTool: McpToolDefinition = {
    name: 'code_relations',
    title: 'Code relations (callers, callees, references)',
    description: [
        'Language-server relations for the symbol at a file position.',
        'For a function or method you get its callers and callees as a tree, with the exact call',
        'sites and the source line at each one. For a variable, field, property, constant, or type',
        'you get every reference, grouped under the function that contains it. Which of the two you',
        'get is decided by the language server from the symbol itself and is reported back as',
        '"mode"; you cannot ask for one or the other.',
        'This is real call-graph data, so it follows overrides and super calls and marks recursion,',
        'which a text search cannot do.',
        'Give the 1-based line. The column is optional: without it the symbol declared on that line',
        'is used, or pass "symbol" to name the identifier on the line you mean.'
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            uri: {
                type: 'string',
                description: 'File to look in: a workspace-relative path, an absolute path, or a file:// URI.'
            },
            line: {
                type: 'number',
                description: '1-based line number of the symbol.'
            },
            character: {
                type: 'number',
                description: '1-based column of the symbol. Omit unless the line holds several identifiers.'
            },
            symbol: {
                type: 'string',
                description: 'Identifier on that line to aim at, as an alternative to a column.'
            },
            depth: {
                type: 'number',
                description: 'How many hops out from the symbol. 1 is immediate callers and callees. Defaults to 2, maximum 8. Larger values cost more and return more.'
            },
            direction: {
                type: 'string',
                enum: ['callers', 'callees', 'both'],
                description: 'Which side to report for a function. Defaults to both. Ignored for references.'
            }
        },
        required: ['uri', 'line'],
        additionalProperties: false
    },
    async invoke(args) {
        const line = asNumber(args.line);
        if (!asString(args.uri) || !Number.isFinite(line)) {
            return { text: 'code_relations needs "uri" and a 1-based "line".', isError: true };
        }
        const character = asNumber(args.character);
        const depth = asNumber(args.depth);
        const result = await queryRelations({
            uri: asString(args.uri),
            line,
            character: Number.isFinite(character) ? character : undefined,
            symbol: asString(args.symbol) || undefined,
            depth: Number.isFinite(depth) ? depth : undefined,
            direction: asDirection(args.direction)
        });
        return outcomeFrom(result);
    }
};

const enclosingSymbolTool: McpToolDefinition = {
    name: 'enclosing_symbol',
    title: 'Enclosing symbol for a line',
    description: [
        'The smallest named function, method, class, or namespace that contains a line, with the',
        'exact first and last line of it and, by default, its source.',
        'Use this instead of guessing where a symbol starts and stops after a search hit, or before',
        'proposing an edit to "the function around line N".',
        'The line is 1-based.'
    ].join(' '),
    inputSchema: {
        type: 'object',
        properties: {
            uri: {
                type: 'string',
                description: 'File to look in: a workspace-relative path, an absolute path, or a file:// URI.'
            },
            line: {
                type: 'number',
                description: '1-based line number inside the symbol.'
            },
            includeText: {
                type: 'boolean',
                description: 'Include the symbol\'s source. Defaults to true; very long symbols return only their range.'
            }
        },
        required: ['uri', 'line'],
        additionalProperties: false
    },
    async invoke(args) {
        const line = asNumber(args.line);
        if (!asString(args.uri) || !Number.isFinite(line)) {
            return { text: 'enclosing_symbol needs "uri" and a 1-based "line".', isError: true };
        }
        const result = await queryEnclosingSymbol({
            uri: asString(args.uri),
            line,
            includeText: args.includeText !== false
        });
        return outcomeFrom(result);
    }
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [relationsTool, enclosingSymbolTool];
