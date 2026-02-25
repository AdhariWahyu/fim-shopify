const axios = require("axios");
const { config } = require("../src/config");

function assertRequired(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

async function runGraphQL(shopifyHttp, name, callbackUrl) {
  const queryServices = `
    query CarrierServices {
      carrierServices(first: 100) {
        nodes {
          id
          name
          active
          callbackUrl
          supportsServiceDiscovery
        }
      }
    }
  `;

  const listResponse = await shopifyHttp.post("graphql.json", {
    query: queryServices,
    variables: {}
  });

  if (listResponse.data.errors) {
    throw new Error(`GraphQL list error: ${JSON.stringify(listResponse.data.errors)}`);
  }

  const existing = listResponse.data.data?.carrierServices?.nodes?.find(
    (entry) => entry.name === name
  );

  if (existing) {
    const mutation = `
      mutation UpdateCarrierService($id: ID!, $input: DeliveryCarrierServiceUpdateInput!) {
        carrierServiceUpdate(id: $id, input: $input) {
          carrierService {
            id
            name
            active
            callbackUrl
            supportsServiceDiscovery
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateResponse = await shopifyHttp.post("graphql.json", {
      query: mutation,
      variables: {
        id: existing.id,
        input: {
          name,
          callbackUrl,
          active: true,
          supportsServiceDiscovery: true
        }
      }
    });

    if (updateResponse.data.errors) {
      throw new Error(
        `GraphQL update error: ${JSON.stringify(updateResponse.data.errors)}`
      );
    }

    const userErrors = updateResponse.data.data?.carrierServiceUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`GraphQL userErrors: ${JSON.stringify(userErrors)}`);
    }

    return {
      mode: "updated",
      carrierService: updateResponse.data.data?.carrierServiceUpdate?.carrierService
    };
  }

  const mutation = `
    mutation CreateCarrierService($input: DeliveryCarrierServiceCreateInput!) {
      carrierServiceCreate(input: $input) {
        carrierService {
          id
          name
          active
          callbackUrl
          supportsServiceDiscovery
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const createResponse = await shopifyHttp.post("graphql.json", {
    query: mutation,
    variables: {
      input: {
        name,
        callbackUrl,
        active: true,
        supportsServiceDiscovery: true
      }
    }
  });

  if (createResponse.data.errors) {
    throw new Error(`GraphQL create error: ${JSON.stringify(createResponse.data.errors)}`);
  }

  const userErrors = createResponse.data.data?.carrierServiceCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`GraphQL userErrors: ${JSON.stringify(userErrors)}`);
  }

  return {
    mode: "created",
    carrierService: createResponse.data.data?.carrierServiceCreate?.carrierService
  };
}

async function runRestFallback(shopifyHttp, name, callbackUrl) {
  const list = await shopifyHttp.get("carrier_services.json");
  const services = list.data?.carrier_services || [];
  const existing = services.find((entry) => entry.name === name);

  if (existing) {
    const response = await shopifyHttp.put(`carrier_services/${existing.id}.json`, {
      carrier_service: {
        id: existing.id,
        name,
        callback_url: callbackUrl,
        service_discovery: true
      }
    });

    return {
      mode: "updated_rest",
      carrierService: response.data?.carrier_service || null
    };
  }

  const response = await shopifyHttp.post("carrier_services.json", {
    carrier_service: {
      name,
      callback_url: callbackUrl,
      service_discovery: true
    }
  });

  return {
    mode: "created_rest",
    carrierService: response.data?.carrier_service || null
  };
}

async function fetchClientCredentialsToken(shopDomain, clientId, clientSecret) {
  const url = `https://${shopDomain}/admin/oauth/access_token`;
  const response = await axios.post(
    url,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    }).toString(),
    {
      timeout: 15000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  const data = response.data || {};
  if (!data.access_token) {
    throw new Error("Client credentials response missing access_token");
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || null
  };
}

async function resolveShopifyAccessToken() {
  if (config.shopify.clientId && config.shopify.clientSecret) {
    const token = await fetchClientCredentialsToken(
      config.shopify.shopDomain,
      config.shopify.clientId,
      config.shopify.clientSecret
    );

    return {
      source: "client_credentials",
      accessToken: token.accessToken,
      expiresIn: token.expiresIn
    };
  }

  assertRequired("SHOPIFY_ADMIN_ACCESS_TOKEN", config.shopify.adminAccessToken);
  return {
    source: "static_admin_access_token",
    accessToken: config.shopify.adminAccessToken,
    expiresIn: null
  };
}

async function main() {
  assertRequired("SHOPIFY_SHOP_DOMAIN", config.shopify.shopDomain);
  assertRequired("PUBLIC_CALLBACK_URL", config.shopify.callbackUrl);

  const tokenInfo = await resolveShopifyAccessToken();

  const shopifyHttp = axios.create({
    baseURL: `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/`,
    timeout: 15000,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": tokenInfo.accessToken
    }
  });

  const name = config.shopify.carrierServiceName;
  const callbackUrl = config.shopify.callbackUrl;

  try {
    const result = await runGraphQL(shopifyHttp, name, callbackUrl);
    console.log(
      JSON.stringify(
        {
          ok: true,
          token_source: tokenInfo.source,
          token_expires_in_seconds: tokenInfo.expiresIn,
          strategy: "graphql",
          ...result
        },
        null,
        2
      )
    );
    return;
  } catch (graphQLError) {
    console.warn(
      JSON.stringify(
        {
          ok: false,
          strategy: "graphql",
          warning: graphQLError.message,
          action: "falling_back_to_rest"
        },
        null,
        2
      )
    );
  }

  const result = await runRestFallback(shopifyHttp, name, callbackUrl);
  console.log(
    JSON.stringify(
      {
        ok: true,
        token_source: tokenInfo.source,
        token_expires_in_seconds: tokenInfo.expiresIn,
        strategy: "rest",
        ...result
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const responseData = error.response?.data || null;
  const responseText =
    typeof responseData === "string"
      ? responseData
      : JSON.stringify(responseData || {});

  let hint = null;
  if (responseText.includes("app_not_installed")) {
    hint =
      "Shopify app is not installed on this shop. Open Dev Dashboard app Home and install it to the target store, then retry.";
  } else if (responseText.includes("shop_not_permitted")) {
    hint =
      "Client credentials not permitted for this shop. App and shop might be in different organizations; use auth code/token exchange instead.";
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
