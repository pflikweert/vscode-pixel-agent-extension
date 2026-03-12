# Pixel Copilot Agent

Dit project is een standalone VS Code-extensie met:

- een `@pixel` chat participant voor Copilot Chat
- een `Pixel Agent` webview paneel met live event-updates
- basis TypeScript build setup

## Snel starten

1. Open de map `vscode-pixel-agent-extension` in VS Code.
2. Installeer dependencies:

```bash
npm install
```

3. Build de extensie:

```bash
npm run build
```

4. Start debug (`Run Pixel Agent Extension`) en open in de Extension Development Host:

- Command Palette: `Pixel Agent: Open Panel`
- Copilot Chat: `@pixel /show`

## Realtime events die nu gekoppeld zijn

- `@pixel` chat lifecycle events: ontvangen, verwerken, streamen, klaar/fout
- workspace events: wijziging, save, create, delete, rename, actieve editor
- diagnostics events: error/warning updates
- task events: start/einde van VS Code taken

Deze events worden vanuit de extensie via `postMessage` doorgestuurd naar het panel.

## Copilot dekking

- In scope: events van de eigen `@pixel` participant (dit loopt via de publieke Chat API).
- Best effort: signalen die via publieke VS Code API's zichtbaar zijn (workspace, diagnostics, tasks).
- Niet direct mogelijk: interne built-in Copilot agent-events zonder publieke extensie-API.
