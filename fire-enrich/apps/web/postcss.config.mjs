/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    "postcss-import": {
      // Resolve @/ alias to make imports work during build
      resolve(id) {
        return id.startsWith("@/") ? id.replace("@/", "./") : id;
      },
    },
    "tailwindcss/nesting": {},
    tailwindcss: {},
    autoprefixer: {},
    "postcss-nesting": {},
  },
};

export default config;
