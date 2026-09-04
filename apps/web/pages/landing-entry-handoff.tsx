import { Button } from "@frely/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@frely/ui/components/card";

export function LandingEntryHandoff({ teamName, state, action }: { teamName: string; state: string; action: string }) {
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Continue to Frely</CardTitle>
        <CardDescription>Sign in or register on the canonical User Console to join {teamName}.</CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action={action}>
          <input type="hidden" name="state" value={state} />
          <Button type="submit" className="w-full">Continue</Button>
        </form>
      </CardContent>
    </Card>
  );
}
