import {
  getIpAddressVersion,
  getPublicEgressIpBlockReason,
  normalizeIpAddressLiteral,
} from "./public-egress-ip.js";

const ALLOWED_PUBLIC_BLOCK_REASONS = new Set([
  "private IPv4 address",
  "loopback IPv4 address",
  "loopback IPv6 address",
  "carrier-grade NAT IPv4 address",
  "unique-local IPv6 address",
]);

const CLOUD_METADATA_HOSTNAMES = new Set(["metadata.google.internal"]);
const AWS_IMDS_V6 = "fd00:ec2::254";
const AWS_IMDS_V4 = "169.254.169.254";

export function sandboxEgressBlockedIpReason(address: string): string | undefined {
  const normalized = normalizeIpAddressLiteral(address);
  if (normalized === AWS_IMDS_V4 || normalized === AWS_IMDS_V6) {
    return "cloud metadata address";
  }

  const blocked = getPublicEgressIpBlockReason(normalized);
  if (!blocked || blocked.reason === "not an IP address") return undefined;
  if (ALLOWED_PUBLIC_BLOCK_REASONS.has(blocked.reason)) return undefined;
  return blocked.reason;
}

export function sandboxEgressBlockedHostnameReason(hostname: string): string | undefined {
  const normalized = normalizeIpAddressLiteral(hostname);
  if (normalized.length === 0) return "URL must include a hostname";
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return undefined;
  }
  if (CLOUD_METADATA_HOSTNAMES.has(normalized)) return "cloud metadata hostname";

  const ipVersion = getIpAddressVersion(normalized);
  if (ipVersion === 0) return undefined;
  return sandboxEgressBlockedIpReason(normalized);
}
