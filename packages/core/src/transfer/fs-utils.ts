import { access } from 'node:fs/promises';

export async function fileExists(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}