/**
 * GRAFT-19 AC6 — `/billing/success`, the page Stripe Checkout redirects to
 * on a completed session (`src/server/services/billing.ts`'s
 * `successUrl`). The actual tier transition happens asynchronously off the
 * `checkout.session.completed` webhook (`src/app/api/v1/webhooks/stripe`,
 * a protected path this issue only redirects to, never touches) — this page
 * is a confirmation, not a source of truth, so it deliberately doesn't poll
 * `/me` waiting for the upgrade to land.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export default function BillingSuccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>You&apos;re subscribed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Thanks — your payment went through. Your workspace will reflect the new plan
              within a few moments.
            </p>
          </CardContent>
          <CardFooter>
            <Button asChild className="w-full">
              <a href="/home">Go to your workspace</a>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
