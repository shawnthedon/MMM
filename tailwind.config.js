/** RELAY semantic utilities: component colours inherit from the active theme. */
export default {
  content: ['./index.html', './src/**/*.{js,html}'],
  theme: {
    extend: {
      colors: {
        base: 'var(--bg-base)', surface: 'var(--bg-surface)', elevated: 'var(--bg-elevated)',
        primary: 'var(--text-primary)', muted: 'var(--text-muted)',
        accent: 'var(--accent-primary)', action: 'var(--accent-hover)', pressed: 'var(--accent-pressed)',
        'on-accent': 'var(--text-on-accent)', outline: 'var(--border-default)',
        subtle: 'var(--border-subtle)', success: 'var(--state-success)',
        warning: 'var(--state-warning)', error: 'var(--state-error)', destructive: 'var(--state-error-strong)',
      },
      fontFamily: { sans: 'var(--font-sans)', mono: 'var(--font-mono)' },
    },
  },
  plugins: [],
};
