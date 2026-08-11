// Extrae el HTML del webview tal cual lo genera src/extension.ts y crea
// test/test.html con las variables CSS de VS Code (tema oscuro) para
// probarlo en un navegador normal. La versión se lee de package.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const src = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8');
const version = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8')
).version;

const start = src.indexOf('return `<!DOCTYPE html>');
const end = src.indexOf('</html>`;', start);
if (start === -1 || end === -1) throw new Error('No se encontró la plantilla HTML');
let html = src.slice(start + 'return `'.length, end + '</html>'.length);

const config = JSON.stringify({
  user: { name: 'María Dev', email: 'maria.dev@banco.demo' },
  mockMode: true,
  version
});

// Sustituye los placeholders de la template literal. El CSP de prueba es
// permisivo (file:) — el real lo pone la extensión con asWebviewUri.
html = html
  .replaceAll('${csp}', "default-src 'none'; img-src data: file: *; style-src 'unsafe-inline' file: *; script-src 'unsafe-inline' file: *; connect-src *")
  .replaceAll('${styleUri}', pathToFileURL(join(ROOT, 'media', 'main.css')).href)
  .replaceAll('${scriptUri}', pathToFileURL(join(ROOT, 'media', 'main.js')).href)
  .replaceAll('${logoUri}', pathToFileURL(join(ROOT, 'media', 'logo.svg')).href)
  .replaceAll('${nonce}', 'testnonce')
  .replaceAll('${config}', config);

if (html.includes('${')) {
  const leftover = html.match(/\$\{[^}]+\}/g);
  throw new Error('Placeholders sin sustituir: ' + leftover.join(', '));
}

// Variables de tema (VS Code Dark+) para que el render sea fiel.
const themeVars = `<style>
:root {
  --vscode-font-family: "Segoe UI", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: "Consolas", monospace;
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1e1e1e;
  --vscode-sideBar-background: #252526;
  --vscode-sideBarTitle-foreground: #bbbbbb;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-panel-border: #3c3c3c;
  --vscode-focusBorder: #007fd4;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-placeholderForeground: #8a8a8a;
  --vscode-input-border: #3c3c3c;
  --vscode-dropdown-background: #3c3c3c;
  --vscode-dropdown-foreground: #f0f0f0;
  --vscode-dropdown-border: #3c3c3c;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-editor-inactiveSelectionBackground: #3a3d41;
  --vscode-textBlockQuote-background: #2b2b2b;
  --vscode-textCodeBlock-background: #303031;
  --vscode-textLink-foreground: #3794ff;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-inputValidation-warningBackground: #352a05;
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-scrollbarSlider-background: rgba(121,121,121,.4);
  --vscode-scrollbarSlider-hoverBackground: rgba(100,100,100,.7);
  --vscode-toolbar-hoverBackground: rgba(90,93,94,.31);
  --vscode-list-hoverBackground: rgba(90,93,94,.25);
  --vscode-list-activeSelectionBackground: rgba(55,148,255,.15);
  --vscode-charts-blue: #3794ff;
  --vscode-charts-purple: #b180d7;
  --vscode-charts-green: #89d185;
  --vscode-charts-orange: #d18616;
  --vscode-charts-red: #f14c4c;
  --vscode-charts-yellow: #cca700;
}
</style></head>`;
html = html.replace('</head>', themeVars);

writeFileSync(join(HERE, 'test.html'), html);
console.log('test.html generado (v' + version + '), placeholders OK');
