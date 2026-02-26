const { config, validateRuntimeConfig } = require("./config");
const { createLogger } = require("./utils/logger");
const { createApp } = require("./app");
const { registerCarrierService } = require("./services/carrier-registration");

const logger = createLogger(config.logLevel);

async function bootstrap() {
  try {
    validateRuntimeConfig();
  } catch (error) {
    logger.error("Runtime configuration validation failed", {
      error: error.message
    });
    process.exit(1);
  }

  if (config.startup.autoRegisterCarrierService) {
    try {
      const result = await registerCarrierService({ config, logger });
      logger.info("Carrier service auto-registration completed", result);
    } catch (error) {
      logger.error("Carrier service auto-registration failed", {
        error: error.message,
        details: error.details || error.response?.data || null
      });

      if (config.startup.failOnCarrierRegisterError) {
        process.exit(1);
      }
    }
  }

  const app = createApp({ config, logger });

  app.listen(config.port, () => {
    logger.info("Carrier service server started", {
      port: config.port,
      env: config.env
    });
  });
}

bootstrap();
