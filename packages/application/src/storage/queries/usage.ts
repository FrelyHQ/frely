import { normalizeDirectoryPage, normalizeDirectoryPageSize, type PageResult } from "./pagination.js";

export interface UsageLogRow {
  id: string;
  requestId: string;
  modelPriceId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calculatedCost: number;
  providerReportedCost: number;
  usageSource: string;
  createdAt: string;
}
