import ts from "typescript";

/**
 * Recognize definitions that should be visually separated from other declarations.
 * @param node TypeScript syntax node for a statement, class member, or object property.
 */
function declaration(node) {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.some(
      ({ initializer }) =>
        initializer &&
        (ts.isArrowFunction(initializer) ||
          ts.isFunctionExpression(initializer) ||
          ts.isClassExpression(initializer)),
    );
  }
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node)
  );
}

/**
 * Check whether adjacent signatures describe the same overloaded function or method.
 * @param previous First declaration in the pair.
 * @param next Next declaration or implementation.
 * @param source Parsed file used to compare declaration names.
 */
function overload(previous, next, source) {
  return (
    previous.kind === next.kind &&
    !previous.body &&
    (ts.isFunctionDeclaration(previous) ||
      ts.isMethodDeclaration(previous) ||
      ts.isConstructorDeclaration(previous)) &&
    previous.name?.getText(source) === next.name?.getText(source)
  );
}

/**
 * Place a blank line between adjacent declarations before any leading comments.
 * @param text Source text to space without changing tokens or comment contents.
 * @param filename File name used to distinguish TypeScript and JSX syntax.
 */
export function spaceDeclarations(text, filename = "source.tsx") {
  let source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest);
  if (source.parseDiagnostics.length && filename.endsWith(".tsx")) {
    source = ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest);
  }
  if (source.parseDiagnostics.length) {
    return text;
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const edits = [];

  /**
   * Record spacing for siblings while preserving leading and trailing comments.
   * @param nodes Declarations in source order within the same containing scope.
   */
  function separate(nodes) {
    for (let index = 1; index < nodes.length; index++) {
      const previous = nodes[index - 1];
      const next = nodes[index];
      if (!declaration(previous) || !declaration(next) || overload(previous, next, source)) {
        continue;
      }
      const trailing = ts.getTrailingCommentRanges(text, next.pos) ?? [];
      const inlineDoc = trailing.find(({ pos }) => text.startsWith("/**", pos));
      const beforeDoc = inlineDoc ? trailing.slice(0, trailing.indexOf(inlineDoc)) : trailing;
      const start = beforeDoc.at(-1)?.end ?? next.pos;
      const first = inlineDoc ?? ts.getLeadingCommentRanges(text, next.pos)?.[0];
      const end = first?.pos ?? next.getStart(source);
      const gap = text.slice(start, end);
      if (!/^\s*$/u.test(gap) || /\n[ \t\r]*\n/u.test(gap)) {
        continue;
      }
      const line = gap.search(/\r?\n/u);
      edits.push({ pos: start + Math.max(0, line), value: line < 0 ? newline + newline : newline });
    }
  }

  /**
   * Find sibling lists that can contain adjacent declarations.
   * @param node Current syntax node in the traversal.
   */
  function visit(node) {
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      separate(node.statements);
    } else if (
      ts.isClassLike(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeLiteralNode(node)
    ) {
      separate(node.members);
    } else if (ts.isObjectLiteralExpression(node)) {
      separate(node.properties);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  for (const { pos, value } of edits.sort((a, b) => b.pos - a.pos)) {
    text = text.slice(0, pos) + value + text.slice(pos);
  }
  return text;
}
