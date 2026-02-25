class MemoryCache {
  constructor(options = {}) {
    this.ttlSeconds = Number.isInteger(options.ttlSeconds)
      ? options.ttlSeconds
      : 300;
    this.maxEntries = Number.isInteger(options.maxEntries)
      ? options.maxEntries
      : 1000;
    this.map = new Map();
  }

  _isExpired(entry) {
    return entry.expiresAt <= Date.now();
  }

  _evictIfNeeded() {
    while (this.map.size > this.maxEntries) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }

  _touch(key, entry) {
    this.map.delete(key);
    this.map.set(key, entry);
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      return null;
    }

    if (this._isExpired(entry)) {
      this.map.delete(key);
      return null;
    }

    this._touch(key, entry);
    return entry.value;
  }

  set(key, value, ttlSeconds) {
    const ttl = Number.isInteger(ttlSeconds) ? ttlSeconds : this.ttlSeconds;
    const expiresAt = Date.now() + ttl * 1000;
    this.map.set(key, { value, expiresAt });
    this._evictIfNeeded();
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  size() {
    return this.map.size;
  }
}

module.exports = {
  MemoryCache
};
