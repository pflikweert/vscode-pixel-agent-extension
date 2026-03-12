/// <reference types="vite/client" />

declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
  setState: (state: unknown) => void;
  getState: <T = unknown>() => T | undefined;
};
