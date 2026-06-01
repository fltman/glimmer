/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Dark pro-editor palette — cool, faintly violet-tinted surfaces for a
        // premium feel; an indigo accent that pairs with the fuchsia brand gradient.
        bg: "#0c0d11",
        panel: "#16171c",
        panelraised: "#1f2027",
        edge: "#2c2e37",
        ink: "#e8e9ef",
        muted: "#969aa7",
        accent: "#6d7dff",
        accenthover: "#828ffd",
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
