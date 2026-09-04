import type { IdentityQueries } from "@frely/identity/server";
import {
  CreditCursorError,
  creditUnitsToUsd,
  type AsyncApplicationOperationPort,
  type DirectoryPageSize,
  type ApplicationOperationPort,
} from "@frely/application/runtime";

export interface CreditAudienceListing {
  id: string;
  productName: string;
  creditedAmountUnits: number;
  priceAmountUnits: number;
  paymentAsset: string;
  channelId: string;
  channelName: string;
  settlementMode: string;
  recipientIdentifierDisplay: string;
  paymentInstruction: string | null;
  instructionAttachments: Array<{ id: string }>;
}

export interface CreditAudienceTopup {
  id: string;
  status: string;
  creditedAmountUnits: number;
  expectedPaymentAmountUnits: number;
  paymentAsset: string;
  paymentNetwork: string;
  transactionReferenceTail: string | null;
  expiresAt: string;
  attachmentCount: number;
  createdAt: string;
}

export interface CreditAudienceLedgerEvent {
  id: string;
  eventType: string;
  amount: string;
  reason: string;
  createdAt: string;
}

export interface UserCreditAudienceViewModel {
  audience: {
    userId: string;
    perspective: "self";
  };
  account: {
    id: string;
    scopeRef: string;
    status: string;
    balance: string;
    transferOutEnabled: boolean;
  };
  topups: {
    items: CreditAudienceTopup[];
    pageSize: DirectoryPageSize;
    nextCursor: string | null;
    hasMore: boolean;
    acceptedCursor: string;
  };
  ledger: {
    items: CreditAudienceLedgerEvent[];
    pageSize: DirectoryPageSize;
    nextCursor: string | null;
    hasMore: boolean;
    acceptedCursor: string;
  };
  catalog: {
    listings: CreditAudienceListing[];
    page: number;
    pageSize: DirectoryPageSize;
    total: number;
    totalPages: number;
  };
  capabilities: {
    canCreateTopup: true;
    canCancelOwnTopup: true;
  };
}

export type UserCreditAudienceAsyncApplicationOperationPort = Pick<AsyncApplicationOperationPort,
  | "cursorCreditLedger"
  | "cursorUserTopups"
  | "findCreditAccountForScope"
  | "isCreditTransferOutEnabled"
  | "pageUserCreditCatalog"
>;

export function loadUserCreditAudience(input: {
  repo: ApplicationOperationPort;
  identity: { getUser(userId: string): ReturnType<ApplicationOperationPort["getUser"]> };
  userId: string;
  topupCursor?: string;
  topupPageSize?: DirectoryPageSize;
  ledgerCursor?: string;
  ledgerPageSize?: DirectoryPageSize;
  catalogPage?: number;
  catalogPageSize?: DirectoryPageSize;
}): UserCreditAudienceViewModel | null {
  const { repo, identity, userId } = input;
  if (!identity.getUser(userId)) return null;
  const scopeRef = `user:${userId}` as const;
  const account = repo.findCreditAccountForScope(scopeRef);
  const topups = safeTopups(repo, userId, input.topupCursor, input.topupPageSize);
  const ledger = account
    ? safeLedger(repo, account.id, input.ledgerCursor, input.ledgerPageSize)
    : {
        page: { items: [], pageSize: input.ledgerPageSize ?? 20, nextCursor: null, hasMore: false },
        acceptedCursor: "",
      };
  const catalog = repo.pageUserCreditCatalog(input.catalogPage, input.catalogPageSize);

  return {
    audience: { userId, perspective: "self" },
    account: {
      id: account?.id ?? "No account",
      scopeRef,
      status: account?.status ?? "not_created",
      balance: formatCredit(account?.balanceSnapUnits ?? 0),
      transferOutEnabled: repo.isCreditTransferOutEnabled(scopeRef),
    },
    topups: {
      items: topups.page.items,
      pageSize: topups.page.pageSize,
      nextCursor: topups.page.nextCursor,
      hasMore: topups.page.hasMore,
      acceptedCursor: topups.acceptedCursor,
    },
    ledger: {
      items: ledger.page.items.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        amount: formatCredit(event.amountUnits),
        reason: event.reason ?? "No reason",
        createdAt: event.createdAt,
      })),
      pageSize: ledger.page.pageSize,
      nextCursor: ledger.page.nextCursor,
      hasMore: ledger.page.hasMore,
      acceptedCursor: ledger.acceptedCursor,
    },
    catalog: {
      listings: catalog.items.flatMap((product) => product.listings.map((listing) => ({
        id: listing.id,
        productName: product.displayName,
        creditedAmountUnits: product.creditedAmountUnits,
        priceAmountUnits: listing.priceAmountUnits,
        paymentAsset: listing.paymentChannel.paymentAsset,
        channelId: listing.paymentChannel.id,
        channelName: listing.paymentChannel.displayName,
        settlementMode: listing.paymentChannel.settlementMode,
        recipientIdentifierDisplay: listing.paymentChannel.recipientIdentifierDisplay,
        paymentInstruction: listing.paymentChannel.paymentInstruction,
        instructionAttachments: listing.paymentChannel.instructionAttachments.map((attachment) => ({ id: attachment.id })),
      }))),
      page: catalog.page,
      pageSize: catalog.pageSize,
      total: catalog.total,
      totalPages: catalog.totalPages,
    },
    capabilities: {
      canCreateTopup: true,
      canCancelOwnTopup: true,
    },
  };
}

