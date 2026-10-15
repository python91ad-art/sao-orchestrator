import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

const routerMembers = new Map<string, string[]>();
const roots = new Map<string, string>();
for (const file of ['server/routers.ts', 'server/operationsRouter.ts']) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'router') {
      const argument = node.initializer.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const name = node.name.getText(source);
        routerMembers.set(name, argument.properties.flatMap(property => property.name ? [property.name.getText(source)] : []));
        if (name === 'appRouter') for (const property of argument.properties) if (ts.isPropertyAssignment(property)) roots.set(property.name.getText(source), property.initializer.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const procedures = new Set([...roots].flatMap(([prefix, router]) => (routerMembers.get(router) || []).map(member => `${prefix}.${member}`)));
const inventory: any[] = [];
const endpoints = new Set<string>();
for (const file of files('client/src').filter(file => /\.tsx?$/.test(file))) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const match of text.matchAll(/trpc\.([\w]+\.[\w]+)\.use(?:Query|Mutation)|trpc(?:Query|Mutation)\(['"]([\w]+\.[\w]+)['"]/g)) endpoints.add(match[1] || match[2]);
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (['button', 'a', 'input', 'select', 'textarea', 'form', 'details', 'Dialog', 'IconButton'].includes(tag)) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const values = Object.fromEntries(attributes.map(attribute => [attribute.name.getText(source), attribute.initializer?.getText(source) || 'true']));
        const handlers = Object.keys(values).filter(name => /^on[A-Z]/.test(name));
        const nativeAction = tag === 'details' || (tag === 'a' && Boolean(values.href)) || (tag === 'button' && /submit/.test(values.type || ''));
        inventory.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, tag, label: values['aria-label'] || values.title || values.placeholder || null, handlers: Object.fromEntries(handlers.map(name => [name, values[name].slice(0, 240)])), disabled: values.disabled || null, nativeAction, review: 'STATIC_INSPECTION_ONLY; browser coverage recorded separately' });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const missingEndpoints = [...endpoints].filter(endpoint => !procedures.has(endpoint));
const summary = { sourceFiles: files('client/src').filter(file => /\.tsx?$/.test(file)).length, controls: inventory.length, byTag: Object.fromEntries([...new Set(inventory.map(control => control.tag))].map(tag => [tag, inventory.filter(control => control.tag === tag).length])), endpoints: endpoints.size, missingEndpoints, note: 'Counts are source declarations, not rendered row instances or proof every action executed.' };
fs.writeFileSync(process.argv[2] || 'SAO_FRONTEND_INTERACTION_INVENTORY.json', JSON.stringify({ summary, endpoints: [...endpoints].sort(), inventory }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (missingEndpoints.length) process.exitCode = 1;
