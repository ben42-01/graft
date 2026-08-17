"use client";

/**
 * The user menu (AC1): identity from `/me` and sign-out. Built on `Sheet`,
 * not a dropdown-menu primitive — none shipped in GRAFT-11.1-11.3 and adding
 * one isn't this issue's scope.
 */
import { UserRoundIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function UserMenu({
  email,
  onLogOut,
}: {
  email: string;
  onLogOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();

  const handleLogOut = async () => {
    setSigningOut(true);
    try {
      await onLogOut();
      setOpen(false);
      router.replace("/login");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="Open user menu">
          <UserRoundIcon className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Account</SheetTitle>
          <SheetDescription>{email}</SheetDescription>
        </SheetHeader>
        <div className="mt-auto flex flex-col gap-2 p-4">
          <Button type="button" variant="outline" disabled={signingOut} onClick={handleLogOut}>
            {signingOut ? "Signing out..." : "Log out"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
