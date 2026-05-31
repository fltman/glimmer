/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Dark pro-editor palette.
        panel: "#1a1b1e",
        panelraised: "#222327",
        edge: "#2c2e33",
        ink: "#e6e7ea",
        muted: "#9a9da4",
        accent: "#5b8cff",
        accenthover: "#6f9bff",
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
