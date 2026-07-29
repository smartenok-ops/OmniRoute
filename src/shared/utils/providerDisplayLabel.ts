/**
 * Get a friendly display label for compatible providers.
 * Converts long IDs like "openai-compatible-chat-02669115-2545-4896-b003-cb4dac09d441"
 * to readable labels. If providerNodes are available, uses user-defined name;
 * otherwise falls back to "OAI-COMPAT" / "ANT-COMPAT".
 *
 * @param provider - The raw provider ID string from a request log or active request.
 * @param providerNodes - Optional array of provider node objects (from /api/provider-nodes).
 * @returns A human-readable label for compatible providers, or `null` if the provider
 *          is not an openai-compatible-* or anthropic-compatible-* provider (caller
 *          should use its own default in that case).
 */
const COMPATIBLE_PROVIDER_TYPES = [
  { prefix: "openai-compatible-", label: "OAI" },
  { prefix: "anthropic-compatible-", label: "ANT" },
] as const;

type CompatibleProviderType = (typeof COMPATIBLE_PROVIDER_TYPES)[number];

function getCompatibleProviderType(provider: string): CompatibleProviderType | undefined {
  return COMPATIBLE_PROVIDER_TYPES.find((type) => provider.startsWith(type.prefix));
}

function getCompatibleProviderFallback(
  provider: string,
  compatibleType: CompatibleProviderType
): string {
  const suffix = provider.slice(compatibleType.prefix.length);
  const parts = suffix.split("-");
  if (parts.length > 1 && parts[1]?.length >= 8) return `${compatibleType.label}-COMPAT`;
  return `${compatibleType.label}: ${suffix.slice(0, 16).toUpperCase()}`;
}

export function getProviderDisplayLabel(
  provider: string,
  providerNodes?: Array<{ id?: string; prefix?: string; name?: string }>
): string | null {
  if (!provider) return "-";

  const compatibleType = getCompatibleProviderType(provider);
  if (!compatibleType) return null;

  const matchedNode = providerNodes?.find(
    (node) => node.id === provider || node.prefix === provider
  );
  return matchedNode?.name || getCompatibleProviderFallback(provider, compatibleType);
}
