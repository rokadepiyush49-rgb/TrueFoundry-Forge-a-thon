export interface FreeProvider {
  id: string;
  label: string;
  manifest: (key: string) => Record<string, unknown> & { type: string; name?: string };
  test: string;
}
export const FREE_PROVIDERS: FreeProvider[];
export function providerManifest<T extends { type: string; name?: string; enabled?: boolean }>(p: T): Omit<T, "enabled">;
export function providerId(manifest: { type: string; name?: string }): string;
