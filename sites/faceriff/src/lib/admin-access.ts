// Server-only allowlist. Do not publish its values to client configuration.
export function isAllowlistedEmail(email: string, allowlist: string | undefined): boolean {
  const normalized = email.trim().toLowerCase();
  return (
    !!normalized && (allowlist ?? '').split(',').some((entry) => entry.trim().toLowerCase() === normalized)
  );
}
