const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getPagination(query = {}) {
  const requestedLimit = toPositiveInt(query.limit, DEFAULT_LIMIT);
  const offset = toPositiveInt(query.offset ?? query.skip, 0);

  return {
    limit: Math.min(requestedLimit || DEFAULT_LIMIT, MAX_LIMIT),
    offset,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  getPagination,
};
