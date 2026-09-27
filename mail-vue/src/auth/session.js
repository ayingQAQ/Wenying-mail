// Session credentials live only in a Secure HttpOnly cookie. CSRF state is memory-only.
export function createAuthState() {
  return {
    authenticated: false,
    csrfToken: null,
    generation: 0,
    accept(session) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(session?.csrfToken) || !session?.user?.userId) {
        throw new Error('INVALID_SESSION_RESPONSE');
      }
      this.generation++;
      this.csrfToken = session.csrfToken;
      this.authenticated = true;
    },
    clear() {
      this.generation++;
      this.csrfToken = null;
      this.authenticated = false;
    },
  };
}

export const authState = createAuthState();

export function installSessionTransport(http, state, { origin, onExpired }) {
  http.interceptors.request.use(config => {
    const destination = new URL(http.getUri(config), origin);
    if (destination.origin !== origin || !destination.pathname.startsWith('/api/')) {
      throw new Error('INVALID_API_DESTINATION');
    }
    config.headers.delete('Authorization');
    config.headers.delete('X-CSRF-Token');
    config.sessionGeneration = state.generation;
    config.isSessionLogin = ['/api/login','/api/login/email/start'].includes(destination.pathname);
    if (!['get', 'head', 'options'].includes(config.method.toLowerCase()) && !config.isSessionLogin) {
      if (!state.csrfToken) throw new Error('SESSION_REQUIRED');
      config.headers.set('X-CSRF-Token', state.csrfToken);
    }
    return config;
  });
  function checkGeneration(config) {
    if (config && config.sessionGeneration !== state.generation) throw new Error('STALE_SESSION_RESPONSE');
  }
  http.interceptors.response.use(response => {
    checkGeneration(response.config);
    return response;
  }, error => {
    checkGeneration(error.config);
    if (error.response?.status === 401 && !error.config?.sessionBootstrap && !error.config?.isSessionLogin && state.authenticated) {
      state.clear();
      onExpired();
    }
    return Promise.reject(error);
  });
}
