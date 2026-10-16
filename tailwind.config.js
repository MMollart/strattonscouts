/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Official Scouts UK brand palette
        scout: {
          purple: '#7413dc',
          'purple-dark': '#4d108a',
          teal: '#00a794',
          blue: '#006ddf',
          navy: '#003982',
          green: '#23a950',
          red: '#e22e12',
          pink: '#ffb4e5',
          yellow: '#ffe627',
          orange: '#ff912a',
          forest: '#205b41',
          'off-white': '#f4f4f4',
          ink: '#1b1b1b',
        },
      },
      fontFamily: {
        sans: ['Nunito Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Nunito Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
