import { HttpError } from '../lib/http.js';

/** Small helpers that call the Salesforce REST API directly (used for health checks and org info). */

export async function latestApiVersion(instanceUrl: string): Promise<string> {
  const res = await fetch(`${instanceUrl}/services/data/`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new HttpError(502, 'Could not read the Salesforce API versions.');
  const list = (await res.json()) as Array<{ version: string }>;
  const versions = list.map((v) => v.version).sort((a, b) => Number(a) - Number(b));
  const latest = versions.at(-1);
  if (!latest) throw new HttpError(502, 'Salesforce did not list any API versions.');
  return latest;
}

export async function fetchOrgName(instanceUrl: string, accessToken: string): Promise<string | null> {
  try {
    const v = await latestApiVersion(instanceUrl);
    const url = `${instanceUrl}/services/data/v${v}/query?q=${encodeURIComponent('SELECT Name FROM Organization LIMIT 1')}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { records?: Array<{ Name?: string }> };
    return json.records?.[0]?.Name ?? null;
  } catch {
    return null;
  }
}
