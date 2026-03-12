# Pixel Copilot Agent

Standalone VS Code extensie in een eigen repository met:

- een @pixel chat participant voor Copilot Chat
- een Pixel Agent panel met runtime events (chat, workspace, diagnostics en taken)
- een hybride webview-flow:
  - devserver via Vite voor snelle UI-iteratie
  - production bundle in dist/webview voor packaged runs
  - fallback-scherm bij offline devserver

## Projectstructuur

- src/extension.ts: extension-host logica, @pixel participant, runtime events en webview loading modes
- webview-ui/src/*: Vite webview frontend met HMR
- dist/: gecompileerde extension output
- dist/webview/: productie webview assets

## Snel starten

1. Open deze map als eigen root-workspace in VS Code.
2. Installeer dependencies:

```bash
npm install
```

3. Start debugconfig Run Pixel Agent Extension.
	Deze start automatisch parallel:
	- npm: watch
	- npm: dev:webview

4. Test in de Extension Development Host:
	- Command Palette: Pixel Agent: Open Panel
	- Copilot Chat: @pixel /show

## Scripts

- npm run build: bouwt extension en webview-assets
- npm run build:extension: compileert extension host
- npm run build:webview: buildt webview-ui naar dist/webview
- npm run watch: TypeScript watch voor extension host
- npm run dev:webview: start Vite devserver op 127.0.0.1:5173

## Fallback gedrag

Als devserver niet bereikbaar is in development mode:

- panel toont fallback met foutreden
- Retry Dev Server probeert opnieuw
- Load Production Bundle laadt dist/webview assets als beschikbaar
- Load Embedded Panel laadt de ingebouwde monitor-UI

## Realtime events

- @pixel chat lifecycle: ontvangen, verwerken, streaming, klaar/fout
- workspace events: file change/save/create/delete/rename en actieve editor
- diagnostics updates: errors en warnings
- VS Code tasks: gestart/afgerond inclusief exit status

## Copilot dekking

- In scope: events van de eigen @pixel participant via publieke API
- Best effort: publieke workspace/task/diagnostics signalen
- Niet beschikbaar: interne built-in Copilot agent-events zonder publieke extensie-API