export async function loadUserCreditAudienceAsync(input: {
  repo: UserCreditAudienceAsyncApplicationOperationPort;
  identity: Pick<IdentityQueries, "getUser">;
  userId: string;
  topupCursor?: string;
  topupPageSize?: DirectoryPageSize;
  ledgerCursor?: string;
  ledgerPageSize?: DirectoryPageSize;
  catalogPage?: number;
  catalogPageSize?: DirectoryPageSize;
}): Promise<UserCreditAudienceViewModel | null> {
  const { repo, identity, userId } = input;
  if (!(await identity.getUser(userId))) return null;
  const scopeRef = `user:${userId}` as const;
  const account = await repo.findCreditAccountForScope(scopeRef);
  const topups = await safeTopupsAsync(repo, userId, input.topupCursor, input.topupPageSize);
  const ledger = account
    ? await safeLedgerAsync(repo, account.id, input.ledgerCursor, input.ledgerPageSize)
    : {
        page: { items: [], pageSize: input.ledgerPageSize ?? 20, nextCursor: null, hasMore: false },
        acceptedCursor: "",
      };
  const catalog = await repo.pageUserCreditCatalog(input.catalogPage, input.catalogPageSize);
  const transferOutEnabled = await repo.isCreditTransferOutEnabled(scopeRef);

  return {
    audience: { userId, perspective: "self" },
    account: {
      id: account?.id ?? "No account",
      scopeRef,
      status: account?.status ?? "not_created",
      balance: formatCredit(account?.balanceSnapUnits ?? 0),
      transferOutEnabled,
    },
    topups: {
      items: topups.page.items,
      pageSize: topups.page.pageSize,
      nextCursor: topups.page.nextCursor,
      hasMore: topups.page.hasMore,
      acceptedCursor: topups.acceptedCursor,
    },
    ledger: {
      items: ledger.page.items.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        amount: formatCredit(event.amountUnits),
        reason: event.reason ?? "No reason",
        createdAt: event.createdAt,
      })),
      pageSize: ledger.page.pageSize,
      nextCursor: ledger.page.nextCursor,
      hasMore: ledger.page.hasMore,
      acceptedCursor: ledger.acceptedCursor,
    },
    catalog: {
      listings: catalog.items.flatMap((product) => product.listings.map((listing) => ({
        id: listing.id,
        productName: product.displayName,
        creditedAmountUnits: product.creditedAmountUnits,
        priceAmountUnits: listing.priceAmountUnits,
        paymentAsset: listing.paymentChannel.paymentAsset,
        channelId: listing.paymentChannel.id,
        channelName: listing.paymentChannel.displayName,
        settlementMode: listing.paymentChannel.settlementMode,
        recipientIdentifierDisplay: listing.paymentChannel.recipientIdentifierDisplay,
        paymentInstruction: listing.paymentChannel.paymentInstruction,
        instructionAttachments: listing.paymentChannel.instructionAttachments.map((attachment) => ({ id: attachment.id })),
      }))),
      page: catalog.page,
      pageSize: catalog.pageSize,
      total: catalog.total,
      totalPages: catalog.totalPages,
    },
    capabilities: {
      canCreateTopup: true,
      canCancelOwnTopup: true,
    },
  };
}

function safeTopups(repo: ApplicationOperationPort, userId: string, cursor: string | undefined, pageSize: DirectoryPageSize | undefined) {
  try {
    return {
      page: repo.cursorUserTopups(userId, cursor || undefined, pageSize),
      acceptedCursor: cursor ?? "",
    };
  } catch (error) {
    if (error instanceof CreditCursorError) {
      return { page: repo.cursorUserTopups(userId, undefined, pageSize), acceptedCursor: "" };
    }
    throw error;
  }
}

function safeLedger(repo: ApplicationOperationPort, accountId: string, cursor: string | undefined, pageSize: DirectoryPageSize | undefined) {
  try {
    return {
      page: repo.cursorCreditLedger(accountId, cursor || undefined, pageSize),
      acceptedCursor: cursor ?? "",
    };
  } catch (error) {
    if (error instanceof CreditCursorError) {
      return { page: repo.cursorCreditLedger(accountId, undefined, pageSize), acceptedCursor: "" };
    }
    throw error;
  }
}

async function safeTopupsAsync(repo: UserCreditAudienceAsyncApplicationOperationPort, userId: string, cursor: string | undefined, pageSize: DirectoryPageSize | undefined) {
  try {
    return {
      page: await repo.cursorUserTopups(userId, cursor || undefined, pageSize),
      acceptedCursor: cursor ?? "",
    };
  } catch (error) {
    if (error instanceof CreditCursorError) {
      return { page: await repo.cursorUserTopups(userId, undefined, pageSize), acceptedCursor: "" };
    }
    throw error;
  }
}

async function safeLedgerAsync(repo: UserCreditAudienceAsyncApplicationOperationPort, accountId: string, cursor: string | undefined, pageSize: DirectoryPageSize | undefined) {
  try {
    return {
      page: await repo.cursorCreditLedger(accountId, cursor || undefined, pageSize),
      acceptedCursor: cursor ?? "",
    };
  } catch (error) {
    if (error instanceof CreditCursorError) {
      return { page: await repo.cursorCreditLedger(accountId, undefined, pageSize), acceptedCursor: "" };
    }
    throw error;
  }
}

function formatCredit(units: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(creditUnitsToUsd(units));
}
