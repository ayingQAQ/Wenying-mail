import { authState } from './session.js';

const CHANGE_KEY = 'cloudmail-auth-change';

export function clearLegacyCredentials() {
  localStorage.removeItem('token');
  // Retire old persisted message bodies and recipient suggestions; keep user preferences.
  localStorage.removeItem('email');
  localStorage.removeItem('writer');
}

export function reloadSession(path, notifyOtherTabs = true) {
  authState.clear();
  clearLegacyCredentials();
  if (notifyOtherTabs) localStorage.setItem(CHANGE_KEY, crypto.randomUUID());
  // A full navigation discards private Pinia state, routes and in-flight UI callbacks.
  window.location.replace(path);
}

export function watchSessionChanges() {
  window.addEventListener('storage', event => {
    if (event.key === CHANGE_KEY) reloadSession('/inbox', false);
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) reloadSession(window.location.pathname, false);
  });
}
