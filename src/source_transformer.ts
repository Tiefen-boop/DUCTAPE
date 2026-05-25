
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as ir from 'graphir';

import { ExportedFunction } from './addon_generator.js';

// ─── IR type → TypeScript type string ────────────────────────────────────────

function irTypeToTs(type: ir.Type): string {
    if (type instanceof ir.IntegerType && type.width === 1) return 'boolean';
    if (type instanceof ir.IntegerType || type instanceof ir.FloatType || type instanceof ir.NumberType) return 'number';
    if (type instanceof ir.VoidType) return 'void';
    if (type instanceof ir.StaticStringType) return 'string';
    if (type instanceof ir.UndefinedType) return 'undefined';
    if (type instanceof ir.NullType) return 'null';
    if (type instanceof ir.DynamicArrayType) {
        const elem = irTypeToTs(type.elementType);
        const needsParens = type.elementType instanceof ir.UnionType || type.elementType instanceof ir.OptionType;
        return needsParens ? `(${elem})[]` : `${elem}[]`;
    }
    if (type instanceof ir.OptionType) return `${irTypeToTs(type.baseType)} | undefined`;
    if (type instanceof ir.UnionType) {
        const seen = new Set<string>();
        return type.types
            .map(irTypeToTs)
            .filter(s => !seen.has(s) && !!seen.add(s))
            .join(' | ');
    }
    return 'any';
}

// ─── Addon import block ───────────────────────────────────────────────────────

// The type comes from the generated .d.ts file (e.g. addon.d.ts) via `import type`,
// so no inline repetition of the function signatures is needed here.
function buildAddonImportBlock(addonRelPath: string): string {
    const declImportPath = addonRelPath.replace(/\.node$/, '');
    return (
        `import { createRequire } from 'module';\n` +
        `import type * as AddonType from '${declImportPath}';\n` +
        `const addon: typeof AddonType = createRequire(import.meta.url)('${addonRelPath}');\n`
    );
}

// ─── Call-graph helpers ───────────────────────────────────────────────────────

// Collect every identifier that appears in direct-call position within `node`.
function collectCalls(node: ts.Node): Set<string> {
    const result = new Set<string>();
    function visit(n: ts.Node): void {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
            result.add(n.expression.text);
        }
        ts.forEachChild(n, visit);
    }
    ts.forEachChild(node, visit);
    return result;
}

// ─── .d.ts generation ────────────────────────────────────────────────────────

/**
 * Writes `<addonName>.d.ts` next to the addon binary.
 * Declares each exported function; the dt_ file references this via `import type`.
 */
export function generateDeclFile(
    funcs: ExportedFunction[],
    addonOutputPath: string,
): void {
    const lines = funcs.map(f => {
        const params = f.paramTypes.map((t, i) => `p${i}: ${irTypeToTs(t)}`).join(', ');
        return `export declare function ${f.name}(${params}): ${irTypeToTs(f.returnType)};`;
    });

    const absoluteAddon = path.resolve(addonOutputPath);
    const dtsPath = path.join(
        path.dirname(absoluteAddon),
        path.basename(absoluteAddon, '.node') + '.d.ts',
    );
    fs.writeFileSync(dtsPath, lines.join('\n') + '\n');
    console.log(`Generated: ${dtsPath}`);
}

// ─── dt_ file generation ─────────────────────────────────────────────────────

/**
 * Writes `dt_<basename>` next to the addon binary.
 *
 * The generated file:
 *  - imports the addon via createRequire, typed via `import type` from the generated .d.ts
 *  - removes every tagged (exported) function declaration
 *  - removes every helper that is now dead (only reachable through removed functions)
 *  - replaces every call to an exported function with `addon.<name>(...)`
 */
