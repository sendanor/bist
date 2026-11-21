const callable = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);
const signatures = [
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSDeclareFunction",
  "TSMethodSignature",
  "TSEmptyBodyFunctionExpression",
];
const mutators = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
export const exceptionRules = [
  "documentation",
  "document-throws",
  "function-size",
  "file-size",
  "promise-all",
];
const exception = /^quality-ignore-next-line ([a-z-]+) -- (\S.*)$/u;

/**
 * Find the JSDoc block attached to a callable or its declaration.
 * @param source The source and associated comment tokens.
 * @param node The callable or declaration to inspect for an attached comment.
 */
function lookupComment(source, node) {
  const owner = node.parent?.type === "VariableDeclarator" ? node.parent.parent : node;
  const declaration =
    owner.parent?.type === "ExportNamedDeclaration" ||
    owner.parent?.type === "ExportDefaultDeclaration"
      ? owner.parent
      : owner;
  const comment = source.getCommentsBefore(declaration).at(-1);
  return comment?.type === "Block" && comment.value.startsWith("*") ? comment.value : "";
}

/**
 * Report a quality finding unless a narrowly scoped exception covers it.
 * @param context The ESLint context for the current rule.
 * @param node The offending syntax node associated with the finding.
 * @param message The diagnostic text to show the author.
 * @param loc The specific position used for reporting and exception lookup.
 */
function report(context, node, message, loc = node.loc.start) {
  const name = context.id.split("/").at(-1);
  if (exceptionRules.includes(name)) {
    for (const comment of context.sourceCode.getAllComments()) {
      if (comment.loc.end.line !== loc.line - 1) {
        continue;
      }
      const match = comment.value.trim().match(exception);
      if (match?.[1] === name && explanatory(match[2])) {
        return;
      }
    }
  }
  context.report({ node, loc, message });
}

/**
 * Check that documentation contains a minimal natural-language explanation.
 * @param text The description or tag detail to assess.
 */
function explanatory(text) {
  return text.trim().split(/\s+/u).length >= 3 && /[\p{L}]{3}/u.test(text);
}

/**
 * Extract the contents of the named tags from a JSDoc block.
 * @param doc The raw JSDoc comment value supplied by ESLint.
 * @param name The tag name without its leading at sign.
 */
function tags(doc, name) {
  return doc
    .split("\n")
    .map((line) => line.trim().replace(/^\*\s*/u, ""))
    .filter((line) => line.startsWith("@" + name + " "))
    .map((line) => line.slice(name.length + 2).trim());
}

/**
 * Find the declaration responsible for documenting a callable.
 * @param node The function or signature node under inspection.
 */
function documentedCallable(node) {
  const parent = node.parent;
  if (parent?.type === "AssignmentExpression" && parent.parent?.type === "ExpressionStatement") {
    return parent.parent;
  }
  if (
    [
      "VariableDeclarator",
      "MethodDefinition",
      "TSAbstractMethodDefinition",
      "Property",
      "PropertyDefinition",
      "ExportDefaultDeclaration",
    ].includes(parent?.type)
  ) {
    return parent.type === "VariableDeclarator" ? node : parent;
  }
  if (node.type === "FunctionDeclaration" || signatures.includes(node.type) || node.id) {
    return node;
  }
  return undefined;
}

/**
 * Check a callable's JSDoc description and parameter meanings.
 * @param context The ESLint context used to read and report JSDoc.
 * @param node The callable whose declaration and parameters are checked.
 */
function functionDocumentation(context, node) {
  const owner = documentedCallable(node);
  if (!owner) {
    return;
  }
  const doc = lookupComment(context.sourceCode, owner);
  const description = doc
    .replace(/^[ \t]*\*[ \t]?/gmu, "")
    .split(/(?:^|\n)[ \t]*@/u, 1)[0]
    .trim();
  if (!explanatory(description)) {
    report(
      context,
      owner,
      "Add JSDoc to describe what this callable does, how to use it, and any relevant constraints or side effects.",
    );
    return;
  }
  const entries = tags(doc, "param").map((tag) => {
    const plain = tag.replace(/^\{[^}]*\}\s*/u, "");
    const name = plain
      .split(/\s+/u)[0]
      .replace(/^\[|\]$/gu, "")
      .split("=")[0];
    return { name, detail: plain.replace(/^\S+\s*(?:-\s*)?/u, "") };
  });
  const topLevel = entries.filter((entry) => !entry.name.includes("."));
  for (const [index, param] of node.params.entries()) {
    let target = param.type === "TSParameterProperty" ? param.parameter : param;
    if (target.type === "AssignmentPattern") {
      target = target.left;
    } else if (target.type === "RestElement") {
      target = target.argument;
    }
    const name = target.type === "Identifier" ? target.name : undefined;
    const entry = name ? topLevel.find((entry) => entry.name === name) : topLevel[index];
    if (!entry || !explanatory(entry.detail) || entry.detail.trim() === entry.name) {
      report(
        context,
        owner,
        `Describe what ${name ? "parameter '" + name + "'" : "parameter " + (index + 1)} means in @param.`,
      );
    }
  }
}

