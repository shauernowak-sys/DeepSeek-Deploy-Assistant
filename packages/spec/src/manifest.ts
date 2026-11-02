import { z } from 'zod';

export const RuntimeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.enum(['node', 'pnpm', 'dsh']),
  version: z.string().min(1),
  arch: z.enum(['x64', 'arm64']),
  source: z.object({
    url: z.string().url(),
    mirrors: z.array(z.string().url()).default([]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive(),
  }),
  install: z.object({
    strategy: z.enum(['portable-unzip', 'package-manager']),
    targetSubdir: z.string().min(1),
  }),
  detect: z.object({
    minVersion: z.string().default('0.0.0'),
    acceptExisting: z.boolean().default(true),
  }),
  license: z.object({ spdx: z.string(), textFile: z.string().optional() }),
});

export type RuntimeManifest = z.infer<typeof RuntimeManifestSchema>;

/**
 * Compatibility whitelist. A combination only exists here after local reproduction;
 * upstream "compatible" claims are recorded in `evidence` but never sufficient on their own.
 */
export const CompatEntrySchema = z.object({
  id: z.string().min(1),
  dsh: z.string().min(1),
  qqbot: z.string().min(1),
  node: z.string().min(1),
  status: z.enum(['verified-local', 'verified-by-upstream', 'unverified', 'blocked']),
  evidence: z.array(z.string()).min(1),
  note: z.string().optional(),
});

export const CompatMatrixSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(CompatEntrySchema).min(1),
});

export type CompatEntry = z.infer<typeof CompatEntrySchema>;
export type CompatMatrix = z.infer<typeof CompatMatrixSchema>;
