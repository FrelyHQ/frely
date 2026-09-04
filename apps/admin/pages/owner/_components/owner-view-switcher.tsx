"use client";

import { usePathname, useRouter, useSearchParams } from "@admin/navigation";
import type { AdminAudienceView } from "./owner-view";
import type { SearchSelectOption } from "./search-select";
import { SearchSelect } from "./search-select";

const VIEW_OPTIONS: Record<"team" | "user", Array<{ value: AdminAudienceView; label: string }>> = {
  team: [
    { value: "owner", label: "Platform Owner" },
    { value: "teamOwner", label: "Team Owner" },
    { value: "user", label: "Selected Team member" },
  ],
  user: [
    { value: "owner", label: "Platform Owner" },
    { value: "user", label: "Target user" },
  ],
};

export function AdminViewSwitcher({
  view,
  audience,
  memberId = "",
  memberOptions = [],
}: {
  view: AdminAudienceView;
  audience: "team" | "user";
  memberId?: string;
  memberOptions?: SearchSelectOption[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <div className="row-actions">
    <label className="admin-view-switcher">
      <span className="sr-only">View as</span>
      <SearchSelect ariaLabel="View as" value={view} options={VIEW_OPTIONS[audience]} searchable={false} onValueChange={(nextView) => setView(nextView as AdminAudienceView)} />
    </label>
    {audience === "team" && view === "user" ? (
      <label className="admin-view-switcher">
        <span className="sr-only">Preview member</span>
        <SearchSelect
          ariaLabel="Preview member"
          value={memberId}
          options={memberOptions}
          placeholder="Select a Team member"
          onValueChange={setMemberId}
        />
      </label>
    ) : null}
    </div>
  );

  function setView(nextView: AdminAudienceView) {
    const nextParams = new URLSearchParams(searchParams.toString());
    if (nextView === "owner") {
      nextParams.delete("view");
    } else {
      nextParams.set("view", nextView);
    }
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function setMemberId(nextMemberId: string) {
    const nextParams = new URLSearchParams(searchParams.toString());
    if (nextMemberId) nextParams.set("memberId", nextMemberId);
    else nextParams.delete("memberId");
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }
}