/**
 * Check that an escaping explicit throw has a corresponding JSDoc tag.
 * @param context The ESLint context supplying comments and diagnostic reporting.
 * @param node The explicit throw statement to trace through enclosing scopes.
 */
function throwDocumentation(context, node) {
  let current = node;
  let owner;
  while (current.parent) {
    const parent = current.parent;
    if (parent.type === "TryStatement" && parent.handler && parent.block === current) {
      return;
    }
    if (callable.has(parent.type)) {
      owner = documentedCallable(parent) ?? parent;
      break;
    }
    current = parent;
  }
  if (!owner) {
    return;
  }
  const callee = node.argument?.callee;
  const type =
    callee?.type === "Identifier" && node.argument.type === "NewExpression"
      ? callee.name
      : undefined;
  const doc = lookupComment(context.sourceCode, owner);
  const entries = [...tags(doc, "throws"), ...tags(doc, "exception")];
  if (
    !entries.some((entry) => {
      const match = /^\{([\w.]+)\}\s*(?:-\s*)?(.+)$/u.exec(entry);
      return match && (!type || match[1] === type) && explanatory(match[2]);
    })
  ) {
    report(
      context,
      node,
      `Document the condition for this ${type ?? "error"} with @throws {ErrorType}.`,
    );
  }
}

/**
 * Report excessive code length using token lines, excluding comment-only lines.
 * @param context The current ESLint context for reading tokens.
 * @param node The function or program whose code lines count.
 * @param max The maximum number of code lines allowed.
 */
function size(context, node, max) {
  const lines = new Set();
  for (const token of context.sourceCode.getTokens(node)) {
    for (let line = token.loc.start.line; line <= token.loc.end.line; line++) {
      if (context.sourceCode.lines[line - 1]?.trim()) {
        lines.add(line);
      }
    }
  }
  if (lines.size > max) {
    const loc =
      node.type === "Program" ? context.sourceCode.getFirstToken(node).loc.start : node.loc.start;
    report(context, node, `Found ${lines.size} code lines. Limit is ${max}.`, loc);
  }
}

/**
 * Read a statically named property from a member expression.
 * @param node The syntax node that may represent a member access.
 */
function memberName(node) {
  if (node.type !== "MemberExpression") {
    return undefined;
  }
  return node.computed ? node.property.value : node.property.name;
}

/**
 * Identify a loose type that is part of an explicit return contract.
 * @param node The type annotation node to trace through wrappers.
 */
function directReturn(node) {
  let current = node.parent;
  while (
    [
      "TSUnionType",
      "TSIntersectionType",
      "TSParenthesizedType",
      "TSTypeParameterInstantiation",
      "TSArrayType",
    ].includes(current?.type)
  ) {
    current = current.parent;
  }
  if (current?.type === "TSTypeReference") {
    return (
      ["Promise", "PromiseLike", "Array", "ReadonlyArray"].includes(current.typeName.name) &&
      directReturn(current)
    );
  }
  return (
    current?.type === "TSTypeAnnotation" &&
    (current.parent.returnType === current || current.parent.type === "TSCallSignatureDeclaration")
  );
}

/**
 * Suggest readonly array parameters when local references never mutate them.
 * @param context The ESLint context with variable and scope information.
 * @param node The callable whose array parameters should be inspected.
 */
