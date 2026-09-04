export type CardStatus = "available" | "used" | "expired" | "replaced" | "invalidated";
export type CardActionReasonCode =
  | "card_replaced"
  | "card_invalidated"
  | "card_used"
  | "card_expired"
  | "plan_closed"
  | "plan_disabled";

export interface UserCard {
  id: string;
  cardType: "plan" | "credit";
  issuanceType: "purchase" | "admin_grant" | "external_activation";
  ownerUserId: string;
  planId: string | null;
  planName: string | null;
  planVersion: number | null;
  planStatus: "enabled" | "closed" | "disabled" | null;
  creditProductId: string | null;
  creditProductName: string | null;
  creditAmountUnits: number | null;
  createdAt: string;
  usedAt: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  expiresAt: string;
  status: CardStatus;
  replacesCardId: string | null;
  replacedByCardId: string | null;
  canUse: boolean;
  canSend: boolean;
  useReasonCode: CardActionReasonCode | null;
  sendReasonCode: CardActionReasonCode | null;
}

export interface PlanCardInventoryItem {
  kind: "plan";
  planId: string;
  planName: string;
  planVersion: number;
  planStatus: "enabled" | "closed" | "disabled";
  totalCount: number;
  availableCount: number;
  replacedCount: number;
  invalidatedCount: number;
  usedCount: number;
  expiredCount: number;
  nearestAvailableExpiresAt: string | null;
  latestCreatedAt: string;
}

export interface CreditCardInventoryItem {
  kind: "credit";
  card: UserCard;
}

export type CardInventoryItem = PlanCardInventoryItem | CreditCardInventoryItem;

export interface CardTransfer {
  id: string;
  cardId: string;
  fromUserId: string;
  toUserId: string;
  referenceCode: string | null;
  note: string | null;
  createdAt: string;
}

export interface PageData<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CardInventoryData extends PageData<CardInventoryItem> {
  viewerUserId: string;
  canSetReferenceCode: boolean;
}

export type PlanCardDetailData = PageData<UserCard>;

export interface CardTransferData extends PageData<CardTransfer> {
  viewerUserId: string;
}

export type CardMutationInput =
  | { kind: "use"; cardId: string }
  | {
      kind: "send";
      cardId: string;
      toUserId: string;
      referenceCode?: string | null;
      note: string | null;
    };
