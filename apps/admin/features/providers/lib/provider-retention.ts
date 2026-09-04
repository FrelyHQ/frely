export interface ProviderDeletionBlockers {
  hasAccessPointReferences: boolean;
  hasOnlineBillingHistory: boolean;
  credentialCleared?: boolean;
  providerDisabled?: boolean;
}

export function parseShowRetainedProviders(value: string | string[] | undefined): boolean {
  return (Array.isArray(value) ? value[0] : value) === "1";
}

export function providerDeletionBlockerMessage(state: ProviderDeletionBlockers): string | null {
  if (state.hasOnlineBillingHistory && state.hasAccessPointReferences) {
    return "This Provider is retained by online billing history and still has AccessPoints. Verified archival and AccessPoint removal are required before deletion.";
  }
  if (state.hasOnlineBillingHistory) {
    return "This Provider is retained by online billing history and cannot be deleted until verified archival removes those references.";
  }
  if (state.hasAccessPointReferences) return "Remove AccessPoints for this Provider before deleting.";
  if (state.providerDisabled === false) return "Disable this Provider before archiving and deleting it.";
  if (state.credentialCleared === false) return "Clear this Provider's CPA credential before archiving and deleting it.";
  return null;
}