function readonlyParameter(context, node) {
  for (const param of node.params) {
    const annotation = param.typeAnnotation?.typeAnnotation;
    const isArray =
      annotation?.type === "TSArrayType" ||
      (annotation?.type === "TSTypeReference" && annotation.typeName.name === "Array");
    if (!isArray || param.type !== "Identifier") {
      continue;
    }
    const variable = context.sourceCode
      .getDeclaredVariables(node)
      .find((entry) => entry.name === param.name);
    const written = variable?.references.some((reference) => {
      const { identifier } = reference;
      const member = identifier.parent;
      if (member.type !== "MemberExpression" || member.object !== identifier) {
        return reference.isWrite();
      }
      const usage = member.parent;
      return (
        (usage.type === "CallExpression" &&
          usage.callee === member &&
          mutators.has(memberName(member))) ||
        (usage.type === "AssignmentExpression" && usage.left === member) ||
        usage.type === "UpdateExpression" ||
        (usage.type === "UnaryExpression" && usage.operator === "delete")
      );
    });
    if (variable && !written) {
      report(
        context,
        param,
        "Consider a readonly array for this input. Check calls and aliases before changing the contract.",
      );
    }
  }
}

/**
 * Declare a quality rule with its listener factory and option schema.
 * @param create The function that registers rule listeners for a context.
 * @param schema The JSON Schema describing accepted rule options.
 */
function rule(create, schema = []) {
  return { meta: { schema }, create };
}

/**
 * Register one listener for each supported function expression or declaration.
 * @param listener The function invoked for each callable node.
 */
function forFunctions(listener) {
  return Object.fromEntries([...callable].map((name) => [name, listener]));
}

/**
 * Check whether a type node annotates a function parameter.
 * @param node The type node to locate in its surrounding declaration.
 */
function isParameterAnnotation(node) {
  const parameter = node.parent?.type === "TSTypeAnnotation" ? node.parent.parent : undefined;
  const owner = parameter?.parent;
  return Boolean(owner?.params?.includes(parameter) || owner?.parent?.params?.includes(owner));
}

const browserMethods = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "indexedDB",
  "localStorage",
  "sessionStorage",
  "sendBeacon",
]);

/**
 * Identify direct network or storage access through known browser APIs.
 * @param node The callee or member node to inspect for browser access.
 */
function isBrowserAccess(node) {
  if (node.type === "Identifier") {
    return browserMethods.has(node.name);
  }
  if (node.type === "MemberExpression") {
    return (
      browserMethods.has(memberName(node)) &&
      (node.object.name === "window" ||
        node.object.name === "globalThis" ||
        node.object.name === "navigator")
    );
  }
  return false;
}

/**
 * Find visible JSX text literals that bypass the translation catalog.
 * @param context The lint context used to report visible text.
 * @param value The JSX expression or literal under inspection.
 */
function directText(context, value) {
  if (!value) {
    return;
  }
  if (value.type === "ConditionalExpression") {
    directText(context, value.consequent);
    directText(context, value.alternate);
  } else if (
    (typeof value.value === "string" && /\p{L}/u.test(value.value)) ||
    (value.type === "TemplateLiteral" &&
      value.quasis.some((element) => /\p{L}/u.test(element.value.raw)))
  ) {
    report(context, value, "Move visible JSX text into the project's translation catalog.");
  }
}

