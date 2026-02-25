function toNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return fallback;
  }

  return numeric;
}

function fromShopifySubunits(value) {
  return toNumber(value, 0) / 100;
}

function toShopifySubunits(valueMajor) {
  return Math.max(0, Math.round(toNumber(valueMajor, 0) * 100));
}

module.exports = {
  toNumber,
  fromShopifySubunits,
  toShopifySubunits
};
