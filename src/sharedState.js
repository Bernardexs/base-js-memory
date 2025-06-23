// src/sharedState.js

let globalStateHandler = null;

export function setGlobalStateHandler(handler) {
  globalStateHandler = handler;
}

export function getGlobalStateHandler() {
  return globalStateHandler;
}
