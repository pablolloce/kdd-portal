# Pruebas del webview (headless)

Harness que carga el HTML **real** del webview (extraído de
`src/extension.ts`) en Chromium headless, recorre todo el flujo (menú,
calendario, informe TRA, equipo, KB, modal del chat) y deja un informe
JSON por consola + capturas PNG en esta carpeta.

## Ejecutar

```bash
cd test
npm init -y && npm i playwright     # solo la primera vez
npx playwright install chromium     # si no hay navegador descargado
node build-test-html.mjs
node test-webview.mjs
```

- Si ya tienes un Chromium/Chrome en el sistema, puedes saltarte la
  descarga: `CHROMIUM_PATH=/ruta/al/chromium node test-webview.mjs`.
- `build-test-html.mjs` lee la versión de `package.json` y regenera
  `test.html`; ejecútalo siempre tras tocar `src/extension.ts`,
  `media/main.js` o `media/main.css`.
- Revisa el JSON (todo deberían ser valores esperados/true) **y** las
  capturas: son la validación visual.

Los artefactos generados (test.html, *.png, node_modules) no se
versionan.
