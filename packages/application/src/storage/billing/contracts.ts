import type { AuditInput } from "@frely/audit";

export interface AccessPointPriceParts {
  inputPer1M: number;
  cachedInputPer1M: number;
  cacheWritePer1M?: number | null;
  outputPer1M: number;
}

export interface InitialAccessPointPriceInput extends AccessPointPriceParts {
  tiers?: InitialAccessPointPriceTierInput[];
}

export interface InitialAccessPointPriceTierInput extends AccessPointPriceParts {
  serviceTier?: string;
  tierKey?: string;
  minInputTokens: number;
  maxInputTokens?: number | null;
}

export interface ConfigureInitialAccessPointPriceCommand {
  price?: InitialAccessPointPriceInput | null;
}

export type BillingAuditInput = AuditInput;

export interface InitialAccessPointPriceResult {
  accessPointId: string;
  priceId: string;
  replayed: boolean;
}

export interface BillingCommands {
  configureInitialAccessPointPrice(
    id: string,
    command: ConfigureInitialAccessPointPriceCommand,
    audit: BillingAuditInput,
  ): Promise<InitialAccessPointPriceResult>;
}
