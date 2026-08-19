/**
 * GRAFT-19 AC7 — `/billing/cancel`, the page Stripe Checkout redirects to
 * when the visitor abandons the session (`src/server/services/billing.ts`'s
 * `cancelUrl`). No tenant state changed — this is purely a landing page with
 * a way back to pricing.
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";

export default function BillingCancelPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            {/* A real heading element, not CardTitle (a plain div with no
             * implicit ARIA role) — this is the page's primary heading. */}
            <h1 className="leading-none font-semibold">Checkout canceled</h1>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No changes were made to your plan. You can pick up where you left off whenever
              you&apos;re ready.
            </p>
          </CardContent>
          <CardFooter>
            <Button asChild className="w-full">
              <Link href="/#pricing">Back to pricing</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
