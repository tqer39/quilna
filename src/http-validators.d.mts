export type SourceValidators = {
  url: string;
  etag?: string;
  lastModified?: string;
};
export function validETag(value: unknown): value is string;
export function validModified(value: unknown): value is string;
export function validSourceValidators(
  value: unknown,
): value is SourceValidators;
export function conditionalHeaders(
  url: string,
  validators?: SourceValidators,
): Record<string, string>;
export function responseValidators(
  url: string,
  etag: unknown,
  lastModified: unknown,
): SourceValidators | undefined;
