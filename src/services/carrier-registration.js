const axios = require("axios");

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

async function fetchClientCredentialsToken(shopDomain, clientId, clientSecret, timeoutMs) {
  const url = `https://${shopDomain}/admin/oauth/access_token`;
  const response = await axios.post(
    url,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    }).toString(),
    {
      timeout: timeoutMs,
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

async function resolveShopifyAccessToken(config) {
  if (config.shopify.clientId && config.shopify.clientSecret) {
    const token = await fetchClientCredentialsToken(
      config.shopify.shopDomain,
      config.shopify.clientId,
      config.shopify.clientSecret,
      config.shopify.timeoutMs
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

async function registerCarrierService({ config, logger }) {
  assertRequired("SHOPIFY_SHOP_DOMAIN", config.shopify.shopDomain);
  assertRequired("PUBLIC_CALLBACK_URL", config.shopify.callbackUrl);

  const tokenInfo = await resolveShopifyAccessToken(config);

  const shopifyHttp = axios.create({
    baseURL: `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/`,
    timeout: config.shopify.timeoutMs,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": tokenInfo.accessToken
    }
  });

  const name = config.shopify.carrierServiceName;
  const callbackUrl = config.shopify.callbackUrl;

  try {
    const result = await runGraphQL(shopifyHttp, name, callbackUrl);
    return {
      ok: true,
      strategy: "graphql",
      token_source: tokenInfo.source,
      token_expires_in_seconds: tokenInfo.expiresIn,
      ...result
    };
  } catch (graphQLError) {
    if (logger) {
      logger.warn("Carrier registration via GraphQL failed, fallback to REST", {
        warning: graphQLError.message
      });
    }
  }

  const result = await runRestFallback(shopifyHttp, name, callbackUrl);
  return {
    ok: true,
    strategy: "rest",
    token_source: tokenInfo.source,
    token_expires_in_seconds: tokenInfo.expiresIn,
    ...result
  };
}

module.exports = {
  registerCarrierService
};