export const qualityRules = {
  documentation: rule((context) =>
    Object.fromEntries(
      [...callable, ...signatures].map((name) => [
        name,
        (node) => functionDocumentation(context, node),
      ]),
    ),
  ),
  "document-throws": rule((context) => ({
    /**
     * Check an explicit throw for its documented error condition.
     * @param node The throw statement that may escape its callable.
     */
    ThrowStatement: (node) => throwDocumentation(context, node),
  })),
  "function-size": rule((context) => forFunctions((node) => size(context, node, 100))),
  "file-size": rule((context) => ({
    /**
     * Check a source file against the code line limit.
     * @param node The program node containing all authored tokens.
     */
    Program: (node) => size(context, node, 500),
  })),
  "promise-chains": rule((context) => ({
    /**
     * Report direct promise chaining when async and await can express the flow.
     * @param node The call expression to inspect for promise methods.
     */
    CallExpression(node) {
      if (["then", "catch"].includes(memberName(node.callee))) {
        report(context, node, "Prefer await and try/catch for promise chains.");
      }
    },
  })),
  "promise-all": rule((context) => ({
    /**
     * Require a deliberate fail-fast justification for Promise.all calls.
     * @param node The call expression to inspect for Promise.all.
     */
    CallExpression(node) {
      if (memberName(node.callee) === "all" && node.callee.object.name === "Promise") {
        report(
          context,
          node,
          "Account for tasks that continue after Promise.all rejects, or explain the fail-fast behavior on this line.",
        );
      }
    },
  })),
  directives: rule((context) => ({
    /** Reject broad lint overrides and malformed local exception comments. */
    Program() {
      for (const comment of context.sourceCode.getAllComments()) {
        const value = comment.value.trim();
        const match = value.match(exception);
        if (value.startsWith("quality-ignore")) {
          if (!match || !exceptionRules.includes(match[1]) || !explanatory(match[2])) {
            report(
              context,
              comment,
              "Name one supported rule and give a concrete reason after '--'.",
            );
          }
        } else if (
          /^(?:eslint\b|global\b|exported\b|@ts-(?:ignore|expect-error|nocheck)\b|prettier-ignore\b)/u.test(
            value,
          )
        ) {
          report(
            context,
            comment,
            "Broad or unexplained overrides are prohibited. Use a named, explained line exception.",
          );
        }
      }
    },
  })),
  "no-loose-return": rule((context) => {
    /**
     * Report loose types in explicit return contracts.
     * @param node The any or unknown type node under inspection.
     */
    function check(node) {
      if (directReturn(node)) {
        report(context, node, "Use a concrete type in the explicit return contract.");
      }
    }
    return { TSAnyKeyword: check, TSUnknownKeyword: check };
  }),
  "explicit-any": rule((context) => ({
    /**
     * Flag explicit any for review or rejection by the active policy.
     * @param node The explicit any type node to report.
     */
    TSAnyKeyword: (node) =>
      report(
        context,
        node,
        "Replace explicit any with a concrete type or narrow unknown at an input boundary.",
      ),
  })),
  "review-unknown": rule((context) => ({
    /**
     * Flag unknown annotations outside established unvalidated-input positions.
     * @param node The explicit unknown annotation under inspection.
     */
    TSUnknownKeyword(node) {
      if (
        !directReturn(node) &&
        !context.sourceCode
          .getAncestors(node)
          .some(
            (ancestor) =>
              callable.has(ancestor.type) &&
              ancestor.params.some(
                (param) => param.range[0] <= node.range[0] && param.range[1] >= node.range[1],
              ),
          )
      ) {
        report(
          context,
          node,
          "Confirm this unknown type represents unvalidated input and is narrowed before use.",
        );
      }
    },
  })),
  "named-parameter-types": rule((context) => ({
    /**
     * Require a named contract for an inline object parameter type.
     * @param node The inline object type to check for parameter usage.
     */
    TSTypeLiteral(node) {
      if (isParameterAnnotation(node)) {
        report(context, node, "Use a documented, named contract for this object parameter.");
      }
    },
    /**
     * Check that a named object parameter contract includes documentation.
     * @param node The type reference to resolve in the lexical scope.
     */
    TSTypeReference(node) {
      if (node.typeName.type !== "Identifier" || !isParameterAnnotation(node)) {
        return;
      }
      let scope = context.sourceCode.getScope(node);
      while (scope) {
        const binding = scope.set.get(node.typeName.name);
        if (binding) {
          for (const definition of binding.defs) {
            const contract = definition.node;
            const objectContract =
              contract.type === "TSInterfaceDeclaration" ||
              (contract.type === "TSTypeAliasDeclaration" &&
                contract.typeAnnotation.type === "TSTypeLiteral");
            if (objectContract && !lookupComment(context.sourceCode, contract)) {
              report(
                context,
                node,
                `Document the meaning of parameter contract '${node.typeName.name}'.`,
              );
            }
          }
          return;
        }
        scope = scope.upper;
      }
    },
  })),
  "readonly-input": rule((context) => forFunctions((node) => readonlyParameter(context, node))),
  "readonly-contract": rule((context) => ({
    /**
     * Suggest readonly for mutable properties in type contracts.
     * @param node The interface or type property signature under inspection.
     */
    TSPropertySignature(node) {
      if (!node.readonly) {
        report(
          context,
          node,
          "Consider readonly if callers do not need to change this contract property.",
        );
      }
    },
    /**
     * Suggest readonly for applicable class fields.
     * @param node The class property declaration under inspection.
     */
    PropertyDefinition(node) {
      if (!node.readonly && node.accessibility) {
        report(context, node, "Consider readonly if this field is only set during construction.");
      }
    },
  })),
  "named-guards": rule((context) => ({
    /**
     * Suggest a shared primitive guard for typeof comparisons.
     * @param node The binary expression to inspect for primitive checks.
     */
    BinaryExpression(node) {
      if (
        node.left.type === "UnaryExpression" &&
        node.left.operator === "typeof" &&
        typeof node.right.value === "string"
      ) {
        report(context, node, "Consider reusing a named guard for this primitive type check.");
      }
    },
    /**
     * Suggest shared validators for array and UUID checks.
     * @param node The call expression to inspect for validation patterns.
     */
    CallExpression(node) {
      if (memberName(node.callee) === "isArray" && node.callee.object.name === "Array") {
        report(context, node, "Consider reusing a named array guard.");
      }
      if (
        memberName(node.callee) === "test" &&
        node.callee.object.regex?.pattern.includes("[0-9a-f]") &&
        node.callee.object.regex.pattern.includes("{12}")
      ) {
        report(
          context,
          node,
          "Use a named UUID guard with the contract's case, version, and variant.",
        );
      }
    },
  })),
  "browser-boundaries": rule((context) => {
    let hasJsx = false;
    const accesses = [];
    /**
     * Collect direct browser access for reporting after JSX detection.
     * @param node The possible browser API use to record.
     */
    function record(node) {
      if (isBrowserAccess(node)) {
        accesses.push(node);
      }
    }
    return {
      /** Mark a file that contains a JSX element. */
      JSXElement() {
        hasJsx = true;
      },
      /** Mark a file that contains a JSX fragment. */
      JSXFragment() {
        hasJsx = true;
      },
      /**
       * Collect browser access from calls to a bare identifier.
       * @param node The call to inspect before recording its callee.
       */
      CallExpression(node) {
        if (node.callee.type === "Identifier") {
          record(node.callee);
        }
      },
      /**
       * Collect browser access from constructors named by a bare identifier.
       * @param node The constructor expression whose callee should be checked.
       */
      NewExpression(node) {
        if (node.callee.type === "Identifier") {
          record(node.callee);
        }
      },
      MemberExpression: record,
      /**
       * Collect direct references to browser storage globals.
       * @param node The identifier and its surrounding syntax to inspect.
       */
      Identifier(node) {
        if (
          ["indexedDB", "localStorage", "sessionStorage"].includes(node.name) &&
          node.parent.type !== "MemberExpression"
        ) {
          record(node);
        } else if (
          ["indexedDB", "localStorage", "sessionStorage"].includes(node.name) &&
          node.parent.object === node
        ) {
          record(node);
        }
      },
      /** Report recorded browser accesses if the file contains JSX. */
      "Program:exit"() {
        if (hasJsx) {
          for (const node of accesses) {
            report(
              context,
              node,
              "Use an injected service for network or storage access in a JSX module.",
            );
          }
        }
      },
    };
  }),
  "localize-jsx": rule((context) => ({
    /**
     * Report untranslated text directly embedded in JSX.
     * @param node The JSX text node shown to the user.
     */
    JSXText(node) {
      if (/\p{L}/u.test(node.value)) {
        report(context, node, "Move visible JSX text into the project's translation catalog.");
      }
    },
    /**
     * Inspect text from JSX expressions and user-facing attribute expressions.
     * @param node The JSX expression container and its context.
     */
    JSXExpressionContainer(node) {
      if (
        ["JSXElement", "JSXFragment"].includes(node.parent.type) ||
        (node.parent.type === "JSXAttribute" &&
          ["alt", "title", "placeholder", "aria-label"].includes(node.parent.name.name))
      ) {
        directText(context, node.expression);
      }
    },
    /**
     * Report untranslated literals on user-facing JSX attributes.
     * @param node The JSX attribute and its static value.
     */
    JSXAttribute(node) {
      if (
        ["alt", "title", "placeholder", "aria-label"].includes(node.name.name) &&
        typeof node.value?.value === "string" &&
        /\p{L}/u.test(node.value.value)
      ) {
        report(context, node, "Move this visible attribute into the translation catalog.");
      }
    },
  })),
};
