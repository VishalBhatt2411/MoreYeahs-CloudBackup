import { defineConfig } from 'vitest/config';

// Tests run against their own database (cloudbackup_test) and a fake Salesforce server.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://cloudbackup:cloudbackup@localhost:54329/cloudbackup_test',
      APP_URL: 'http://localhost:5173',
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test-jwt-secret',
      TOKEN_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      STORAGE_DIR: './.test-storage',
      BCRYPT_COST: '4',
      BULK_THRESHOLD_ROWS: '1000',
      SF_LOGIN_URL_PRODUCTION: 'http://localhost:54399',
      SF_LOGIN_URL_SANDBOX: 'http://localhost:54399',
    },
  },
});
