import { state } from '../state.js';

export function currentProjectHash() {
  return state.appState.project?.hash || state.wsProjectHash || '';
}
