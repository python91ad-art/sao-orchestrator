/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        neutral: { 950: '#080d18', 900: '#101a29', 800: '#23334b', 700: '#35465e', 600: '#8295af', 500: '#96a9c1', 400: '#a6b5c8', 300: '#c2cfdf', 200: '#dae5f2' },
        purple: { 400: '#b6a7ff', 500: '#806bff', 600: '#6853e8' },
        border: 'var(--border)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
        },
        card: {
          DEFAULT: 'var(--card)',
        },
        sidebar: {
          DEFAULT: 'var(--sidebar)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        success: {
          DEFAULT: 'var(--success)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
        },
      }
    },
  },
  plugins: [],
}
