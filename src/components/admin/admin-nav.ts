/**
 * The admin console's sections — one list, read by the sidebar, the mobile
 * sheet and the ⌘K palette, so the three can never disagree about what exists.
 */
import {
  BlocksIcon,
  CreditCardIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  ActivityIcon,
  TerminalSquareIcon,
  UsersIcon,
} from "lucide-react";

export type AdminNavItem = {
  href: string;
  label: string;
  icon: typeof BlocksIcon;
  description: string;
  /** `/admin` is exact; every other section also owns its sub-paths. */
  exact?: boolean;
};

export type AdminNavGroup = { label: string; items: AdminNavItem[] };

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        href: "/admin",
        label: "Dashboard",
        icon: LayoutDashboardIcon,
        description: "Platform health at a glance",
        exact: true,
      },
    ],
  },
  {
    label: "Customers",
    items: [
      {
        href: "/admin/tenants",
        label: "Accounts",
        icon: BlocksIcon,
        description: "Every tenant workspace, tier and limits",
      },
      {
        href: "/admin/subscriptions",
        label: "Subscriptions",
        icon: CreditCardIcon,
        description: "Billing state: paying, trial, grace, frozen",
      },
      {
        href: "/admin/users",
        label: "Users",
        icon: UsersIcon,
        description: "Every user account and its memberships",
      },
    ],
  },
  {
    label: "Product",
    items: [
      {
        href: "/admin/entities",
        label: "Entities",
        icon: DatabaseIcon,
        description: "What tenants have built, and how full it is",
      },
    ],
  },
  {
    label: "Monitoring",
    items: [
      {
        href: "/admin/activities",
        label: "Activity",
        icon: ActivityIcon,
        description: "Live activity monitor across all tenants",
      },
      {
        href: "/admin/audit",
        label: "Audit log",
        icon: ScrollTextIcon,
        description: "Every action taken from this console",
      },
    ],
  },
  {
    label: "Developer",
    items: [
      {
        href: "/admin/sdk",
        label: "API SDK",
        icon: TerminalSquareIcon,
        description: "Browse and run every API endpoint",
      },
    ],
  },
];

export const ADMIN_NAV_ITEMS: AdminNavItem[] = ADMIN_NAV.flatMap((group) => group.items);

export function isActive(item: AdminNavItem, pathname: string | null): boolean {
  if (!pathname) return false;
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
