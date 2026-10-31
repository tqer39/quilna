// Only bounded standard validators are forwarded, and only to their exact URL.
export function validETag(value) {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(value)
  );
}
export function validModified(value) {
  return (
    typeof value === "string" &&
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    ) &&
    new Date(value).toUTCString() === value
  );
}
export function validSourceValidators(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.url !== "string" ||
    value.url.length > 2048 ||
    Object.keys(value).some(
      (k) => !["url", "etag", "lastModified"].includes(k),
    ) ||
    (value.etag !== undefined && !validETag(value.etag)) ||
    (value.lastModified !== undefined && !validModified(value.lastModified))
  )
    return false;
  try {
    const url = new globalThis.URL(value.url);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      url.href === value.url &&
      !!(value.etag || value.lastModified)
    );
  } catch {
    return false;
  }
}
export function conditionalHeaders(url, validators) {
  if (!validSourceValidators(validators) || validators.url !== url) return {};
  // If-None-Match takes precedence over If-Modified-Since (RFC 9110 §13.2.2).
  return validators.etag
    ? { "If-None-Match": validators.etag }
    : { "If-Modified-Since": validators.lastModified };
}
export function responseValidators(url, etag, lastModified) {
  const result = {
    url,
    ...(validETag(etag) ? { etag } : {}),
    ...(validModified(lastModified) ? { lastModified } : {}),
  };
  return validSourceValidators(result) ? result : undefined;
}
