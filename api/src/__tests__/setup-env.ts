/**
 * Test environment — mirrors the required variables from .env.example.
 *
 * config.ts refuses to start without these, by design.  Loading them here
 * rather than defaulting them in the source is what keeps the production build
 * free of installation-specific values.
 */
process.env.API_KEY ||= "test-api-key";
process.env.ADMIN_PIN ||= "1234";
process.env.VIEWER_PIN ||= "5678";
process.env.OSC_ACCESS_TOKEN ||= "test-pat";
process.env.OSC_TENANT ||= "testtenant";
process.env.MINIO_ENDPOINT ||= "https://minio.example.com";
process.env.MINIO_ACCESS_KEY ||= "test-access";
process.env.MINIO_SECRET_KEY ||= "test-secret";
process.env.PROCESS_PREFIX ||= "cs-";
process.env.CLUB_NAME ||= "Test Courtside";
process.env.CLUB_SHORT_NAME ||= "Test IF";
process.env.CLUB_VENUE ||= "Testhallen";
process.env.PUBLIC_SITE_URL ||= "https://live.example.com";