export function generateDtFile(
    inputFilePath: string,
    exportedFunctions: ExportedFunction[],
    addonOutputPath: string,
): void {
    const absoluteInput = path.resolve(inputFilePath);
    const absoluteAddon = path.resolve(addonOutputPath);
    const content = fs.readFileSync(absoluteInput, 'utf8');
    const sourceFile = ts.createSourceFile(absoluteInput, content, ts.ScriptTarget.Latest, true);

    const exportedNames = new Set(exportedFunctions.map(f => f.name));

    // ── Step 1: gather top-level function declarations ──────────────────────
    const funcDecls = new Map<string, ts.FunctionDeclaration>();
    for (const stmt of sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            funcDecls.set(stmt.name.text, stmt);
        }
    }

    // ── Step 2: per-function call graph ─────────────────────────────────────
    const callGraph = new Map<string, Set<string>>();
    for (const [name, decl] of funcDecls) {
        callGraph.set(name, decl.body ? collectCalls(decl.body) : new Set());
    }

    // calls from non-function top-level statements (the reachability roots)
    const topLevelCalls = new Set<string>();
    for (const stmt of sourceFile.statements) {
        if (!ts.isFunctionDeclaration(stmt)) {
            for (const name of collectCalls(stmt)) topLevelCalls.add(name);
        }
    }

    // ── Step 3: BFS — alive = non-exported functions reachable from roots ───
    // Exported functions are NOT followed; their bodies disappear.
    const alive = new Set<string>();
    const queue: string[] = [];

    function enqueue(name: string): void {
        if (!alive.has(name) && funcDecls.has(name) && !exportedNames.has(name)) {
            alive.add(name);
            queue.push(name);
        }
    }

    for (const name of topLevelCalls) enqueue(name);
    for (let i = 0; i < queue.length; i++) {
        for (const callee of callGraph.get(queue[i]) ?? []) enqueue(callee);
    }

    // ── Step 4: decide what to remove ───────────────────────────────────────
    const toRemove = new Set<string>();
    for (const name of funcDecls.keys()) {
        if (exportedNames.has(name) || !alive.has(name)) toRemove.add(name);
    }

    // ── Step 5: text edits ──────────────────────────────────────────────────
    interface Edit { start: number; end: number; replacement: string; }
    const edits: Edit[] = [];

    // 5a. Remove function declarations.
    //     getFullStart() includes leading trivia → picks up the // @ductape-export comment.
    for (const [name, decl] of funcDecls) {
        if (toRemove.has(name)) {
            edits.push({ start: decl.getFullStart(), end: decl.getEnd(), replacement: '' });
        }
    }

    // 5b. Replace calls to exported functions with addon.<name>(...).
    //     Skip inside removed function bodies — they're being deleted anyway.
    function gatherCallEdits(node: ts.Node): void {
        if (ts.isFunctionDeclaration(node) && node.name && toRemove.has(node.name.text)) return;
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            exportedNames.has(node.expression.text)
        ) {
            const id = node.expression;
            edits.push({ start: id.getStart(), end: id.getEnd(), replacement: `addon.${id.text}` });
        }
        ts.forEachChild(node, gatherCallEdits);
    }
    gatherCallEdits(sourceFile);

    // ── Step 6: apply structural edits in reverse order to preserve positions ─
    // Insertion of the addon block is handled separately below to avoid
    // position conflicts when the first function's full-start overlaps the
    // insertion point.
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let result = content;
    for (const edit of edits) {
        result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    }

    // ── Step 7: insert the addon block after the last import line ────────────
    // We operate on the already-edited string so there are no position conflicts.
    // The dt_ file is written next to the addon, so the relative path is always
    // just the addon's own filename.
    const addonRelPath = './' + path.basename(absoluteAddon);
    const addonBlock = buildAddonImportBlock(addonRelPath);

    // Find the end of the last `import …` line (single-line imports only).
    const importLineRe = /^import\s[^\n]*\n/gm;
    let lastImportEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = importLineRe.exec(result)) !== null) {
        lastImportEnd = m.index + m[0].length;
    }
    result = result.slice(0, lastImportEnd) + addonBlock + result.slice(lastImportEnd);

    // ── Step 8: write output next to the addon ──────────────────────────────
    const outputPath = path.join(path.dirname(absoluteAddon), 'dt_' + path.basename(absoluteInput));
    fs.writeFileSync(outputPath, result);
    console.log(`Generated: ${outputPath}`);
}
