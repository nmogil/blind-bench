/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sentry DSN for error monitoring. When unset, Sentry is a no-op. */
  readonly VITE_SENTRY_DSN?: string;
}
