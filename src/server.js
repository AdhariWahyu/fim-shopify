const { config, validateRuntimeConfig } = require("./config");
const { createLogger } = require("./utils/logger");
const { createApp } = require("./app");

const logger = createLogger(config.logLevel);

try {
  validateRuntimeConfig();
} catch (error) {
  logger.error("Runtime configuration validation failed", {
    error: error.message
  });
  process.exit(1);
}

const app = createApp({ config, logger });

app.listen(config.port, () => {
  logger.info("Carrier service server started", {
    port: config.port,
    env: config.env
  });
});
