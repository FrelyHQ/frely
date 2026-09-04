import { PageHeading } from "@frely/console-ui";
import { UserChat } from "../../../features/user-chat";
import type { UserChatPageData } from "./page.server";

export default function UserChatPage({ data }: { data: UserChatPageData }) {
  return (
    <>
      <PageHeading eyebrow="Use the API / Chat" title="Chat" description="Have a simple conversation through a user-visible AccessPoint." />
      <UserChat models={data.models} />
    </>
  );
}
