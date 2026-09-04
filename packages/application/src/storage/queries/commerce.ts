import type * as applicationModels from "../application-model-contracts.js";
import { normalizeDirectoryPage, normalizeDirectoryPageSize, type PageResult } from "./pagination.js";

export type ServiceProduct = applicationModels.ServiceProductsRow;

export interface ServiceProductDirectoryInput {
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface ServiceProductListingProjection {
  id: string;
  priceAmountUnits: number;
  paymentChannel: {
    id: string;
    displayName: string;
    paymentNetwork: string;
    paymentAsset: string;
    recipientIdentifierType: string;
    recipientIdentifierDisplay: string;
    paymentInstruction: string | null;
  };
}

export interface ServiceProductDirectoryRow {
  id: string;
  code: string;
  version: number;
  displayName: string;
  description: string | null;
  fulfillmentEffect: string;
  durationSeconds: number;
  listings: ServiceProductListingProjection[];
  listingTotal: number;
  listingHasMore: boolean;
}
