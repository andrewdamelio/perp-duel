// Extends app.json. EXPO_BASE_URL lets the web build live under a sub-path,
// e.g. /perp-duel on GitHub Pages.
module.exports = ({ config }) => ({
  ...config,
  experiments: { ...config.experiments, baseUrl: process.env.EXPO_BASE_URL || '' },
});
