export type ToolAvailabilityLanguage = "en";

export type ToolAvailabilityCopy = {
  badge: string;
  detail: string;
  href?: string;
};

export function toolEffectiveEnabled(
  savedEnabled: boolean,
  available: boolean,
  comingSoon: boolean,
): boolean {
  return savedEnabled && available && !comingSoon;
}

export function toolAvailabilityCopy(
  reason: string | null | undefined,
  _language: ToolAvailabilityLanguage,
): ToolAvailabilityCopy {
  if (
    reason === "search_provider_not_configured" ||
    reason === "search_credentials_missing"
  ) {
    // Search is built in; there is no provider to configure in Settings.
    return {
      badge: "Unavailable",
      detail: "Web search is not available in this build.",
    };
  }
  return {
    badge: "Unavailable",
    detail: "This tool's runtime service is unavailable.",
  };
}
