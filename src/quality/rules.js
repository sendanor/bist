const callable = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);
const signatures = ["TSCallSignatureDeclaration", "TSDeclareFunction", "TSMethodSignature"];
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

function explanatory(text) {
  return text.trim().split(/\s+/u).length >= 3 && /[\p{L}]{3}/u.test(text);
}

function tags(doc, name) {
  return doc
    .split("\n")
    .map((line) => line.trim().replace(/^\*\s*/u, ""))
    .filter((line) => line.startsWith("@" + name + " "))
    .map((line) => line.slice(name.length + 2).trim());
}

function documentedCallable(node) {
  if (node.type === "FunctionDeclaration" || signatures.includes(node.type)) {
    return node;
  }
  const parent = node.parent;
  if (
    [
      "VariableDeclarator",
      "MethodDefinition",
      "PropertyDefinition",
      "ExportDefaultDeclaration",
    ].includes(parent?.type)
  ) {
    return parent.type === "VariableDeclarator" ? node : parent;
  }
  return undefined;
}

function functionDocumentation(context, node) {
  const owner = documentedCallable(node);
  if (!owner) {
    return;
  }
  const doc = lookupComment(context.sourceCode, owner);
  const description = doc
    .split(/\n\s*\*?\s*@/u, 1)[0]
    .replace(/\*/gu, "")
    .trim();
  if (!explanatory(description)) {
    report(
      context,
      owner,
      "Describe what this callable does, how to use it, and any relevant constraints or side effects.",
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
    const target =
      param.type === "AssignmentPattern"
        ? param.left
        : param.type === "RestElement"
          ? param.argument
          : param;
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

function memberName(node) {
  if (node.type !== "MemberExpression") {
    return undefined;
  }
  return node.computed ? node.property.value : node.property.name;
}

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

function rule(create, schema = []) {
  return { meta: { schema }, create };
}

function forFunctions(listener) {
  return Object.fromEntries([...callable].map((name) => [name, listener]));
}

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
    ThrowStatement: (node) => throwDocumentation(context, node),
  })),
  "function-size": rule((context) => forFunctions((node) => size(context, node, 100))),
  "file-size": rule((context) => ({ Program: (node) => size(context, node, 500) })),
  "promise-chains": rule((context) => ({
    CallExpression(node) {
      if (["then", "catch"].includes(memberName(node.callee))) {
        report(context, node, "Prefer await and try/catch for promise chains.");
      }
    },
  })),
  "promise-all": rule((context) => ({
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
    function check(node) {
      if (directReturn(node)) {
        report(context, node, "Use a concrete type in the explicit return contract.");
      }
    }
    return { TSAnyKeyword: check, TSUnknownKeyword: check };
  }),
  "explicit-any": rule((context) => ({
    TSAnyKeyword: (node) =>
      report(
        context,
        node,
        "Replace explicit any with a concrete type or narrow unknown at an input boundary.",
      ),
  })),
  "review-unknown": rule((context) => ({
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
    TSTypeLiteral(node) {
      if (isParameterAnnotation(node)) {
        report(context, node, "Use a documented, named contract for this object parameter.");
      }
    },
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
    TSPropertySignature(node) {
      if (!node.readonly) {
        report(
          context,
          node,
          "Consider readonly if callers do not need to change this contract property.",
        );
      }
    },
    PropertyDefinition(node) {
      if (!node.readonly && node.accessibility) {
        report(context, node, "Consider readonly if this field is only set during construction.");
      }
    },
  })),
  "named-guards": rule((context) => ({
    BinaryExpression(node) {
      if (
        node.left.type === "UnaryExpression" &&
        node.left.operator === "typeof" &&
        typeof node.right.value === "string"
      ) {
        report(context, node, "Consider reusing a named guard for this primitive type check.");
      }
    },
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
    function record(node) {
      if (isBrowserAccess(node)) {
        accesses.push(node);
      }
    }
    return {
      JSXElement() {
        hasJsx = true;
      },
      JSXFragment() {
        hasJsx = true;
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier") {
          record(node.callee);
        }
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier") {
          record(node.callee);
        }
      },
      MemberExpression: record,
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
    JSXText(node) {
      if (/\p{L}/u.test(node.value)) {
        report(context, node, "Move visible JSX text into the project's translation catalog.");
      }
    },
    JSXExpressionContainer(node) {
      if (
        ["JSXElement", "JSXFragment"].includes(node.parent.type) ||
        (node.parent.type === "JSXAttribute" &&
          ["alt", "title", "placeholder", "aria-label"].includes(node.parent.name.name))
      ) {
        directText(context, node.expression);
      }
    },
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
