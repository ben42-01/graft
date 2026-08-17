/** The authenticated home, replacing the dev status page. Dashboard widgets belong to GRAFT-13. */
export default function AppHomePage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your dashboards and widgets will appear here.
      </p>
    </div>
  );
}
