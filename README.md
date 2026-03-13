# Pixel Copilot Agent

Standalone VS Code extensie in een eigen repository met:

- een @pixel chat participant voor Copilot Chat
- een Pixel Agent panel met runtime events (chat, workspace, diagnostics, taken en terminal commands)
- een hybride webview-flow:
  - devserver via Vite voor snelle UI-iteratie
  - production bundle in dist/webview voor packaged runs
  - fallback-scherm bij offline devserver

## Wat Je Nu Krijgt

- live panel met Scout, Builder en Reviewer status
- eventlog met realtime updates uit extension host
- terminal command telemetry (start/einde + exit status)
- robuuste webview-start met zichtbare fallback in plaats van zwart scherm
- automatische embedded panel load bij panel-start als dev connectie beschikbaar is

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
	- Command Palette: Pixel Agent: Emit Test Events
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

Als devserver wel bereikbaar is bij panel-start:

- panel laadt automatisch de ingebouwde embedded monitor-UI

## Realtime events

- @pixel chat lifecycle: ontvangen, verwerken, streaming, klaar/fout
- workspace events: file change/save/create/delete/rename en actieve editor
- diagnostics updates: errors en warnings
- VS Code tasks: gestart/afgerond inclusief exit status
- terminal events: terminal open/close en shell command start/einde met exit code
- git events: branch, ahead/behind, staged/unstaged/conflicts en clean/changed/conflict transitions

## Git monitoring

- gebruikt de publieke VS Code Git API (`vscode.git`) wanneer beschikbaar
- kiest automatisch de repository van de actieve editor (of anders de eerste repo)
- stuurt debounced git-state events om event-spam te vermijden
- toont branch + change counts + statusboodschap in embedded en Vite webview UI

## Agentgedrag in de scene

- de scene heeft 2 zones: lounge (idle) en werkvloer (actief)
- agents verplaatsen automatisch naar de werkvloer bij `working`, `completed` of `error`
- na 60 seconden zonder nieuwe events gaat een agent terug naar idle in de lounge
- typing bursts op file-wijzigingen sturen extra ritmische progress-events per agent
- bestandsnamen sturen agent-keuze mee:
	- docs/readme/notities -> Scout
	- test/spec/lint/qa/diagnostic/ci -> Reviewer
	- overig -> Builder

## Copilot dekking

- In scope: events van de eigen @pixel participant via publieke API
- Best effort: publieke workspace/task/diagnostics signalen
- Niet beschikbaar: interne built-in Copilot agent-events zonder publieke extensie-API

## Ontwikkelflow

1. Start de extension host via debug (Run Pixel Agent Extension).
2. Open panel met Pixel Agent: Open Panel of @pixel /show.
3. Voer acties uit via Copilot, tasks of terminal en bekijk live events in het panel.
4. Gebruik fallback acties als je devserver tijdelijk niet bereikbaar is.
