import { defineConfig } from '@neon/config/v1';

export default defineConfig({
  auth: false,
  dataApi: {
    authProvider: 'external',
    jwksUrl: 'https://edicius-hq-web.vercel.app/api/auth/jwks',
    providerName: 'Edicius Better Auth',
    jwtAudience: 'https://edicius-hq-web.vercel.app',
    settings: {
      dbSchemas: ['public'],
      dbMaxRows: 1000,
      serverCorsAllowedOrigins: 'https://edicius-hq-web.vercel.app',
    },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: '7d' };
    }
    // Existing branch: no changes
    return {};
  },
});
