export function ownerUserIdentityPageData(
  claims: { sub: string },
  user: { status: string },
) {
  return {
    senderUserId: claims.sub,
    rawUserStatus: user.status,
  };
}
