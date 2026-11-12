/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./index.tsx", "./App.tsx", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        '4xl': '2rem',
        '5xl': '3rem',
      },
    },
  },
  plugins: [],
};
