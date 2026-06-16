/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Sentry DSN for error monitoring. When unset, Sentry is a no-op. */
  readonly PUBLIC_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
