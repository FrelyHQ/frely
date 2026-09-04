/** @vitest-environment jsdom */

import { Button } from "@frely/ui/components/button";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleDialog as DialogUnderTest } from "./console-dialog.js";

afterEach(cleanup);

describe("ConsoleDialog focus lifecycle", () => {
  it("returns focus to its trigger after Escape closes a controlled dialog", async () => {
    const user = userEvent.setup();

    render(<ControlledDialog />);

    const trigger = screen.getByRole("button", { name: "Create Team" });
    await user.click(trigger);

    expect(screen.getByRole("dialog", { name: "Create Team" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create Team" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

function ControlledDialog() {
  const [open, setOpen] = useState(false);

  return (
    <DialogUnderTest
      observabilityKey="team-create-test"
      titleId="team-create-test-title"
      eyebrow="Create Team"
      title="Create Team"
      open={open}
      trigger={<Button type="button">Create Team</Button>}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
    >
      <p>Team form</p>
    </DialogUnderTest>
  );
}
