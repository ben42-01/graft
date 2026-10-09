import type { Metadata } from "next";
import { DeviceApproval } from "@/components/cli/device-approval";

export const metadata: Metadata = { title: "Sign in the Graft CLI" };

export default function DevicePage() {
  return <DeviceApproval />;
}
