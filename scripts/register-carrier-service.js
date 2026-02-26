const { config } = require("../src/config");
const { createLogger } = require("../src/utils/logger");
const { registerCarrierService } = require("../src/services/carrier-registration");

const logger = createLogger(config.logLevel || "info");

async function main() {
  const result = await registerCarrierService({ config, logger });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  const responseData = error.response?.data || error.details || null;
  const responseText =
    typeof responseData === "string"
      ? responseData
      : JSON.stringify(responseData || {});

  let hint = null;
  if (responseText.includes("app_not_installed")) {
    hint =
      "Shopify app is not installed on this shop. Install app to target store, then retry.";
  } else if (responseText.includes("shop_not_permitted")) {
    hint =
      "Client credentials not permitted for this shop. Ensure app and store are in same organization and app is installed.";
  }

  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error.message,
        details: responseData,
        hint
      },
      null,
      2
    )
  );
  process.exit(1);
});
