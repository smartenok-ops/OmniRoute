const LOCAL_CAPACITY_CODES = new Set([
  "SEMAPHORE_TIMEOUT",
  "SEMAPHORE_QUEUE_FULL",
  "RATE_LIMIT_QUEUE_TIMEOUT",
]);

type CapacityFailure = {
  provider: string;
  errorType: string | null | undefined;
  errorCode: string | null | undefined;
  hasForcedConnection: boolean;
};

type ChatResult = {
  errorType?: string | null;
  errorCode?: string | null;
  error?: string | null;
  status?: number | null;
};

type CapacityRetryState = {
  error: string | null;
  status: number | null;
};

/** Request-scoped state for one emergency Codex overflow account. */
export class CodexLocalCapacityOverflow {
  private attempted = false;
  private primaryConnectionId: string | null = null;

  get isAlternateAttempt(): boolean {
    return this.primaryConnectionId !== null;
  }

  credentialSelectionOptions(excludedConnectionIds: Set<string>) {
    return {
      excludeConnectionIds: [
        ...excludedConnectionIds,
        ...(this.primaryConnectionId ? [this.primaryConnectionId] : []),
      ],
      ...(this.isAlternateAttempt ? { preserveSessionAffinity: true } : {}),
    };
  }

  shouldAttempt({ provider, errorType, errorCode, hasForcedConnection }: CapacityFailure): boolean {
    return (
      provider === "codex" &&
      errorType === "account_semaphore_capacity" &&
      LOCAL_CAPACITY_CODES.has(errorCode ?? "") &&
      !hasForcedConnection &&
      !this.attempted
    );
  }

  shouldAttemptResult(provider: string, result: ChatResult, hasForcedConnection: boolean): boolean {
    return this.shouldAttempt({
      provider,
      errorType: result.errorType,
      errorCode: result.errorCode,
      hasForcedConnection,
    });
  }

  begin(primaryConnectionId: string): void {
    this.attempted = true;
    this.primaryConnectionId = primaryConnectionId;
  }

  beginRetry(
    primaryConnectionId: string,
    failure: CapacityRetryState,
    excludedConnectionIds: Set<string>
  ): CapacityRetryState {
    this.begin(primaryConnectionId);
    excludedConnectionIds.add(primaryConnectionId);
    return failure;
  }

  beginResultRetry(
    primaryConnectionId: string,
    result: ChatResult,
    excludedConnectionIds: Set<string>
  ): CapacityRetryState {
    return this.beginRetry(
      primaryConnectionId,
      { error: result.error ?? null, status: result.status ?? null },
      excludedConnectionIds
    );
  }

  shouldSkipUpstreamRetry(configuredSkip: boolean): boolean {
    return this.isAlternateAttempt || configuredSkip;
  }
}
