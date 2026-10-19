/** Active discovery policy only; historical datasets and evidence remain accessible. */
export const DATASET_EXCLUSIONS: Readonly<Record<string, { code: 'dataset_outdated'; message: string }>> = {
  'house-prices-local-authority': { code: 'dataset_outdated', message: 'Latest identified release is September 2022; excluded from current discovery.' },
};
export type DatasetReason = 'dataset_outdated' | 'dataset_unpublished' | 'unsupported_geography' | 'missing_dimension_options' | 'invalid_observation' | 'insufficient_recent_observations' | 'incompatible_observations' | 'inference_provider_unavailable' | 'inference_failed' | 'metadata_api_failed' | 'dimension_api_failed' | 'observation_api_failed';
export interface DatasetDiagnostic { datasetId: string; status: 'skipped' | 'failed'; code: DatasetReason; message: string }
export class DatasetSkipped extends Error {
  constructor(public code: DatasetReason, message: string) { super(message); }
}
export function assertDatasetEligible(id: string, release: unknown, now: number, maxAgeDays = 550) {
  const excluded = DATASET_EXCLUSIONS[id];
  if (excluded) throw new DatasetSkipped(excluded.code, excluded.message);
  if (typeof release === 'string' && Number.isFinite(Date.parse(release)) && now - Date.parse(release) > Math.min(550, maxAgeDays) * 86400000) throw new DatasetSkipped('dataset_outdated', 'Published release exceeds the discovery evidence age limit.');
}
export function supportedOnsGeography(code: unknown): code is string {
  return typeof code === 'string' && (['K02000001', 'K03000001', 'E92000001'].includes(code) || /^(E0[6-9]|W06|S12|N09)\d{6}$/.test(code));
}
