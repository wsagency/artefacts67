// R2 object layout (ADR 0013): one ciphertext object per artifact version.
// Wrapped key bundles never go to R2 — they are small D1 rows next to the
// artifact metadata (ADR 0014).

export function artifactObject(artifactId: string, version: number): string {
  return `art/${artifactId}/${version}.enc`;
}

export function parseArtifactObject(key: string): { artifactId: string; version: number } | null {
  const match = /^art\/([\w-]+)\/(\d+)\.enc$/.exec(key);
  return match ? { artifactId: match[1], version: Number(match[2]) } : null;
}
