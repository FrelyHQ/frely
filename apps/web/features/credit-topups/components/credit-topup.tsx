"use client";

import React, { type ReactNode } from "react";
import { useRouter } from "@web/navigation";
import {
  CreditTopupExperience,
  type CreditTopupHistoryRow,
  type CreditTopupListing,
} from "@frely/console-ui/credit-topup";
import { createStripeCheckout, mutateCreditTopup } from "../api/credit-topup-api";

export function CreditTopup({
  listings,
  topups,
  nextHref,
  historyPagination,
}: {
  listings: CreditTopupListing[];
  topups: CreditTopupHistoryRow[];
  nextHref?: string;
  historyPagination?: ReactNode;
}) {
  const router = useRouter();
  return <CreditTopupExperience
    listings={listings}
    topups={topups}
    interactionMode="active"
    {...(historyPagination === undefined ? {} : { historyPagination })}
    {...(nextHref === undefined ? {} : { nextHref })}
    instructionAttachmentHref={(channelId, attachmentId) =>
      `/api/user/payment-channels/${encodeURIComponent(channelId)}/instruction-attachments/${encodeURIComponent(attachmentId)}`}
    actionPort={{
      mutateTopup: mutateCreditTopup,
      createStripeCheckout,
      openCheckout: (checkoutUrl) => window.location.assign(checkoutUrl),
      onChanged: () => router.refresh(),
    }}
  />;
}
