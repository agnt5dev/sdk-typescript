const DEFAULT_GATEWAY_URL = 'https://gw.agnt5.com';

export function resolveGatewayUrl(override?: string): string {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  return (override || env?.AGNT5_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/$/, '');
}
